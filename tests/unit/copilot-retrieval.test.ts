import { describe, expect, it, vi } from "vitest";
import jordan from "../../data/member-context.json";
import type {
  AuthoritativeEvidenceAnchorProjection,
  ConversationProjection,
  MemberContextQueryResult,
  MemberContextReadHandle,
  MemberEvidenceProjection,
  MessageProjection,
} from "../../src/domain/contracts/member-context-queries";
import {
  COPILOT_INTENT_REGISTRY,
  resolveCopilotIntent,
  validateCopilotEvidenceSelections,
} from "../../src/domain/policies/copilot-retrieval-plan";
import { createMemberContextRetrieval } from "../../src/agents/tools/member-context-retrieval";
import { createRetrieveMemberContext } from "../../src/application/use-cases/retrieve-member-context";
import { compileMemberContextGraph } from "../../src/graph/ingest/member-context";
import { InMemoryMemberContextPublisher } from "../../src/graph/publication/in-memory-member-context-publisher";
import { canonicalMemberContextDigest } from "../../src/graph/revisions/member-context";
import { InMemoryMemberContextReadProvider } from "../../src/graph/repositories/member-context";

const scope = {
  memberId: "mbr_jordan",
  contextRevisionId: "member-context:sha256:r1",
  authority: "canonical",
} as const;

const base = {
  evidenceId: "assertion:1111111111111111",
  semanticId: "member-profile:mbr_jordan",
  assertionId: "assertion:1111111111111111",
  source: { locator: "/profile", artifactDigest: "sha256:source" },
  classification: "identity",
  temporal: { precision: "date", effectiveOn: "2026-06-04" },
} as const;

const authoritativeEvidenceAnchor: AuthoritativeEvidenceAnchorProjection = {
  evidenceId: "assertion:anchor00000000",
  temporal: { precision: "date", effectiveOn: "2026-06-04" },
};

function ready<T>(
  data: T,
  evidenceIds: readonly string[],
  anchor: AuthoritativeEvidenceAnchorProjection | null = authoritativeEvidenceAnchor,
): MemberContextQueryResult<T> {
  return { status: "ready", ...scope, data, evidenceIds, authoritativeEvidenceAnchor: anchor };
}

function fakeHandle(anchor: AuthoritativeEvidenceAnchorProjection | null = authoritativeEvidenceAnchor) {
  const evidence: MemberEvidenceProjection[] = [{
    ...base,
    kind: "member-profile",
    timezone: "America/Los_Angeles",
  }];
  const sleep = [0, 1].map((sourceOrder) => ({
    ...base,
    evidenceId: `assertion:${String(sourceOrder + 2).repeat(16)}`,
    assertionId: `assertion:${String(sourceOrder + 2).repeat(16)}`,
    semanticId: `sleep:${sourceOrder}`,
    kind: "observation" as const,
    classification: "observation" as const,
    temporal: { precision: "relative-order" as const, sourceOrder },
    metric: "sleep-hours",
    value: 6 + sourceOrder,
    unit: "hour",
    sourceOrder,
  }));
  const handle: MemberContextReadHandle = {
    ...scope,
    coachId: "coach_casey",
    getSummary: vi.fn(),
    getEvidence: vi.fn(async () => ready(evidence, [base.evidenceId], anchor)),
    getLongitudinalSeries: vi.fn(async () => ready([], [])),
    getRelativeOrderSequence: vi.fn(async () => ready(sleep, sleep.map((point) => point.evidenceId))),
    getConversation: vi.fn(async () => ({ status: "empty" as const, ...scope, evidenceIds: [], message: "none" })),
    getCoachBrief: vi.fn(async () => ({ status: "empty" as const, ...scope, evidenceIds: [], message: "none" })),
    getWorkoutConstraints: vi.fn(),
    getRelatedEvidence: vi.fn(),
    getCitations: vi.fn(async ({ evidenceIds }: { readonly evidenceIds: readonly string[] }) => ready(evidenceIds.map((evidenceId: string) => ({
      ...base,
      evidenceId,
      assertionId: evidenceId,
    })), evidenceIds)),
  };
  return handle;
}

