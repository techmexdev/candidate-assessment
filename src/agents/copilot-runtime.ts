import type { CopilotModel } from "../application/ports/copilot-model";
import type { CopilotRuntime, CopilotRuntimeRequest } from "../application/ports/copilot-runtime";
import {
  COPILOT_QUICK_PROMPT_IDS,
  COPILOT_MORNING_TASK_ACTION_IDS,
  createCopilotAnswerPacket,
  type CopilotActionId,
  type CopilotAnswerClause,
  type CopilotAnswerPacket,
  type CopilotAnswerSection,
  type CopilotContinuationClaims,
  type CopilotFactEvidenceAtom,
  type CopilotMorningTask,
  type CopilotOutcome,
  type CopilotSectionId,
  type SignedCopilotContinuation,
} from "../domain/contracts/copilot";
import type { CoachTaskEvidenceProjection, MemberEvidenceProjection, MessageProjection, ObservationEvidenceProjection } from "../domain/contracts/member-context-queries";
import { deriveChurnRisk } from "../domain/policies/churn-risk";
import {
  resolveCopilotIntent,
  type CopilotIntentSelection,
} from "../domain/policies/copilot-retrieval-plan";
import { createCopilotChart } from "../domain/policies/copilot-projections";
import { createCopilotIntentModelInput } from "./copilot-prompt";
import type { CopilotRetrievalResult, MemberContextRetrievalRequest } from "./tools/member-context-retrieval";
import { validateCopilotAnswer } from "./validation/copilot-answer";

export type CopilotRuntimeDependencies = {
  readonly model: CopilotModel;
  readonly retrieve: (request: Readonly<MemberContextRetrievalRequest>) => Promise<CopilotRetrievalResult>;
  readonly signContinuation: (claims: Readonly<CopilotContinuationClaims>) => Promise<SignedCopilotContinuation>;
  readonly now?: () => string;
  readonly createId?: (kind: "answer" | "clause" | "chart") => string;
  readonly deadlineMs?: number;
  readonly continuationTtlMs?: number;
};

type StageResult<Value> =
  | { readonly status: "ready"; readonly value: Value }
  | { readonly status: "aborted" }
  | { readonly status: "failed" };

async function waitForStage<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<StageResult<Value>> {
  if (signal.aborted) return { status: "aborted" };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: StageResult<Value>) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ status: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => finish({ status: "ready", value }), () => finish({ status: "failed" }));
  });
}

function projectionText(projection: MemberEvidenceProjection | MessageProjection): string {
  switch (projection.kind) {
    case "observation": return `${projection.metric}: ${String(projection.value)} ${projection.unit}.`;
    case "message": return "senderRole" in projection && "text" in projection
      ? `${projection.senderRole === "member" ? "Member" : "Coach"} message: “${projection.text}”`
      : "Recorded conversation evidence.";
    case "workout-session": return `${projection.title}: ${projection.completed ? "completed" : "not completed"}.`;
    case "preference": return `Preferred session length: ${projection.preferredSessionMinutes} minutes.`;
    case "goal": return `Goal: ${projection.text}`;
    case "coach-brief": return `Latest recorded brief is dated ${projection.generatedFor}.`;
    case "coach-task": return `Coach task: ${projection.text}`;
    case "churn-assessment": return `Source-provided churn level: ${projection.level}.`;
    case "churn-reason": return projection.basisStatus === "supported"
      ? `Source-provided supported risk reason: ${projection.text}`
      : "A source-provided risk reason is excluded because its basis is unsupported.";
    case "member-profile": return `Member timezone: ${projection.timezone}.`;
    case "media-attachment": return `Attachment metadata: ${projection.caption} (${projection.mediaType}); content not analyzed.`;
    default: return `Recorded ${projection.kind} evidence.`;
  }
}

const actionText: Readonly<Record<CopilotActionId, string>> = {
  "review-with-member": "Review these recorded facts with the member.",
  "celebrate-progress": "Celebrate the supported progress with the member.",
  "review-adherence": "Review the recorded adherence pattern with the member.",
  "review-sleep": "Review the recorded sleep pattern with the member.",
  "review-churn-risk": "Review the supported churn signals with the member.",
};

