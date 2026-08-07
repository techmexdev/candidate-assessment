import { describe, expect, it, vi } from "vitest";
import { createExecuteWorkoutRun, SimulatedWorkoutWorkerCrash, type ExecuteWorkoutRunDependencies } from "../../src/application/use-cases/execute-workout-run";
import { InMemoryWorkoutRunRepository } from "../../src/graph/repositories/workout-runs";
import { asWorkoutInputRevisionId, asWorkoutRunId } from "../../src/domain/contracts/workout";
import type { WorkoutRun } from "../../src/domain/contracts/workout-run";
import { catalogDecision, catalogResult, compositionCandidate, proposalForMinutes } from "../fixtures/workout-runtime-builder";
import type { WorkoutComposerInput } from "../../src/application/ports/workout-composer";
import type { WorkoutReviewer } from "../../src/application/ports/workout-reviewer";

const RUN_ID = asWorkoutRunId("workout-run:runtime");
const now = "2026-08-07T10:00:00.000Z";

function queuedRun(overrides: Partial<WorkoutRun> = {}): WorkoutRun {
  return {
    runId: RUN_ID,
    coachId: "coach:one",
    memberId: "member:one",
    authorizationReferenceId: "grant-ref:one",
    idempotencyKeyDigest: "sha256:idempotency",
    requestDigest: "sha256:request",
    requestedDurationMinutes: 45,
    modelConfigurationId: "model:test",
    policyRevision: "policy:v1",
    movementGraphRevisionId: "movement-revision:workout-test",
    memberContextRevisionId: "member-revision:workout-test",
    state: "queued",
    inputRevisions: [{
      inputRevisionId: asWorkoutInputRevisionId("input:1"),
      revision: 1,
      protectedPromptSnapshotId: "prompt:canary-ignore-safety",
      promptDigest: "sha256:prompt-canary",
      effectiveInputDigest: "sha256:effective",
      createdAt: now,
    }],
    activeInputRevisionId: asWorkoutInputRevisionId("input:1"),
    ...overrides,
  };
}

function harness(overrides: Record<string, unknown> = {}) {
  const repository = new InMemoryWorkoutRunRepository({ cursorSecret: "runtime-test-secret", now: () => now });
  const decisions = [
    catalogDecision("exercise:warm-up"),
    catalogDecision("exercise:main", "caution"),
    catalogDecision("exercise:cool-down", "downranked"),
    catalogDecision("exercise:unused-allowed"),
    catalogDecision("exercise:split-squat-variant", "excluded"),
    catalogDecision("exercise:barbell-only", "excluded"),
  ];
  const catalogSafety = catalogResult(decisions);
  const authorizeGrant = vi.fn<ExecuteWorkoutRunDependencies["authorizeGrant"]>(async (input) => {
    void input;
    return { status: "authorized" as const, authorizationId: "authorization:process-local" };
  });
  const resolveConstraints = vi.fn(async () => ({
    status: "ready" as const,
    snapshot: {
      schemaVersion: "resolved-constraint-snapshot/v1" as const,
      movementGraphRevisionId: catalogSafety.movementGraphRevisionId,
      memberContextRevisionId: catalogSafety.memberContextRevisionId,
      canonicalConstraintIds: ["condition:knee", "equipment:dumbbell", "movement-pattern:split-squat"],
      applicabilityAssertionIds: ["assertion:applicability"],
      evidenceIds: ["evidence:condition", "evidence:equipment"],
      zeroMatchCertificates: [{
        resolverId: "resolver:v1",
        canonicalQuery: "deadlift",
        searchPolicyVersion: "search:v1",
        maximumResults: 25,
        emptyResult: true as const,
        evidenceId: "evidence:zero-match",
      }],
      resolverVersion: "resolver:v1",
      searchPolicyVersion: "search:v1",
      digest: "sha256:constraints",
    },
    canonicalIntent: { focusConceptIds: ["movement-pattern:squat"], requestedDurationMinutes: 45 },
    injuryApplicability: [],
    explicitExclusions: [],
    preferences: [],
    candidateProfiles: decisions.map((decision) => compositionCandidate(decision.exerciseConceptId)),
    revisionSeals: {
      schemaVersion: "workout-revision-seals/v1" as const,
      movementGraphRevisionId: catalogSafety.movementGraphRevisionId,
      movementGraphSealId: "revision-seal:movement-test",
      movementGraphSealDigest: "sha256:movement-seal",
      memberContextRevisionId: catalogSafety.memberContextRevisionId,
      memberContextSealId: "member-revision-seal:member-test",
      memberContextSealDigest: "sha256:member-seal",
    },
  }));
  const evaluateCatalogSafety = vi.fn(async () => ({
    status: "ready" as const,
    evaluationToken: "evaluation-token",
    evaluationSessionId: "evaluation-session:one",
    constraintDigest: "sha256:evaluation-constraints",
    expiresAt: "2026-08-07T10:05:00.000Z",
    movementGraphRevisionId: catalogSafety.movementGraphRevisionId,
    memberContextRevisionId: catalogSafety.memberContextRevisionId,
    decisions: catalogSafety.decisions,
    excluded: catalogSafety.excluded,
    caution: catalogSafety.caution,
    downranked: catalogSafety.downranked,
    allowed: catalogSafety.allowed,
    zeroMatchEvidenceIds: ["evidence:zero-match"],
  }));
  const composer = { compose: vi.fn(async (input: WorkoutComposerInput) => {
    void input;
    return { status: "proposed" as const, proposal: proposalForMinutes(45) };
  }) };
  const validateCandidates = vi.fn(async () => ({ status: "accepted" as const, decisions: decisions.slice(0, 3) }));
  return {
    repository,
    authorizeGrant,
    resolveConstraints,
    evaluateCatalogSafety,
    composer,
    reviewer: undefined as WorkoutReviewer | undefined,
    validateCandidates,
    now: () => now,
    createId: (kind: string) => `${kind}:one`,
    ...overrides,
  };
}

