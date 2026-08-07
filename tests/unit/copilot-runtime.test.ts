import { describe, expect, it, vi } from "vitest";
import type { CopilotModel, CopilotModelInput } from "../../src/application/ports/copilot-model";
import type { CopilotRuntimeRequest } from "../../src/application/ports/copilot-runtime";
import { createCopilotRuntime } from "../../src/agents/copilot-runtime";
import type { CopilotRetrievalReady } from "../../src/agents/tools/member-context-retrieval";
import { COPILOT_INTENT_REGISTRY } from "../../src/domain/policies/copilot-retrieval-plan";
import type { MemberContextReadHandle, ObservationEvidenceProjection } from "../../src/domain/contracts/member-context-queries";
import type { MemberContextRetrievalRequest } from "../../src/agents/tools/member-context-retrieval";
import { createAnswerCopilotQuestion } from "../../src/application/use-cases/answer-copilot-question";

const now = "2026-08-07T10:00:00.000Z";
const scope = { memberId: "mbr_jordan", contextRevisionId: "member-context:sha256:r1", authority: "canonical" } as const;
const source = { locator: "/adherence/1", artifactDigest: "sha256:source" } as const;

const observation: ObservationEvidenceProjection = {
  evidenceId: "assertion:1111111111111111",
  assertionId: "assertion:1111111111111111",
  semanticId: "adherence:1",
  kind: "observation",
  source,
  classification: "observation",
  temporal: { precision: "date", effectiveOn: "2026-06-04" },
  metric: "weekly-workout-completion",
  value: 75,
  unit: "percent",
  sourceOrder: 0,
};

const handle = {
  ...scope,
  coachId: "coach_casey",
} as MemberContextReadHandle;

function retrieved(intentId: "adherence" | "churn-risk" = "adherence"): CopilotRetrievalReady {
  const recipe = COPILOT_INTENT_REGISTRY[intentId];
  return {
    status: "ready",
    ...scope,
    intentId,
    registryVersion: recipe.registryVersion,
    recipe,
    requestedFor: "2026-07-08",
    evidenceAsOf: "2026-06-04T23:59:59.999-07:00",
    memberTimezone: "America/Los_Angeles",
    briefFreshness: null,
    evidence: [{ ...scope, atomKind: "fact", evidenceId: observation.evidenceId, evidenceKind: observation.kind, source, classification: observation.classification, temporal: observation.temporal, value: observation.value, unit: observation.unit }],
    citations: [{ ...scope, citationId: "citation:1", evidenceId: observation.evidenceId, label: source.locator, source, classification: observation.classification, temporal: observation.temporal, unit: observation.unit }],
    sources: { evidence: [observation], longitudinal: [observation], relativeSequence: [], conversations: [], brief: null, workouts: [], sourceChurnAssessment: null, sourceChurnReasons: [] },
  };
}

function runtimeHarness(overrides: Record<string, unknown> = {}) {
  const model: CopilotModel = {
    select: vi.fn(async () => ({
      status: "selected" as const,
      candidate: { schemaVersion: "copilot-model-candidate/v1" as const, intentId: "adherence" as const, selections: [] },
    })),
  };
  const retrieve = vi.fn(async ({ selection }: Readonly<MemberContextRetrievalRequest>) => {
    const selected = selection.kind === "model-classified"
      ? selection.intentId
      : selection.kind === "quick-prompt"
        ? selection.promptId
        : "adherence";
    return retrieved(selected as "adherence");
  });
  const runtime = createCopilotRuntime({
    model,
    retrieve,
    now: () => now,
    createId: (kind) => `${kind}:1`,
    signContinuation: async (claims) => ({ schemaVersion: "signed-copilot-continuation/v1", algorithm: "hmac-sha256", claims, signature: "signed" }),
    ...overrides,
  });
  return { runtime, model, retrieve };
}

function request(input: CopilotRuntimeRequest["input"]): CopilotRuntimeRequest {
  return { requestId: "request:1", requestedFor: "2026-07-08", input, memberContext: handle };
}