function materialEvidenceIds(packet: Pick<CopilotAnswerPacket, "sections" | "tasks" | "chart" | "churn">): string[] {
  return [...new Set([
    ...packet.sections.flatMap((section) => section.clauses.flatMap((clause) => clause.evidenceIds)),
    ...packet.tasks.flatMap((task) => task.evidenceIds),
    ...(packet.chart?.points.flatMap((point) => point.evidenceIds) ?? []),
    ...(packet.churn?.derived.evidenceIds ?? []),
    ...(packet.churn?.derived.reasons.flatMap((reason) => reason.evidenceIds) ?? []),
    ...(packet.churn?.derived.excludedSourceReasons.flatMap((reason) => reason.evidenceIds) ?? []),
    ...(packet.churn?.source?.evidenceIds ?? []),
    ...(packet.churn?.source?.reasons.flatMap((reason) => reason.evidenceIds) ?? []),
  ])].sort();
}

function mapRetrievalFailure(requestId: string, result: Exclude<CopilotRetrievalResult, { readonly status: "ready" }>): CopilotOutcome {
  switch (result.status) {
    case "invalid": return { status: "invalid", requestId, code: "invalid-retrieval", message: result.message };
    case "unsupported": return { status: "unsupported", requestId, supportedPromptIds: COPILOT_QUICK_PROMPT_IDS, message: "This question is outside the supported Copilot intents." };
    case "denied": return { status: "denied", requestId, message: result.message };
    case "empty": return { status: "empty", requestId, message: result.message };
    case "insufficient-history": return { status: "insufficient-history", requestId, requiredPoints: result.requiredPoints, availablePoints: result.availablePoints, message: "There is not enough recorded history for this answer." };
    case "unavailable": return { status: "unavailable", requestId, code: "graph-unavailable", retryable: true, message: "Member context is temporarily unavailable." };
  }
}