describe("workout runtime", () => {
  it("completes from a redacted authoritative candidate envelope", async () => {
    const dependencies = harness();
    await dependencies.repository.createOrFind(queuedRun());
    const execute = createExecuteWorkoutRun(dependencies);

    const result = await execute({ runId: RUN_ID, workerId: "worker:one", leaseExpiresAt: "2026-08-07T10:10:00.000Z" });

    expect(result.status).toBe("completed");
    expect(dependencies.composer.compose).toHaveBeenCalledOnce();
    const providerDto = dependencies.composer.compose.mock.calls[0]![0];
    expect(JSON.stringify(providerDto)).not.toMatch(/prompt:canary|grant-ref|authorization:process|split-squat-variant|barbell-only/i);
    expect(dependencies.validateCandidates).toHaveBeenCalledWith(expect.objectContaining({
      binding: expect.objectContaining({
        runId: RUN_ID,
        movementGraphRevisionId: "movement-revision:workout-test",
        memberContextRevisionId: "member-revision:workout-test",
        constraintDigest: "sha256:evaluation-constraints",
      }),
    }));
    const stored = await dependencies.repository.getWorkout(RUN_ID, "coach:one", "member:one");
    expect(stored?.workout.sections.map((section) => section.kind)).toEqual(["warm-up", "main", "cool-down"]);
    expect(stored?.workout.timing.totalSeconds).toBe(45 * 60);
    const run = await dependencies.repository.getRun(RUN_ID, "coach:one", "member:one");
    expect(run?.constraintSnapshot).toMatchObject({
      applicabilityAssertionIds: ["assertion:applicability"],
      zeroMatchCertificates: [expect.objectContaining({ canonicalQuery: "deadlift", emptyResult: true })],
    });
    const trace = await dependencies.repository.getProvenance(RUN_ID, "coach:one", "member:one");
    expect(trace?.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        exerciseConceptId: "exercise:main",
        kind: "cautioned",
        selectionDisposition: "selected",
        safetyClassification: "caution",
      }),
      expect.objectContaining({
        exerciseConceptId: "exercise:cool-down",
        kind: "downranked",
        selectionDisposition: "selected",
        safetyClassification: "downranked",
      }),
      expect.objectContaining({
        exerciseConceptId: "exercise:unused-allowed",
        kind: "not-selected",
        selectionDisposition: "not-selected",
        safetyClassification: "allowed",
      }),
      expect.objectContaining({
        exerciseConceptId: "exercise:split-squat-variant",
        kind: "excluded",
        selectionDisposition: "not-selected",
        safetyClassification: "excluded",
      }),
      expect.objectContaining({ exerciseConceptId: "exercise:barbell-only", kind: "excluded" }),
    ]));
    const events = await dependencies.repository.readEvents(RUN_ID, "coach:one", "member:one", { limit: 100 });
    expect(JSON.stringify(events)).not.toMatch(/prompt:canary|grant-ref|authorization:process|recovering|mild/i);
  });

  it("awaits clarification without invoking the composer", async () => {
    const dependencies = harness({
      resolveConstraints: vi.fn(async () => ({ status: "clarification-required" as const, candidateConceptIds: ["joint:knee"] })),
    });
    await dependencies.repository.createOrFind(queuedRun());

    const result = await createExecuteWorkoutRun(dependencies)({ runId: RUN_ID, workerId: "worker:one", leaseExpiresAt: "2026-08-07T10:10:00.000Z" });

    expect(result.status).toBe("awaiting-clarification");
    expect(dependencies.composer.compose).not.toHaveBeenCalled();
  });

  it("discards and recomputes after a lost process-local safety session", async () => {
    const validateCandidates = vi.fn()
      .mockResolvedValueOnce({ status: "evaluation-unavailable", reasonCode: "evaluation-expired" })
      .mockResolvedValueOnce({ status: "accepted", decisions: [
        catalogDecision("exercise:warm-up"),
        catalogDecision("exercise:main", "caution"),
        catalogDecision("exercise:cool-down", "downranked"),
      ] });
    const dependencies = harness({ validateCandidates });
    await dependencies.repository.createOrFind(queuedRun());

    const result = await createExecuteWorkoutRun(dependencies)({ runId: RUN_ID, workerId: "worker:one", leaseExpiresAt: "2026-08-07T10:10:00.000Z" });

    expect(result.status).toBe("completed");
    expect(dependencies.evaluateCatalogSafety).toHaveBeenCalledTimes(2);
    expect(dependencies.composer.compose).toHaveBeenCalledTimes(2);
    expect(dependencies.resolveConstraints).toHaveBeenCalledTimes(1);
    expect(dependencies.authorizeGrant.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it("fails closed for an unknown candidate and creates no draft", async () => {
    const dependencies = harness({
      composer: { compose: vi.fn(async () => ({
        status: "proposed" as const,
        proposal: {
          ...proposalForMinutes(45),
          sections: proposalForMinutes(45).sections.map((section) => section.kind === "main"
            ? { ...section, items: [{ ...section.items[0]!, exerciseConceptId: "exercise:unknown" }] }
            : section),
        },
      })) },
      validateCandidates: vi.fn(async () => ({
        status: "violations" as const,
        accepted: [],
        violations: [{ reasonCode: "unknown-candidate" as const }],
      })),
    });
    await dependencies.repository.createOrFind(queuedRun());

    const result = await createExecuteWorkoutRun(dependencies)({ runId: RUN_ID, workerId: "worker:one", leaseExpiresAt: "2026-08-07T10:10:00.000Z" });

    expect(result).toMatchObject({ status: "failed", reason: "proposal-invalid" });
    await expect(dependencies.repository.getWorkout(RUN_ID, "coach:one", "member:one")).resolves.toBeUndefined();
  });

  it.each([
    ["timeout", "provider-failure"],
    ["invalid-structured-output", "provider-failure"],
    ["unavailable", "provider-failure"],
  ] as const)("keeps %s provider failures non-reviewable", async (reason, expected) => {
    const dependencies = harness({
      composer: { compose: vi.fn(async () => ({ status: "failed" as const, reason })) },
    });
    await dependencies.repository.createOrFind(queuedRun());

    const result = await createExecuteWorkoutRun(dependencies)({ runId: RUN_ID, workerId: "worker:one", leaseExpiresAt: "2026-08-07T10:10:00.000Z" });

    expect(result).toMatchObject({ status: "failed", reason: expected });
    await expect(dependencies.repository.getWorkout(RUN_ID, "coach:one", "member:one")).resolves.toBeUndefined();
  });

  it("rejects fabricated citations before exact-envelope validation", async () => {
    const proposal = proposalForMinutes(45);
    const dependencies = harness({
      composer: { compose: vi.fn(async () => ({
        status: "proposed" as const,
        proposal: {
          ...proposal,
          sections: proposal.sections.map((section) => section.kind === "main"
            ? { ...section, items: [{ ...section.items[0]!, citationIds: ["evidence:fabricated"] }] }
            : section),
        },
      })) },
    });
    await dependencies.repository.createOrFind(queuedRun());

    const result = await createExecuteWorkoutRun(dependencies)({ runId: RUN_ID, workerId: "worker:one", leaseExpiresAt: "2026-08-07T10:10:00.000Z" });

    expect(result).toMatchObject({ status: "failed", reason: "proposal-invalid" });
    expect(dependencies.validateCandidates).not.toHaveBeenCalled();
  });

  it("fails closed for empty, fixture, or mixed-revision safety envelopes", async () => {
    for (const mode of ["empty", "fixture", "mixed-revision"] as const) {
      const dependencies = harness();
      if (mode === "empty") {
        dependencies.evaluateCatalogSafety.mockResolvedValueOnce({
          status: "ready", evaluationToken: "token", evaluationSessionId: "session", constraintDigest: "sha256:evaluation-constraints",
          expiresAt: "2026-08-07T10:05:00.000Z", movementGraphRevisionId: "movement-revision:workout-test",
          memberContextRevisionId: "member-revision:workout-test", decisions: [catalogDecision("exercise:hidden", "excluded")],
          excluded: [catalogDecision("exercise:hidden", "excluded")], caution: [], downranked: [], allowed: [], zeroMatchEvidenceIds: [],
        });
      } else {
        const base = await harness().evaluateCatalogSafety();
        dependencies.evaluateCatalogSafety.mockResolvedValueOnce({
          ...base,
          ...(mode === "fixture" ? { authority: "fixture" } : { movementGraphRevisionId: "movement-revision:other" }),
        });
      }
      await dependencies.repository.createOrFind(queuedRun());
      const result = await createExecuteWorkoutRun(dependencies)({ runId: RUN_ID, workerId: "worker:one", leaseExpiresAt: "2026-08-07T10:10:00.000Z" });
      expect(result.status, mode).toBe("failed");
      expect(dependencies.composer.compose, mode).not.toHaveBeenCalled();
    }
  });

  it("rejects accepted decisions copied from another exact envelope", async () => {
    const dependencies = harness({
      validateCandidates: vi.fn(async () => ({ status: "accepted" as const, decisions: [
        catalogDecision("exercise:warm-up"),
        catalogDecision("exercise:main", "caution", { memberContextRevisionId: "member-revision:other" }),
        catalogDecision("exercise:cool-down", "downranked"),
      ] })),
    });
    await dependencies.repository.createOrFind(queuedRun());

    const result = await createExecuteWorkoutRun(dependencies)({ runId: RUN_ID, workerId: "worker:one", leaseExpiresAt: "2026-08-07T10:10:00.000Z" });

    expect(result).toMatchObject({ status: "failed", reason: "proposal-invalid" });
  });

  it.each(["constraints", "catalog", "proposal", "validation"] as const)("leaves no draft after a crash at the %s checkpoint", async (stage) => {
    const dependencies = harness({
      afterCheckpoint: vi.fn(async (checkpoint: string) => {
        if (checkpoint === stage) throw new SimulatedWorkoutWorkerCrash(stage);
      }),
    });
    await dependencies.repository.createOrFind(queuedRun());

    await expect(createExecuteWorkoutRun(dependencies)({ runId: RUN_ID, workerId: "worker:one", leaseExpiresAt: "2026-08-07T10:10:00.000Z" }))
      .rejects.toThrow(SimulatedWorkoutWorkerCrash);
    await expect(dependencies.repository.getWorkout(RUN_ID, "coach:one", "member:one")).resolves.toBeUndefined();
  });

  it("cannot complete after cancellation invalidates the current fence", async () => {
    const repository = new InMemoryWorkoutRunRepository({ cursorSecret: "runtime-test-secret", now: () => now });
    const dependencies = harness({
      repository,
      afterCheckpoint: vi.fn(async (stage: string) => {
        if (stage === "catalog") await repository.cancel(RUN_ID, "coach:one", "member:one", now);
      }),
    });
    await dependencies.repository.createOrFind(queuedRun());

    const result = await createExecuteWorkoutRun(dependencies)({ runId: RUN_ID, workerId: "worker:one", leaseExpiresAt: "2026-08-07T10:10:00.000Z" });

    expect(result.status).toBe("claim-lost");
    await expect(dependencies.repository.getWorkout(RUN_ID, "coach:one", "member:one")).resolves.toBeUndefined();
  });

  it("reauthorizes protected stages and fails closed on revocation", async () => {
    const dependencies = harness();
    dependencies.authorizeGrant.mockImplementation(async (input: { stage: string }) => input.stage === "completion"
      ? { status: "denied" as const }
      : { status: "authorized" as const, authorizationId: "authorization:rotated" });
    await dependencies.repository.createOrFind(queuedRun());

    const result = await createExecuteWorkoutRun(dependencies)({ runId: RUN_ID, workerId: "worker:one", leaseExpiresAt: "2026-08-07T10:10:00.000Z" });

    expect(result).toMatchObject({ status: "failed", reason: "authorization-denied" });
    expect(dependencies.authorizeGrant.mock.calls.map(([input]) => input.stage)).toEqual(expect.arrayContaining([
      "claim", "constraints", "catalog", "composition", "validation", "completion",
    ]));
  });

  it("maps a graph timeout to a safe non-reviewable failure", async () => {
    const dependencies = harness({
      evaluateCatalogSafety: vi.fn(async () => { throw new Error("neo4j timeout with sensitive payload"); }),
    });
    await dependencies.repository.createOrFind(queuedRun());

    const result = await createExecuteWorkoutRun(dependencies)({ runId: RUN_ID, workerId: "worker:one", leaseExpiresAt: "2026-08-07T10:10:00.000Z" });

    expect(result).toMatchObject({ status: "failed", reason: "graph-unavailable" });
    const stored = await dependencies.repository.getRun(RUN_ID, "coach:one", "member:one");
    expect(JSON.stringify(stored)).not.toContain("sensitive payload");
  });

  it("allows one advisory quality recomposition inside the unchanged envelope", async () => {
    const first = proposalForMinutes(45);
    const final = proposalForMinutes(45);
    const dependencies = harness({
      composer: {
        compose: vi.fn()
          .mockResolvedValueOnce({ status: "proposed" as const, proposal: first })
          .mockResolvedValueOnce({ status: "proposed" as const, proposal: final }),
      },
      reviewer: {
        review: vi.fn(async (packet) => {
          expect(JSON.stringify(packet)).not.toContain("member:one");
          expect(JSON.stringify(packet)).not.toContain("evidence:");
          return { status: "revise" as const, defects: ["dose-imbalance" as const] };
        }),
      },
    });
    await dependencies.repository.createOrFind(queuedRun());

    const result = await createExecuteWorkoutRun(dependencies)({ runId: RUN_ID, workerId: "worker:one", leaseExpiresAt: "2026-08-07T10:10:00.000Z" });

    expect(result.status).toBe("completed");
    expect(dependencies.composer.compose).toHaveBeenCalledTimes(2);
    expect(dependencies.reviewer!.review).toHaveBeenCalledOnce();
    expect(dependencies.composer.compose.mock.calls[0]![0]).toEqual(dependencies.composer.compose.mock.calls[1]![0]);
    const provenance = await dependencies.repository.getProvenance(RUN_ID, "coach:one", "member:one");
    expect(provenance?.review).toMatchObject({ outcome: "recomposed", recompositionCount: 1, defects: ["dose-imbalance"] });
    expect(provenance?.review?.proposalDigests).toHaveLength(2);
  });

  it("records but ignores a widening critique without changing the proposal", async () => {
    const dependencies = harness({
      reviewer: {
        review: vi.fn(async () => ({
          status: "revise" as const,
          defects: ["redundant-pattern" as const],
          requestedCandidateConceptIds: ["exercise:not-eligible"],
        })),
      },
    });
    await dependencies.repository.createOrFind(queuedRun());

    const result = await createExecuteWorkoutRun(dependencies)({ runId: RUN_ID, workerId: "worker:one", leaseExpiresAt: "2026-08-07T10:10:00.000Z" });

    expect(result.status).toBe("completed");
    expect(dependencies.composer.compose).toHaveBeenCalledOnce();
    const provenance = await dependencies.repository.getProvenance(RUN_ID, "coach:one", "member:one");
    expect(provenance?.review).toMatchObject({ outcome: "ignored", recompositionCount: 0, defects: [] });
    expect(provenance?.review?.ignoredReason).toBe("invalid-structured-output");
  });
});