describe("bounded Copilot runtime", () => {
  it("classifies free text with stable IDs only, exposes no graph tools, and renders facts deterministically", async () => {
    const { runtime, model } = runtimeHarness();
    const result = await runtime.answer(request({ kind: "free-text", question: "How is consistency trending?" }));
    expect(result).toMatchObject({ status: "ready", answer: { intentId: "adherence", memberId: scope.memberId, contextRevisionId: scope.contextRevisionId } });
    expect(model.select).toHaveBeenCalledOnce();
    const dto = vi.mocked(model.select).mock.calls[0]![0] as CopilotModelInput;
    expect(dto).toEqual({
      schemaVersion: "copilot-model-input/v1",
      question: "How is consistency trending?",
      intentIds: Object.keys(COPILOT_INTENT_REGISTRY),
      sections: [],
    });
    expect(JSON.stringify(dto)).not.toMatch(/member|revision|grant|lab|biomarker|Cypher|tools/i);
  });

  it("keeps quick prompts deterministic when the model is unavailable", async () => {
    const { runtime, model } = runtimeHarness({ model: { select: vi.fn(async () => ({ status: "failed", reason: "unavailable" })) } });
    const result = await runtime.answer(request({ kind: "quick-prompt", promptId: "adherence" }));
    expect(result.status).toBe("ready");
    expect(model.select).not.toHaveBeenCalled();
  });

  it("maps free-text timeout to a retryable model error", async () => {
    const { runtime } = runtimeHarness({ model: { select: vi.fn(async () => ({ status: "failed", reason: "timeout" })) } });
    await expect(runtime.answer(request({ kind: "free-text", question: "How is consistency trending?" }))).resolves.toEqual({
      status: "model-error",
      requestId: "request:1",
      code: "provider-timeout",
      retryable: true,
      message: "Copilot intent selection timed out.",
    });
  });

  it("returns cancelled and ignores a model result that settles after abort", async () => {
    let settle!: (value: Awaited<ReturnType<CopilotModel["select"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<CopilotModel["select"]>>>((resolve) => { settle = resolve; });
    const { runtime, retrieve } = runtimeHarness({ model: { select: vi.fn(() => pending) } });
    const controller = new AbortController();
    const answer = runtime.answer(request({ kind: "free-text", question: "How is consistency trending?" }), { signal: controller.signal });
    controller.abort();
    await expect(answer).resolves.toEqual({ status: "cancelled", requestId: "request:1" });
    settle({ status: "selected", candidate: { schemaVersion: "copilot-model-candidate/v1", intentId: "adherence", selections: [] } });
    await Promise.resolve();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("reauthorizes and opens the continuation's sealed revision; a request without it opens active", async () => {
    const runtime = { answer: vi.fn(async (value: CopilotRuntimeRequest) => ({ status: "cancelled" as const, requestId: value.requestId })) };
    const openActive = vi.fn(async () => ({ status: "ready" as const, handle }));
    const openRevision = vi.fn(async () => ({ status: "ready" as const, handle }));
    const authorizeMemberContext = vi.fn(async () => true);
    const answer = createAnswerCopilotQuestion({
      memberContext: { openActive, openRevision },
      authorizeMemberContext,
      runtime,
      verifyContinuation: async (value) => value.claims,
      now: () => now,
    });
    const continuation = {
      schemaVersion: "signed-copilot-continuation/v1" as const,
      algorithm: "hmac-sha256" as const,
      claims: { schemaVersion: "copilot-continuation-claims/v1" as const, coachId: "coach_casey", memberId: scope.memberId, contextRevisionId: scope.contextRevisionId, answerId: "answer:prior", intentId: "adherence" as const, selectedEvidenceIds: [], issuedAt: "2026-08-07T09:00:00.000Z", expiresAt: "2026-08-07T11:00:00.000Z" },
      signature: "signed",
    };
    await answer({ coachId: "coach_casey", authorizationId: "grant:1", request: { schemaVersion: "copilot-request/v1", requestId: "request:1", memberId: scope.memberId, requestedFor: "2026-07-08", input: { kind: "quick-prompt", promptId: "adherence" }, continuation } });
    expect(authorizeMemberContext).toHaveBeenCalled();
    expect(openRevision).toHaveBeenCalledWith(expect.anything(), scope.contextRevisionId);
    expect(openActive).not.toHaveBeenCalled();

    await answer({ coachId: "coach_casey", authorizationId: "grant:1", request: { schemaVersion: "copilot-request/v1", requestId: "request:2", memberId: scope.memberId, requestedFor: "2026-07-08", input: { kind: "quick-prompt", promptId: "adherence" } } });
    expect(openActive).toHaveBeenCalledOnce();
  });

  it("rejects expired or wrong-binding continuations before opening or retrieving", async () => {
    const openActive = vi.fn();
    const openRevision = vi.fn();
    const runtime = { answer: vi.fn() };
    const answer = createAnswerCopilotQuestion({
      memberContext: { openActive, openRevision },
      authorizeMemberContext: vi.fn(async () => true),
      runtime,
      verifyContinuation: async (value) => ({ ...value.claims, memberId: "mbr_other", expiresAt: "2026-08-07T09:00:00.000Z" }),
      now: () => now,
    });
    const result = await answer({
      coachId: "coach_casey",
      authorizationId: "grant:1",
      request: {
        schemaVersion: "copilot-request/v1", requestId: "request:1", memberId: scope.memberId, requestedFor: "2026-07-08", input: { kind: "quick-prompt", promptId: "adherence" },
        continuation: { schemaVersion: "signed-copilot-continuation/v1", algorithm: "hmac-sha256", claims: { schemaVersion: "copilot-continuation-claims/v1", coachId: "coach_casey", memberId: scope.memberId, contextRevisionId: scope.contextRevisionId, answerId: "answer:prior", intentId: "adherence", selectedEvidenceIds: [], issuedAt: "2026-08-07T08:00:00.000Z", expiresAt: "2026-08-07T09:00:00.000Z" }, signature: "signed" },
      },
    });
    expect(result).toMatchObject({ status: "continuation-expired" });
    expect(openRevision).not.toHaveBeenCalled();
    expect(runtime.answer).not.toHaveBeenCalled();
  });
});