describe("Copilot bounded retrieval", () => {
  it("maps five quick prompts, exact aliases, and classified paraphrases to one immutable registry", () => {
    expect(Object.keys(COPILOT_INTENT_REGISTRY)).toEqual([
      "morning-brief",
      "adherence",
      "sleep",
      "changes-since-last-week",
      "churn-risk",
    ]);
    for (const [intentId, recipe] of Object.entries(COPILOT_INTENT_REGISTRY)) {
      const quick = resolveCopilotIntent({ kind: "quick-prompt", promptId: intentId });
      const alias = resolveCopilotIntent({ kind: "exact-alias", text: recipe.aliases[0]! });
      const model = resolveCopilotIntent({
        kind: "model-classified",
        question: `Please help me understand ${intentId}`,
        intentId,
      });
      expect(quick).toEqual(alias);
      expect(alias).toEqual(model);
      expect(quick.status).toBe("resolved");
      if (quick.status === "resolved") {
        expect(quick.recipe.readBudget).toBe(quick.recipe.steps.length);
        expect(Object.isFrozen(quick.recipe)).toBe(true);
      }
    }
    expect(COPILOT_INTENT_REGISTRY.sleep.steps.some((step) => step.operation === "relative-sequence")).toBe(true);
    expect(COPILOT_INTENT_REGISTRY.sleep.steps.some((step) => step.operation === "longitudinal-series")).toBe(false);
    expect(COPILOT_INTENT_REGISTRY.adherence.steps.some((step) => step.operation === "longitudinal-series")).toBe(true);
  });

  it("rejects unknown or oversized intent input before any graph read", async () => {
    expect(resolveCopilotIntent({ kind: "exact-alias", text: "show me another member" }))
      .toEqual({ status: "unsupported" });
    expect(resolveCopilotIntent({ kind: "model-classified", question: "x".repeat(501), intentId: "sleep" }))
      .toMatchObject({ status: "invalid" });

    const handle = fakeHandle();
    const retrieval = createMemberContextRetrieval({ reauthorize: async () => true });
    await expect(retrieval.retrieve({
      selection: { kind: "model-classified", question: "hello", intentId: "unknown" },
      requestedFor: "2026-07-08",
      handle,
    })).resolves.toMatchObject({ status: "invalid" });
    expect(handle.getEvidence).not.toHaveBeenCalled();
  });

  it("rejects guessed IDs and evidence-kind mismatches at the selection gate", () => {
    const adherence = {
      ...base,
      kind: "observation" as const,
      classification: "observation" as const,
      metric: "weekly-workout-completion",
      value: 50,
      unit: "percent",
      sourceOrder: 0,
    };
    expect(validateCopilotEvidenceSelections(
      COPILOT_INTENT_REGISTRY.adherence,
      [{ sectionId: "trend", evidenceIds: [adherence.evidenceId] }],
      [adherence],
    )).toBe(true);
    expect(validateCopilotEvidenceSelections(
      COPILOT_INTENT_REGISTRY.adherence,
      [{ sectionId: "trend", evidenceIds: ["assertion:9999999999999999"] }],
      [adherence],
    )).toBe(false);
    expect(validateCopilotEvidenceSelections(
      COPILOT_INTENT_REGISTRY.adherence,
      [{ sectionId: "trend", evidenceIds: [base.evidenceId] }],
      [{ ...base, kind: "member-profile", timezone: "America/Los_Angeles" }],
    )).toBe(false);
  });

  it("uses one pinned handle, reauthorizes between bounded steps, and forwards recipe timeouts", async () => {
    const handle = fakeHandle();
    const reauthorize = vi.fn(async () => true);
    const retrieval = createMemberContextRetrieval({ reauthorize });
    const result = await retrieval.retrieve({
      selection: { kind: "quick-prompt", promptId: "sleep" },
      requestedFor: "2026-07-08",
      handle,
    });
    expect(result).toMatchObject({
      status: "ready",
      intentId: "sleep",
      requestedFor: "2026-07-08",
      memberTimezone: "America/Los_Angeles",
      contextRevisionId: scope.contextRevisionId,
    });
    expect(reauthorize).toHaveBeenCalledTimes(COPILOT_INTENT_REGISTRY.sleep.readBudget);
    expect(handle.getEvidence).toHaveBeenCalledWith(expect.objectContaining({
      evidenceKinds: ["member-profile"],
      limit: expect.any(Number),
      timeoutMs: COPILOT_INTENT_REGISTRY.sleep.timeoutMs,
    }));
    expect(handle.getCitations).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: COPILOT_INTENT_REGISTRY.sleep.timeoutMs,
    }));
    expect(JSON.stringify(result)).not.toMatch(/MATCH|Cypher/i);
  });

  it("stops immediately when authorization is revoked between steps", async () => {
    const handle = fakeHandle();
    let checks = 0;
    const retrieval = createMemberContextRetrieval({
      reauthorize: async () => (checks += 1) < 2,
    });
    const result = await retrieval.retrieve({
      selection: { kind: "quick-prompt", promptId: "sleep" },
      requestedFor: "2026-07-08",
      handle,
    });
    expect(result).toEqual({ status: "denied", message: "Member context is unavailable." });
    expect(handle.getEvidence).toHaveBeenCalledTimes(1);
    expect(handle.getCitations).not.toHaveBeenCalled();
  });

  it("does not start a graph read or later authorization step after cancellation", async () => {
    const handle = fakeHandle();
    let finishAuthorization!: (allowed: boolean) => void;
    const firstAuthorization = new Promise<boolean>((resolve) => { finishAuthorization = resolve; });
    const reauthorize = vi.fn(() => firstAuthorization);
    const controller = new AbortController();
    const pending = createMemberContextRetrieval({ reauthorize }).retrieve({
      selection: { kind: "quick-prompt", promptId: "sleep" },
      requestedFor: "2026-07-08",
      handle,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(reauthorize).toHaveBeenCalledOnce());
    controller.abort();
    finishAuthorization(true);

    await expect(pending).resolves.toMatchObject({ status: "unavailable" });
    expect(reauthorize).toHaveBeenCalledOnce();
    expect(handle.getEvidence).not.toHaveBeenCalled();
    expect(handle.getRelativeOrderSequence).not.toHaveBeenCalled();
    expect(handle.getCitations).not.toHaveBeenCalled();
  });

  it("bounds conversation attachments to the citation recipe and keeps exact evidence parity", async () => {
    const handle = fakeHandle();
    const observations = [0, 1].map((sourceOrder) => ({
      ...base,
      evidenceId: `assertion:trend${String(sourceOrder).padStart(11, "0")}`,
      assertionId: `assertion:trend${String(sourceOrder).padStart(11, "0")}`,
      semanticId: `adherence:${sourceOrder}`,
      kind: "observation" as const,
      classification: "observation" as const,
      temporal: { precision: "date" as const, effectiveOn: `2026-06-0${sourceOrder + 3}` },
      metric: "weekly-workout-completion",
      value: 50 + sourceOrder,
      unit: "percent",
      sourceOrder,
    }));
    const messages: MessageProjection[] = Array.from({ length: 40 }, (_, messageIndex) => {
      const messageId = `assertion:message${String(messageIndex).padStart(9, "0")}`;
      const attachments = Array.from({ length: 5 }, (_, attachmentIndex) => {
        const evidenceId = `assertion:attach${String(messageIndex * 5 + attachmentIndex).padStart(10, "0")}`;
        return {
          ...base,
          evidenceId,
          assertionId: evidenceId,
          semanticId: `attachment:${messageIndex}:${attachmentIndex}`,
          kind: "media-attachment" as const,
          classification: "source-statement" as const,
          temporal: { precision: "exact-timestamp" as const, effectiveAt: "2026-06-04T12:00:00.000Z" },
          mediaType: "image",
          caption: `Attachment ${messageIndex}-${attachmentIndex}`,
          sourceOrder: attachmentIndex,
          assetStatus: "metadata-only" as const,
          analysisStatus: "not-analyzed" as const,
        };
      });
      return {
        ...base,
        evidenceId: messageId,
        assertionId: messageId,
        semanticId: `message:${messageIndex}`,
        kind: "message" as const,
        classification: "source-statement" as const,
        temporal: { precision: "exact-timestamp" as const, effectiveAt: "2026-06-04T12:00:00.000Z" },
        senderRole: "member" as const,
        text: `Message ${messageIndex}`,
        attachmentEvidenceIds: attachments.map((attachment) => attachment.evidenceId),
        attachments,
      };
    });
    vi.mocked(handle.getEvidence)
      .mockResolvedValueOnce(ready([{
        ...base,
        kind: "member-profile",
        timezone: "America/Los_Angeles",
      }], [base.evidenceId]))
      .mockResolvedValueOnce({ status: "empty", ...scope, evidenceIds: [], message: "none" });
    vi.mocked(handle.getLongitudinalSeries).mockResolvedValueOnce(ready(
      observations,
      observations.map((item) => item.evidenceId),
    ));
    vi.mocked(handle.getConversation).mockResolvedValueOnce(ready<ConversationProjection>({
      conversationEvidenceId: "assertion:conversation0000",
      messages,
    }, messages.flatMap((message) => [message.evidenceId, ...message.attachmentEvidenceIds])));

    const result = await createMemberContextRetrieval({ reauthorize: async () => true }).retrieve({
      selection: { kind: "quick-prompt", promptId: "churn-risk" },
      requestedFor: "2026-07-08",
      handle,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error(`expected ready, got ${result.status}`);
    const citationStep = COPILOT_INTENT_REGISTRY["churn-risk"].steps.at(-1);
    if (citationStep?.operation !== "citations") throw new Error("expected final citation step");
    const citationLimit = citationStep.limit;
    expect(result.evidence).toHaveLength(citationLimit);
    expect(result.citations.map((citation) => citation.evidenceId).sort())
      .toEqual(result.evidence.map((atom) => atom.evidenceId).sort());
    expect(result.sources.conversations.flatMap((conversation) => conversation.messages)
      .flatMap((message) => message.attachments)).toHaveLength(57);
  });

  it("reports a non-retryable invalid plan result when material evidence alone exceeds the citation budget", async () => {
    const handle = fakeHandle();
    const messages: MessageProjection[] = Array.from({ length: 100 }, (_, index) => {
      const evidenceId = `assertion:message${String(index).padStart(9, "0")}`;
      return {
        ...base,
        evidenceId,
        assertionId: evidenceId,
        semanticId: `message:${index}`,
        kind: "message",
        classification: "source-statement",
        temporal: { precision: "exact-timestamp", effectiveAt: "2026-06-04T12:00:00.000Z" },
        senderRole: "member",
        text: `Message ${index}`,
        attachmentEvidenceIds: [],
        attachments: [],
      };
    });
    vi.mocked(handle.getEvidence)
      .mockResolvedValueOnce(ready([{
        ...base,
        kind: "member-profile",
        timezone: "America/Los_Angeles",
      }], [base.evidenceId]))
      .mockResolvedValueOnce({ status: "empty", ...scope, evidenceIds: [], message: "none" });
    vi.mocked(handle.getLongitudinalSeries).mockResolvedValueOnce(ready([], []));
    vi.mocked(handle.getConversation).mockResolvedValueOnce(ready<ConversationProjection>({
      conversationEvidenceId: "assertion:conversation0000",
      messages,
    }, messages.map((message) => message.evidenceId)));

    await expect(createMemberContextRetrieval({ reauthorize: async () => true }).retrieve({
      selection: { kind: "quick-prompt", promptId: "churn-risk" },
      requestedFor: "2026-07-08",
      handle,
    })).resolves.toEqual({
      status: "invalid",
      message: "Retrieval evidence exceeds the citation budget.",
    });
    expect(handle.getCitations).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", null],
    ["invalid", {
      evidenceId: "assertion:invalidanchor00",
      temporal: { precision: "exact-timestamp", effectiveAt: "not-a-timestamp" },
    } as AuthoritativeEvidenceAnchorProjection],
    ["invalid calendar-date", {
      evidenceId: "assertion:invalidanchor01",
      temporal: { precision: "date", effectiveOn: "2026-02-30" },
    } as AuthoritativeEvidenceAnchorProjection],
  ] as const)("fails closed on an %s authoritative anchor before a calendar read", async (_case, anchor) => {
    const handle = fakeHandle(anchor);
    const reauthorize = vi.fn(async () => true);
    const result = await createMemberContextRetrieval({ reauthorize }).retrieve({
      selection: { kind: "quick-prompt", promptId: "adherence" },
      requestedFor: "2099-12-31",
      handle,
    });

    expect(result).toMatchObject({ status: "invalid" });
    expect(reauthorize).toHaveBeenCalledTimes(1);
    expect(handle.getLongitudinalSeries).not.toHaveBeenCalled();
    expect(handle.getCitations).not.toHaveBeenCalled();
  });

  it("executes every seeded quick-prompt recipe without a model on one canonical revision", async () => {
    const snapshot = compileMemberContextGraph(jordan);
    const publisher = new InMemoryMemberContextPublisher();
    const staged = await publisher.stage({
      snapshot,
      canonicalDigest: canonicalMemberContextDigest(snapshot),
      nodeCount: snapshot.nodes.length,
      relationshipCount: snapshot.relationships.length,
    });
    if (staged.status !== "ok") throw new Error(staged.failure.code);
    const validated = await publisher.validate({ publicationAttemptId: staged.data.publicationAttemptId });
    if (validated.status !== "ok") throw new Error(validated.failure.code);
    await publisher.activate({ memberId: snapshot.memberId, contextRevisionId: snapshot.contextRevisionId, expectedPriorRevisionId: null, actorId: "test" });
    const opened = await createRetrieveMemberContext({
      memberContext: new InMemoryMemberContextReadProvider(publisher, { authority: "canonical" }),
      authorizeMemberContext: () => true,
    })({ coachId: jordan.profile.coach_id, memberId: jordan.profile.id, authorizationId: "grant:jordan" });
    if (opened.status !== "ready") throw new Error(opened.status);
    for (const promptId of Object.keys(COPILOT_INTENT_REGISTRY)) {
      const reauthorize = vi.fn(() => true);
      const retrieval = createMemberContextRetrieval({ reauthorize });
      const result = await retrieval.retrieve({
        selection: { kind: "quick-prompt", promptId },
        requestedFor: "2026-07-08",
        handle: opened.handle,
      });
      expect(result, promptId).toMatchObject({
        status: "ready",
        intentId: promptId,
        requestedFor: "2026-07-08",
        evidenceAsOf: "2026-06-04T23:59:59.999-07:00",
        memberTimezone: "America/Los_Angeles",
        contextRevisionId: snapshot.contextRevisionId,
      });
      expect(reauthorize, promptId).toHaveBeenCalledTimes(COPILOT_INTENT_REGISTRY[promptId as keyof typeof COPILOT_INTENT_REGISTRY].readBudget);
      if (promptId === "changes-since-last-week" && result.status === "ready") {
        expect(result.evidence.map((atom) => atom.evidenceKind)).toContain("preference");
        expect(result.citations.map((citation) => citation.evidenceId))
          .toEqual(expect.arrayContaining(result.evidence.map((atom) => atom.evidenceId)));
      }
    }
  });
});