export function createCopilotRuntime(dependencies: CopilotRuntimeDependencies): CopilotRuntime {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const createId = dependencies.createId ?? ((kind) => `${kind}:${crypto.randomUUID()}`);
  const deadlineMs = dependencies.deadlineMs ?? 5_000;
  const continuationTtlMs = dependencies.continuationTtlMs ?? 15 * 60 * 1_000;

  return Object.freeze({
    async answer(
      request: Readonly<CopilotRuntimeRequest>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<CopilotOutcome> {
      const deadline = AbortSignal.timeout(deadlineMs);
      const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      const cancelled = () => options?.signal?.aborted === true;
      if (signal.aborted) return { status: "cancelled", requestId: request.requestId };

      let selection: CopilotIntentSelection;
      if (request.input.kind === "quick-prompt") {
        selection = { kind: "quick-prompt", promptId: request.input.promptId };
      } else {
        const alias = resolveCopilotIntent({ kind: "exact-alias", text: request.input.question });
        if (alias.status === "invalid") {
          return { status: "invalid", requestId: request.requestId, code: "invalid-question", message: alias.message };
        }
        if (alias.status === "resolved") {
          selection = { kind: "exact-alias", text: request.input.question };
        } else {
          const modelStage = await waitForStage(dependencies.model.select(
            createCopilotIntentModelInput(request.input.question, COPILOT_QUICK_PROMPT_IDS),
            { signal },
          ), signal);
          if (modelStage.status === "aborted") {
            return cancelled()
              ? { status: "cancelled", requestId: request.requestId }
              : { status: "model-error", requestId: request.requestId, code: "provider-timeout", retryable: true, message: "Copilot intent selection timed out." };
          }
          if (modelStage.status === "failed") {
            return { status: "model-error", requestId: request.requestId, code: "provider-unavailable", retryable: true, message: "Copilot intent selection is temporarily unavailable." };
          }
          const modelResult = modelStage.value;
          if (modelResult.status === "failed") {
            const timedOut = modelResult.reason === "timeout";
            return {
              status: "model-error",
              requestId: request.requestId,
              code: timedOut ? "provider-timeout" : modelResult.reason === "invalid-structured-output" ? "malformed-selection" : "provider-unavailable",
              retryable: true,
              message: timedOut ? "Copilot intent selection timed out." : "Copilot intent selection is temporarily unavailable.",
            };
          }
          if (modelResult.candidate.selections.length !== 0) {
            return { status: "model-error", requestId: request.requestId, code: "grounding-rejected", retryable: true, message: "Copilot selection failed grounding validation." };
          }
          selection = { kind: "model-classified", question: request.input.question, intentId: modelResult.candidate.intentId };
        }
      }

      const retrievalStage = await waitForStage(dependencies.retrieve({
        selection,
        requestedFor: request.requestedFor,
        handle: request.memberContext,
        signal,
      }), signal);
      if (retrievalStage.status === "aborted") {
        return cancelled()
          ? { status: "cancelled", requestId: request.requestId }
          : { status: "unavailable", requestId: request.requestId, code: "graph-timeout", retryable: true, message: "Member context retrieval timed out." };
      }
      if (retrievalStage.status === "failed") {
        return { status: "unavailable", requestId: request.requestId, code: "graph-unavailable", retryable: true, message: "Member context is temporarily unavailable." };
      }
      const retrieved = retrievalStage.value;
      if (retrieved.status !== "ready") return mapRetrievalFailure(request.requestId, retrieved);
      if (signal.aborted) return cancelled()
        ? { status: "cancelled", requestId: request.requestId }
        : { status: "unavailable", requestId: request.requestId, code: "graph-timeout", retryable: true, message: "Member context retrieval timed out." };

      const projections = new Map<string, MemberEvidenceProjection | MessageProjection>();
      for (const item of retrieved.sources.evidence) projections.set(item.evidenceId, item);
      for (const conversation of retrieved.sources.conversations) {
        for (const message of conversation.messages) projections.set(message.evidenceId, message);
      }
      const atoms = new Map(retrieved.evidence.map((atom) => [atom.evidenceId, atom]));
      const sections: CopilotAnswerSection[] = [];
      for (const [sectionId, kinds] of Object.entries(retrieved.recipe.sectionEvidenceKinds) as [CopilotSectionId, readonly string[]][]) {
        const clauses: CopilotAnswerClause[] = retrieved.evidence
          .filter((atom) => kinds.includes(atom.evidenceKind) && projections.has(atom.evidenceId))
          .map((atom) => ({
            clauseId: createId("clause"),
            text: projectionText(projections.get(atom.evidenceId)!),
            evidenceIds: [atom.evidenceId],
          }));
        if (clauses.length > 0) sections.push({ sectionId, clauses });
      }
      const firstMaterial = sections[0]?.clauses[0]?.evidenceIds[0];
      const actionId = retrieved.recipe.actionIds[0];
      if (firstMaterial && actionId) {
        sections.push({ sectionId: "next-action", clauses: [{ clauseId: createId("clause"), text: actionText[actionId], evidenceIds: [firstMaterial] }] });
      }
      if (sections.length === 0) {
        return { status: "empty", requestId: request.requestId, message: "No supported evidence is available for this answer." };
      }

      const tasks: CopilotMorningTask[] = retrieved.intentId === "morning-brief"
        ? retrieved.sources.evidence
          .filter((projection): projection is CoachTaskEvidenceProjection => projection.kind === "coach-task")
          .sort((left, right) => left.sourceOrder - right.sourceOrder)
          .flatMap((projection) => {
            if (projection.taskType !== "celebrate" && projection.taskType !== "review_risk") return [];
            return [{
              taskId: `task:${projection.taskType}:${projection.evidenceId}`,
              taskType: projection.taskType,
              actionId: COPILOT_MORNING_TASK_ACTION_IDS[projection.taskType],
              text: projection.text,
              evidenceIds: [projection.evidenceId],
              sourceOrder: projection.sourceOrder,
            }];
          })
        : [];

      let chart: CopilotAnswerPacket["chart"] = null;
      if (retrieved.recipe.chart) {
        const chartSources = retrieved.recipe.chart.temporalMode === "calendar"
          ? retrieved.sources.longitudinal
          : retrieved.sources.relativeSequence;
        const chartResult = createCopilotChart({
          scope: retrieved,
          chartId: createId("chart"),
          recipeId: retrieved.recipe.chart.recipeId,
          type: retrieved.recipe.chart.type,
          temporalMode: retrieved.recipe.chart.temporalMode,
          minimumPoints: retrieved.recipe.chart.minimumPoints,
          atoms: chartSources
            .filter((item) => item.metric === retrieved.recipe.chart!.metric)
            .map((item) => atoms.get(item.evidenceId))
            .filter((atom): atom is CopilotFactEvidenceAtom => atom?.atomKind === "fact"),
        });
        if (chartResult.status === "ready") chart = chartResult.chart;
      }

      const includeChurn = retrieved.intentId === "churn-risk" || retrieved.intentId === "morning-brief";
      const adherence = retrieved.intentId === "morning-brief"
        ? retrieved.sources.evidence.filter((item): item is ObservationEvidenceProjection => item.kind === "observation")
        : retrieved.sources.longitudinal;
      const churn = includeChurn ? deriveChurnRisk({
        scope: retrieved,
        evidenceAsOf: retrieved.evidenceAsOf,
        adherence,
        workouts: retrieved.sources.workouts,
        messages: retrieved.sources.conversations.flatMap((conversation) => conversation.messages),
        sourceAssessment: retrieved.sources.sourceChurnAssessment,
        sourceReasons: retrieved.sources.sourceChurnReasons,
      }) : null;
      const partial = { sections, tasks, chart, churn };
      const selectedEvidenceIds = materialEvidenceIds(partial);
      const issuedAt = now();
      const claims: CopilotContinuationClaims = {
        schemaVersion: "copilot-continuation-claims/v1",
        coachId: request.memberContext.coachId,
        memberId: retrieved.memberId,
        contextRevisionId: retrieved.contextRevisionId,
        answerId: createId("answer"),
        intentId: retrieved.intentId,
        selectedEvidenceIds,
        issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + continuationTtlMs).toISOString(),
      };
      const continuationStage = await waitForStage(dependencies.signContinuation(claims), signal);
      if (continuationStage.status === "aborted") return { status: "cancelled", requestId: request.requestId };
      if (continuationStage.status === "failed") {
        return { status: "model-error", requestId: request.requestId, code: "grounding-rejected", retryable: true, message: "Copilot answer failed grounding validation." };
      }
      const packet: CopilotAnswerPacket = {
        schemaVersion: "copilot-answer/v1",
        requestId: request.requestId,
        answerId: claims.answerId,
        intentId: retrieved.intentId,
        requestedFor: retrieved.requestedFor,
        evidenceAsOf: retrieved.evidenceAsOf,
        memberTimezone: retrieved.memberTimezone,
        briefFreshness: retrieved.briefFreshness,
        memberId: retrieved.memberId,
        contextRevisionId: retrieved.contextRevisionId,
        authority: retrieved.authority,
        evidence: { memberId: retrieved.memberId, contextRevisionId: retrieved.contextRevisionId, authority: retrieved.authority, atoms: retrieved.evidence },
        sections,
        tasks,
        chart,
        citations: retrieved.citations.filter((citation) => selectedEvidenceIds.includes(citation.evidenceId)),
        churn,
        continuation: continuationStage.value,
      };
      const sourceMessages = new Map(retrieved.sources.conversations.flatMap((conversation) => conversation.messages.map((message) => [message.evidenceId, {
        senderRole: message.senderRole,
        text: message.text,
      }] as const)));
      const validation = validateCopilotAnswer(packet, retrieved.recipe, { sourceMessages });
      if (validation.status === "rejected") {
        return { status: "model-error", requestId: request.requestId, code: "grounding-rejected", retryable: true, message: "Copilot answer failed grounding validation." };
      }
      try {
        return { status: "ready", requestId: request.requestId, answer: createCopilotAnswerPacket(packet) };
      } catch {
        return { status: "model-error", requestId: request.requestId, code: "grounding-rejected", retryable: true, message: "Copilot answer failed grounding validation." };
      }
    },
  });
}
