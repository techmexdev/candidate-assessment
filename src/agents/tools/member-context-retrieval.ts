import type {
  CopilotCitation,
  CopilotEvidenceAtom,
  CopilotScopeEnvelope,
} from "../../domain/contracts/copilot";
import { sameScope } from "../../domain/contracts/copilot";
import type {
  ChurnAssessmentEvidenceProjection,
  ChurnReasonEvidenceProjection,
  CitationProjection,
  CoachBriefProjection,
  ConversationProjection,
  LongitudinalPointProjection,
  MemberContextQueryResult,
  MemberContextReadHandle,
  MemberEvidenceProjection,
  MemberProfileEvidenceProjection,
  MessageProjection,
  WorkoutSessionEvidenceProjection,
} from "../../domain/contracts/member-context-queries";
import {
  resolveCopilotIntent,
  type CopilotIntentRecipe,
  type CopilotIntentSelection,
  type CopilotRetrievalStep,
} from "../../domain/policies/copilot-retrieval-plan";
import {
  calculateCalendarWindow,
  deriveBriefFreshness,
  deriveEvidenceAsOf,
  normalizeCitation,
  normalizeMemberEvidence,
} from "../../domain/policies/copilot-projections";

const genericUnavailable = "Member context is unavailable.";

export type CopilotRetrievedSources = {
  readonly evidence: readonly MemberEvidenceProjection[];
  readonly longitudinal: readonly LongitudinalPointProjection[];
  readonly relativeSequence: readonly LongitudinalPointProjection[];
  readonly conversations: readonly ConversationProjection[];
  readonly brief: CoachBriefProjection | null;
  readonly workouts: readonly WorkoutSessionEvidenceProjection[];
  readonly sourceChurnAssessment: ChurnAssessmentEvidenceProjection | null;
  readonly sourceChurnReasons: readonly ChurnReasonEvidenceProjection[];
};

export type CopilotRetrievalReady = CopilotScopeEnvelope & {
  readonly status: "ready";
  readonly intentId: CopilotIntentRecipe["intentId"];
  readonly registryVersion: CopilotIntentRecipe["registryVersion"];
  readonly recipe: CopilotIntentRecipe;
  readonly requestedFor: string;
  readonly evidenceAsOf: string;
  readonly memberTimezone: string;
  readonly briefFreshness: ReturnType<typeof deriveBriefFreshness> | null;
  readonly evidence: readonly CopilotEvidenceAtom[];
  readonly citations: readonly CopilotCitation[];
  readonly sources: CopilotRetrievedSources;
};

export type CopilotRetrievalResult =
  | CopilotRetrievalReady
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "unsupported" }
  | { readonly status: "denied"; readonly message: string }
  | { readonly status: "empty"; readonly message: string }
  | { readonly status: "insufficient-history"; readonly requiredPoints: number; readonly availablePoints: number }
  | { readonly status: "unavailable"; readonly message: string };

export type MemberContextRetrievalDependencies = {
  readonly reauthorize: (input: Readonly<{
    coachId: string;
    memberId: string;
    contextRevisionId: string;
    stepId: string;
  }>) => boolean | Promise<boolean>;
};

export type MemberContextRetrievalRequest = {
  readonly selection: CopilotIntentSelection;
  readonly requestedFor: string;
  readonly handle: MemberContextReadHandle;
  readonly signal?: AbortSignal;
};

function isClientDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`));
}

function distinctEvidence(values: readonly (MemberEvidenceProjection | MessageProjection)[]) {
  return [...new Map(values.map((value) => [value.evidenceId, value])).values()];
}

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function createMemberContextRetrieval(dependencies: MemberContextRetrievalDependencies) {
  return Object.freeze({
    async retrieve(request: Readonly<MemberContextRetrievalRequest>): Promise<CopilotRetrievalResult> {
      if (request.signal?.aborted) return { status: "unavailable", message: genericUnavailable };
      const resolution = resolveCopilotIntent(request.selection);
      if (resolution.status !== "resolved") return resolution;
      if (!isClientDate(request.requestedFor)) return { status: "invalid", message: "Requested day is invalid." };
      const { handle } = request;
      const scope: CopilotScopeEnvelope = {
        memberId: handle.memberId,
        contextRevisionId: handle.contextRevisionId,
        authority: handle.authority,
      };
      const evidence: (MemberEvidenceProjection | MessageProjection)[] = [];
      const longitudinal: LongitudinalPointProjection[] = [];
      const relativeSequence: LongitudinalPointProjection[] = [];
      const conversations: ConversationProjection[] = [];
      let brief: CoachBriefProjection | null = null;
      let timezone: string | undefined;
      let evidenceAsOf: string | undefined;
      let citations: CopilotCitation[] = [];
      let readCount = 0;
      const evidenceLimit = resolution.recipe.steps.find((step) => step.operation === "citations")?.limit;
      if (evidenceLimit === undefined) return { status: "invalid", message: "Retrieval plan has no citation budget." };

      const run = async <T>(step: CopilotRetrievalStep, operation: () => Promise<MemberContextQueryResult<T>>) => {
        if (request.signal?.aborted) return { status: "aborted" } as const;
        if (readCount >= resolution.recipe.readBudget) return { status: "invalid-budget" } as const;
        const allowed = await dependencies.reauthorize({
          coachId: handle.coachId,
          memberId: handle.memberId,
          contextRevisionId: handle.contextRevisionId,
          stepId: step.stepId,
        });
        if (request.signal?.aborted) return { status: "aborted" } as const;
        if (!allowed) return { status: "revoked" } as const;
        readCount += 1;
        const result = await operation();
        if (request.signal?.aborted) return { status: "aborted" } as const;
        if (!sameScope(handle, result)) return { status: "scope-mismatch" } as const;
        return { status: "result", result } as const;
      };

      for (const step of resolution.recipe.steps) {
        let invoked;
        if (step.operation === "evidence") {
          invoked = await run(step, () => handle.getEvidence({
            domains: step.domains,
            evidenceKinds: step.evidenceKinds,
            limit: step.limit,
            timeoutMs: resolution.recipe.timeoutMs,
            ...(request.signal ? { signal: request.signal } : {}),
          }));
        } else if (step.operation === "longitudinal-series") {
          if (!timezone || !evidenceAsOf) {
            return { status: "invalid", message: "Calendar retrieval requires an authoritative evidence anchor." };
          }
          const calendarTimezone = timezone;
          const calendarEvidenceAsOf = evidenceAsOf;
          invoked = await run(step, () => handle.getLongitudinalSeries({
            metric: step.metric,
            window: calculateCalendarWindow({ evidenceAsOf: calendarEvidenceAsOf, timezone: calendarTimezone, lookbackDays: step.lookbackDays }),
            minimumPoints: step.minimumPoints,
            limit: step.limit,
            timeoutMs: resolution.recipe.timeoutMs,
            ...(request.signal ? { signal: request.signal } : {}),
          }));
        } else if (step.operation === "relative-sequence") {
          invoked = handle.getRelativeOrderSequence
            ? await run(step, () => handle.getRelativeOrderSequence!({
              metric: step.metric,
              minimumPoints: step.minimumPoints,
              limit: step.limit,
              timeoutMs: resolution.recipe.timeoutMs,
              ...(request.signal ? { signal: request.signal } : {}),
            }))
            : await run(step, () => handle.getEvidence({
              domains: [step.domain],
              limit: step.limit,
              timeoutMs: resolution.recipe.timeoutMs,
              ...(request.signal ? { signal: request.signal } : {}),
            }));
        } else if (step.operation === "conversation") {
          if (!timezone || !evidenceAsOf) {
            return { status: "invalid", message: "Conversation retrieval requires an authoritative evidence anchor." };
          }
          const calendarTimezone = timezone;
          const calendarEvidenceAsOf = evidenceAsOf;
          invoked = await run(step, () => handle.getConversation({
            window: calculateCalendarWindow({ evidenceAsOf: calendarEvidenceAsOf, timezone: calendarTimezone, lookbackDays: step.lookbackDays }),
            limit: step.limit,
            timeoutMs: resolution.recipe.timeoutMs,
            ...(request.signal ? { signal: request.signal } : {}),
          }));
        } else if (step.operation === "coach-brief") {
          invoked = await run(step, () => handle.getCoachBrief({
            limit: step.limit,
            timeoutMs: resolution.recipe.timeoutMs,
            ...(request.signal ? { signal: request.signal } : {}),
          }));
        } else {
          const items = distinctEvidence(evidence);
          const ids = items.map((item) => item.evidenceId);
          if (ids.length > step.limit) {
            return { status: "invalid", message: "Retrieval evidence exceeds the citation budget." };
          }
          if (ids.length === 0) {
            return { status: "unavailable", message: genericUnavailable };
          }
          invoked = await run(step, () => handle.getCitations({
            evidenceIds: ids,
            limit: step.limit,
            timeoutMs: resolution.recipe.timeoutMs,
            ...(request.signal ? { signal: request.signal } : {}),
          }));
        }

        if (invoked.status === "aborted") return { status: "unavailable", message: genericUnavailable };
        if (invoked.status === "revoked") return { status: "denied", message: genericUnavailable };
        if (invoked.status !== "result") return { status: "unavailable", message: genericUnavailable };
        const result = invoked.result;
        if (result.status === "denied") return { status: "denied", message: genericUnavailable };
        if (result.status === "unavailable" || result.status === "stale") return { status: "unavailable", message: genericUnavailable };
        if (result.status === "invalid") return { status: "invalid", message: "Retrieval plan failed validation." };
        if (result.status === "insufficient-history") {
          return { status: "insufficient-history", requiredPoints: result.requiredPoints, availablePoints: result.availablePoints };
        }
        if (result.status === "empty") {
          if (["conversation", "evidence"].includes(step.operation) && step.stepId !== "profile") continue;
          return { status: "empty", message: "No supported evidence is available." };
        }

        if (step.operation === "evidence") {
          const data = result.data as readonly MemberEvidenceProjection[];
          const selected = data.filter((item) => step.evidenceKinds.includes(item.kind));
          evidence.push(...selected);
          const profile = selected.find((item): item is MemberProfileEvidenceProjection => item.kind === "member-profile");
          if (step.stepId === "profile" && !profile) return { status: "empty", message: "No supported evidence is available." };
          timezone ??= profile?.timezone;
          if (step.stepId === "profile") {
            if (!timezone || !result.authoritativeEvidenceAnchor) {
              return { status: "invalid", message: "Member context has no authoritative evidence anchor." };
            }
            try {
              evidenceAsOf = deriveEvidenceAsOf([result.authoritativeEvidenceAnchor], timezone);
            } catch {
              return { status: "invalid", message: "Member context evidence anchor is invalid." };
            }
          }
        } else if (step.operation === "longitudinal-series") {
          const data = result.data as readonly LongitudinalPointProjection[];
          longitudinal.push(...data);
          evidence.push(...data);
        } else if (step.operation === "relative-sequence") {
          const values = ("data" in result ? result.data : []) as readonly MemberEvidenceProjection[];
          const selected = values.filter((item): item is LongitudinalPointProjection => (
            item.kind === "observation"
            && item.metric === step.metric
            && item.temporal.precision === "relative-order"
          ));
          if (selected.length < step.minimumPoints) {
            return { status: "insufficient-history", requiredPoints: step.minimumPoints, availablePoints: selected.length };
          }
          relativeSequence.push(...selected.slice(0, step.limit));
          evidence.push(...selected.slice(0, step.limit));
        } else if (step.operation === "conversation") {
          const data = result.data as ConversationProjection;
          const existingIds = new Set(distinctEvidence(evidence).map((item) => item.evidenceId));
          const messageIds = new Set(data.messages.map((message) => message.evidenceId));
          const evidenceAfterMessages = new Set([...existingIds, ...messageIds]);
          if (evidenceAfterMessages.size > evidenceLimit) {
            return { status: "invalid", message: "Retrieval evidence exceeds the citation budget." };
          }
          let remainingAttachments = evidenceLimit - evidenceAfterMessages.size;
          const retainedAttachmentIds = new Set<string>();
          const boundedMessages = data.messages.map((message): MessageProjection => {
            const attachments = message.attachments.filter((attachment) => {
              if (existingIds.has(attachment.evidenceId) || messageIds.has(attachment.evidenceId) || retainedAttachmentIds.has(attachment.evidenceId)) {
                return true;
              }
              if (remainingAttachments === 0) return false;
              remainingAttachments -= 1;
              retainedAttachmentIds.add(attachment.evidenceId);
              return true;
            });
            return {
              ...message,
              attachmentEvidenceIds: attachments.map((attachment) => attachment.evidenceId),
              attachments,
            };
          });
          conversations.push({ ...data, messages: boundedMessages });
          evidence.push(...boundedMessages, ...boundedMessages.flatMap((message) => message.attachments));
        } else if (step.operation === "coach-brief") {
          const data = result.data as CoachBriefProjection;
          brief = data;
          evidence.push(data.brief, ...data.tasks, ...(data.assessment ? [data.assessment] : []));
        } else {
          const byId = new Map(distinctEvidence(evidence).map((item) => [item.evidenceId, item]));
          citations = (result.data as readonly CitationProjection[]).map((citation) => {
            const item = byId.get(citation.evidenceId);
            if (!item) throw new Error("Citation escaped the bounded retrieval evidence set.");
            return normalizeCitation(scope, citation, item);
          });
          const citedIds = new Set(citations.map((citation) => citation.evidenceId));
          if (citedIds.size !== byId.size || [...byId.keys()].some((id) => !citedIds.has(id))) {
            return { status: "invalid", message: "Retrieval citations do not match the bounded evidence set." };
          }
        }
      }

      if (readCount !== resolution.recipe.readBudget || !timezone || !evidenceAsOf) {
        return { status: "unavailable", message: genericUnavailable };
      }
      const items = distinctEvidence(evidence);
      const atoms = items.map((item) => normalizeMemberEvidence(scope, item));
      const freshness = brief ? deriveBriefFreshness(request.requestedFor, brief.brief.generatedFor) : null;
      const ready: CopilotRetrievalReady = {
        status: "ready",
        ...scope,
        intentId: resolution.intentId,
        registryVersion: resolution.recipe.registryVersion,
        recipe: resolution.recipe,
        requestedFor: request.requestedFor,
        evidenceAsOf,
        memberTimezone: timezone,
        briefFreshness: freshness,
        evidence: atoms,
        citations,
        sources: {
          evidence: items.filter((item): item is MemberEvidenceProjection => item.kind !== "message"),
          longitudinal,
          relativeSequence,
          conversations,
          brief,
          workouts: items.filter((item): item is WorkoutSessionEvidenceProjection => item.kind === "workout-session"),
          sourceChurnAssessment: items.find((item): item is ChurnAssessmentEvidenceProjection => item.kind === "churn-assessment") ?? null,
          sourceChurnReasons: items.filter((item): item is ChurnReasonEvidenceProjection => item.kind === "churn-reason"),
        },
      };
      return deepFreeze(ready) as CopilotRetrievalReady;
    },
  });
}
