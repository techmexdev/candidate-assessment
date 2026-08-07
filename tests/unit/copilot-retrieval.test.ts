import { describe, expect, it, vi } from "vitest";
import jordan from "../../data/member-context.json";
import type {
  MemberContextQueryResult,
  MemberContextReadHandle,
  MemberEvidenceProjection,
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

function ready<T>(data: T, evidenceIds: readonly string[]): MemberContextQueryResult<T> {
  return { status: "ready", ...scope, data, evidenceIds };
}

function fakeHandle() {
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
    getEvidence: vi.fn(async () => ready(evidence, [base.evidenceId])),
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
    const retrieval = createMemberContextRetrieval({ reauthorize: () => true });

    for (const promptId of Object.keys(COPILOT_INTENT_REGISTRY)) {
      const result = await retrieval.retrieve({
        selection: { kind: "quick-prompt", promptId },
        requestedFor: "2026-07-08",
        evidenceAsOf: "2026-06-04T23:59:59.999-07:00",
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
    }
  });
});
