import { describe, expect, it } from "vitest";
import { createWorkoutProvenanceBundle } from "../../src/domain/contracts/workout-provenance";
import { asWorkoutInputRevisionId, asWorkoutRunId, asWorkoutVersionId } from "../../src/domain/contracts/workout";
import type { WorkoutRun } from "../../src/domain/contracts/workout-run";
import { InMemoryWorkoutRunRepository } from "../../src/graph/repositories/workout-runs";
import { WORKOUT_RUN_CYPHER } from "../../src/graph/cypher/workout-runs";
import { canonicalWorkoutDecisionSetDigest, canonicalWorkoutDigest, canonicalWorkoutPayloadDigest, canonicalWorkoutProvenanceDigest } from "../../src/graph/schema/workout-run-schema";
import { validateWorkoutComposition } from "../../src/domain/policies/workout-composition";
import { validationInput, workoutDecision } from "../fixtures/workout-runtime-builder";

const RUN_ID = asWorkoutRunId("workout-run:repository-contract");
const REPOSITORY_NOW = () => "2026-08-07T10:00:05.000Z";

function run(overrides: Partial<WorkoutRun> = {}): WorkoutRun {
  return {
    runId: RUN_ID,
    coachId: "coach:one",
    memberId: "member:one",
    authorizationReferenceId: "grant:one",
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
      protectedPromptSnapshotId: "prompt:1",
      promptDigest: "sha256:prompt",
      effectiveInputDigest: "sha256:effective:1",
      createdAt: "2026-08-07T10:00:00.000Z",
    }],
    activeInputRevisionId: asWorkoutInputRevisionId("input:1"),
    ...overrides,
  };
}

function completion(generation: number) {
  const source = validationInput();
  const validated = validateWorkoutComposition(source);
  if (validated.status !== "valid") throw new Error("fixture must validate");
  const workoutVersion = {
    workoutVersionId: asWorkoutVersionId("workout-version:1"),
    version: 1,
    createdAt: "2026-08-07T10:05:00.000Z",
    workout: { ...validated.workout, runId: RUN_ID },
  };
  let provenance = createWorkoutProvenanceBundle({
    runId: RUN_ID,
    workoutVersionId: workoutVersion.workoutVersionId,
    promptEntityId: "prompt:1",
    candidateSetEntityId: `candidate-set:${canonicalWorkoutDigest(completionArtifacts.safetyEnvelope)}`,
    modelProposalEntityId: `model-proposal:${canonicalWorkoutDigest(completionArtifacts.modelProposal)}`,
    policyEntityId: "policy:v1",
    movementGraphRevisionId: run().movementGraphRevisionId,
    memberContextRevisionId: run().memberContextRevisionId,
    decisions: [
      workoutDecision("exercise:warm-up"),
      workoutDecision("exercise:main"),
      workoutDecision("exercise:cool-down"),
    ],
    traceSchemaVersion: "workout-provenance/v1",
    digest: "sha256:provenance",
  });
  const provenanceDigest = canonicalWorkoutProvenanceDigest(provenance);
  provenance = { ...provenance, digest: provenanceDigest };
  const validationReceipt = {
    ...validated.receipt,
    runId: RUN_ID,
    claimGeneration: generation,
    completeDecisionSetDigest: canonicalWorkoutDecisionSetDigest(provenance.decisions),
    revisionSealDigest: canonicalWorkoutDigest(completionArtifacts.revisionSeals),
    safetyEnvelopeDigest: canonicalWorkoutDigest(completionArtifacts.safetyEnvelope),
    modelProposalDigest: canonicalWorkoutDigest(completionArtifacts.modelProposal),
    workoutPayloadDigest: canonicalWorkoutPayloadDigest(workoutVersion),
    provenanceDigest,
  };
  return {
    fence: { runId: RUN_ID, generation, workerId: "worker:one" },
    authorizationReferenceId: "grant:one",
    workoutVersion,
    provenance,
    validationReceipt,
  };
}

const safetyEnvelope = validationInput().catalogSafety;
if (safetyEnvelope.status !== "ready") throw new Error("fixture safety envelope must be ready");
const completionArtifacts = {
  revisionSeals: {
    schemaVersion: "workout-revision-seals/v1" as const,
    movementGraphRevisionId: run().movementGraphRevisionId,
    movementGraphSealId: "revision-seal:movement-test",
    movementGraphSealDigest: "sha256:movement-seal",
    memberContextRevisionId: run().memberContextRevisionId,
    memberContextSealId: "member-revision-seal:member-test",
    memberContextSealDigest: "sha256:member-seal",
  },
  safetyEnvelope,
  modelProposal: validationInput().proposal,
};

async function saveCompletionArtifacts(repository: InMemoryWorkoutRunRepository, fence: { runId: typeof RUN_ID; generation: number; workerId: string }) {
  await repository.saveCompletionArtifact(fence, { kind: "revision-seals", payload: completionArtifacts.revisionSeals });
  await repository.saveCompletionArtifact(fence, { kind: "safety-envelope", payload: completionArtifacts.safetyEnvelope });
  await repository.saveCompletionArtifact(fence, { kind: "model-proposal", payload: completionArtifacts.modelProposal });
}

const constraintSnapshot = {
  schemaVersion: "resolved-constraint-snapshot/v1" as const,
  movementGraphRevisionId: "movement-revision:workout-test",
  memberContextRevisionId: "member-revision:workout-test",
  canonicalConstraintIds: ["constraint:test"],
  applicabilityAssertionIds: ["assertion:applicability"],
  evidenceIds: ["evidence:test"],
  zeroMatchCertificates: [],
  resolverVersion: "resolver:v1",
  searchPolicyVersion: "search:v1",
  digest: "sha256:constraints",
};

describe("in-memory workout run repository contract", () => {
  it("atomically reserves creation identity and recovers an abandoned owner without changing run identity", async () => {
    const repository = new InMemoryWorkoutRunRepository({ cursorSecret: "test-secret", now: REPOSITORY_NOW });
    const first = {
      coachId: "coach:one",
      memberId: "member:one",
      action: "generate-workout" as const,
      idempotencyKeyDigest: "sha256:idempotency",
      requestDigest: "sha256:request",
      runId: RUN_ID,
      ownerId: "owner:first",
      createdAt: "2026-08-07T10:00:00.000Z",
      expiresAt: "2026-08-07T10:01:00.000Z",
    };
    await expect(repository.reserveCreation(first)).resolves.toMatchObject({ status: "reserved", reservation: { runId: RUN_ID } });
    await expect(repository.reserveCreation({ ...first, runId: asWorkoutRunId("workout-run:duplicate"), ownerId: "owner:second" }))
      .resolves.toEqual({ status: "pending" });
    await expect(repository.reserveCreation({ ...first, requestDigest: "sha256:changed", ownerId: "owner:conflict" }))
      .resolves.toEqual({ status: "idempotency-conflict" });

    await repository.releaseCreation(first);
    const recovered = await repository.reserveCreation({ ...first, runId: asWorkoutRunId("workout-run:replacement"), ownerId: "owner:second" });
    expect(recovered).toMatchObject({
      status: "reserved",
      reservation: { runId: RUN_ID, ownerId: "owner:second", createdAt: first.createdAt },
    });
    if (recovered.status !== "reserved") throw new Error("reservation recovery failed");
    await expect(repository.finalizeCreation(recovered.reservation, run())).resolves.toMatchObject({ status: "created", run: { runId: RUN_ID } });
    await expect(repository.reserveCreation({ ...first, ownerId: "owner:third" }))
      .resolves.toMatchObject({ status: "replayed", run: { runId: RUN_ID } });
  });

  it("enforces scoped idempotency and authorized reads", async () => {
    const repository = new InMemoryWorkoutRunRepository({ cursorSecret: "test-secret", now: REPOSITORY_NOW });
    await expect(repository.createOrFind(run())).resolves.toMatchObject({ status: "created" });
    await expect(repository.createOrFind(run({ runId: asWorkoutRunId("workout-run:duplicate") })))
      .resolves.toMatchObject({ status: "replayed", run: { runId: RUN_ID } });
    await expect(repository.createOrFind(run({ runId: asWorkoutRunId("workout-run:conflict"), requestDigest: "sha256:changed" })))
      .resolves.toEqual({ status: "idempotency-conflict" });
    await expect(repository.createOrFind(run({ runId: asWorkoutRunId("workout-run:new-key"), idempotencyKeyDigest: "sha256:new-key" })))
      .resolves.toMatchObject({ status: "created", run: { runId: "workout-run:new-key" } });
    await expect(repository.createOrFind(run({ runId: asWorkoutRunId("workout-run:other-member"), memberId: "member:other" })))
      .resolves.toMatchObject({ status: "created", run: { memberId: "member:other" } });
    await expect(repository.getRun(RUN_ID, "coach:one", "member:other")).resolves.toBeUndefined();
  });

  it("claims with a lease, increments the fence on reclaim, and rejects stale mutations", async () => {
    const repository = new InMemoryWorkoutRunRepository({ cursorSecret: "test-secret", now: REPOSITORY_NOW });
    await repository.createOrFind(run());
    const first = await repository.claim(RUN_ID, "worker:one", "2026-08-07T10:00:01.000Z", "2026-08-07T10:00:10.000Z");
    expect(first.status).toBe("claimed");
    await expect(repository.claim(RUN_ID, "worker:two", "2026-08-07T10:00:05.000Z", "2026-08-07T10:00:15.000Z"))
      .resolves.toEqual({ status: "not-claimable" });
    const reclaimed = await repository.claim(RUN_ID, "worker:two", "2026-08-07T10:00:11.000Z", "2026-08-07T10:00:20.000Z");
    expect(reclaimed).toMatchObject({ status: "claimed", fence: { generation: 2, workerId: "worker:two" } });
    if (first.status !== "claimed") return;
    await expect(repository.heartbeat(first.fence, "2026-08-07T10:00:12.000Z", "2026-08-07T10:00:30.000Z"))
      .resolves.toEqual({ status: "stale-fence" });
    await expect(repository.saveConstraintSnapshot(first.fence, constraintSnapshot)).resolves.toEqual({ status: "stale-fence" });
    await expect(repository.appendEvent(first.fence, { kind: "stage", occurredAt: "2026-08-07T10:00:12.000Z", safeData: { stage: "late" } }))
      .resolves.toEqual({ status: "stale-fence" });
    await expect(repository.fail(first.fence, { kind: "claim-lost", stage: "claim", safeMessage: "Claim lost", occurredAt: "2026-08-07T10:00:12.000Z" }))
      .resolves.toEqual({ status: "stale-fence" });
    await expect(repository.complete(completion(first.fence.generation))).resolves.toEqual({ status: "stale-fence" });
  });

  it("rejects every fenced mutation once the authoritative repository clock reaches lease expiry", async () => {
    let currentTime = "2026-08-07T10:00:01.000Z";
    const repository = new InMemoryWorkoutRunRepository({
      cursorSecret: "test-secret",
      now: () => currentTime,
    });
    await repository.createOrFind(run());
    const claim = await repository.claim(RUN_ID, "worker:one", currentTime, "2026-08-07T10:00:10.000Z");
    if (claim.status !== "claimed") throw new Error("claim failed");
    currentTime = "2026-08-07T10:00:10.000Z";

    await expect(repository.heartbeat(claim.fence, currentTime, "2026-08-07T10:00:20.000Z"))
      .resolves.toEqual({ status: "stale-fence" });
    await expect(repository.saveConstraintSnapshot(claim.fence, constraintSnapshot))
      .resolves.toEqual({ status: "stale-fence" });
    await expect(repository.appendEvent(claim.fence, { kind: "stage", occurredAt: currentTime, safeData: { stage: "late" } }))
      .resolves.toEqual({ status: "stale-fence" });
    await expect(repository.awaitClarification(claim.fence, currentTime, ["joint:knee"]))
      .resolves.toEqual({ status: "stale-fence" });
    await expect(repository.fail(claim.fence, { kind: "claim-lost", stage: "claim", safeMessage: "Claim lost", occurredAt: currentTime }))
      .resolves.toEqual({ status: "stale-fence" });
    await expect(repository.complete(completion(claim.fence.generation)))
      .resolves.toEqual({ status: "stale-fence" });
    await expect(repository.getRun(RUN_ID, "coach:one", "member:one"))
      .resolves.toMatchObject({ state: "running", claim: { generation: 1 } });
  });

  it.each(["heartbeat", "saveConstraintSnapshot", "allocateEvent", "awaitClarification", "fail", "complete"] as const)(
    "guards the Neo4j %s mutation with database-authoritative lease time",
    (mutation) => {
      expect(WORKOUT_RUN_CYPHER[mutation]).toContain("datetime(run.claimExpiresAt) > datetime()");
    },
  );

  it("uses opaque run-bound cursors and returns resync after pruning", async () => {
    const repository = new InMemoryWorkoutRunRepository({ cursorSecret: "test-secret", maxEventsPerRun: 1, now: REPOSITORY_NOW });
    await repository.createOrFind(run());
    const claim = await repository.claim(RUN_ID, "worker:one", "2026-08-07T10:00:01.000Z", "2026-08-07T10:01:00.000Z");
    if (claim.status !== "claimed") throw new Error("claim failed");
    await repository.appendEvent(claim.fence, { kind: "stage", occurredAt: "2026-08-07T10:00:02.000Z", safeData: { stage: "resolve" } });
    const initial = await repository.readEvents(RUN_ID, "coach:one", "member:one", { limit: 1 });
    expect(initial.status).toBe("ready");
    if (initial.status !== "ready") return;
    expect(initial.nextCursor).not.toMatch(/^\d+$/);
    const forged = `${initial.nextCursor.slice(0, -1)}${initial.nextCursor.endsWith("a") ? "b" : "a"}`;
    await expect(repository.readEvents(RUN_ID, "coach:one", "member:one", { cursor: forged, limit: 10 }))
      .resolves.toEqual({ status: "not-found" });
    await repository.appendEvent(claim.fence, { kind: "stage", occurredAt: "2026-08-07T10:00:03.000Z", safeData: { stage: "evaluate" } });
    await repository.appendEvent(claim.fence, { kind: "stage", occurredAt: "2026-08-07T10:00:04.000Z", safeData: { stage: "compose" } });
    await expect(repository.readEvents(RUN_ID, "coach:one", "member:one", { cursor: initial.nextCursor, limit: 10 }))
      .resolves.toMatchObject({ status: "resync_required", snapshotUrl: `/api/workout-runs/${RUN_ID}` });
    await expect(repository.readEvents(RUN_ID, "coach:one", "member:other", { cursor: initial.nextCursor, limit: 10 }))
      .resolves.toEqual({ status: "not-found" });
  });

  it("linearizes cancellation before completion and makes completion idempotent", async () => {
    const canceledRepository = new InMemoryWorkoutRunRepository({ cursorSecret: "test-secret", now: REPOSITORY_NOW });
    await canceledRepository.createOrFind(run());
    const canceledClaim = await canceledRepository.claim(RUN_ID, "worker:one", "2026-08-07T10:00:01.000Z", "2026-08-07T10:01:00.000Z");
    if (canceledClaim.status !== "claimed") throw new Error("claim failed");
    await canceledRepository.cancel(RUN_ID, "coach:one", "member:one", "2026-08-07T10:00:04.000Z");
    await expect(canceledRepository.complete(completion(canceledClaim.fence.generation))).resolves.toEqual({ status: "canceled" });
    await expect(canceledRepository.getWorkout(RUN_ID, "coach:one", "member:one")).resolves.toBeUndefined();

    const repository = new InMemoryWorkoutRunRepository({ cursorSecret: "test-secret", now: REPOSITORY_NOW });
    await repository.createOrFind(run());
    const claim = await repository.claim(RUN_ID, "worker:one", "2026-08-07T10:00:01.000Z", "2026-08-07T10:01:00.000Z");
    if (claim.status !== "claimed") throw new Error("claim failed");
    await repository.saveConstraintSnapshot(claim.fence, constraintSnapshot);
    await expect(repository.complete(completion(claim.fence.generation))).resolves.toEqual({ status: "invalid-receipt" });
    await saveCompletionArtifacts(repository, claim.fence);
    await expect(repository.complete(completion(claim.fence.generation))).resolves.toMatchObject({ status: "completed" });
    await expect(repository.complete(completion(claim.fence.generation))).resolves.toMatchObject({ status: "completed" });
    const events = await repository.readEvents(RUN_ID, "coach:one", "member:one", { limit: 20 });
    expect(events.status === "ready" ? events.events.filter(({ event }) => event.kind === "completed") : []).toHaveLength(1);
  });

  it("rejects invalid provenance atomically and supports clarification plus linked retry", async () => {
    const repository = new InMemoryWorkoutRunRepository({ cursorSecret: "test-secret", now: REPOSITORY_NOW });
    await repository.createOrFind(run());
    const claim = await repository.claim(RUN_ID, "worker:one", "2026-08-07T10:00:01.000Z", "2026-08-07T10:01:00.000Z");
    if (claim.status !== "claimed") throw new Error("claim failed");
    await repository.saveConstraintSnapshot(claim.fence, constraintSnapshot);
    await saveCompletionArtifacts(repository, claim.fence);
    const invalid = completion(claim.fence.generation);
    invalid.provenance = { ...invalid.provenance, decisions: [] };
    await expect(repository.complete(invalid)).resolves.toEqual({ status: "invalid-receipt" });
    const mixedRevision = completion(claim.fence.generation);
    mixedRevision.workoutVersion = { ...mixedRevision.workoutVersion, workout: { ...mixedRevision.workoutVersion.workout, movementGraphRevisionId: "movement-revision:changed" } };
    await expect(repository.complete(mixedRevision)).resolves.toEqual({ status: "invalid-receipt" });
    const wrongGrant = { ...completion(claim.fence.generation), authorizationReferenceId: "grant:revoked" };
    await expect(repository.complete(wrongGrant)).resolves.toEqual({ status: "invalid-receipt" });
    const partialProvenance = completion(claim.fence.generation);
    partialProvenance.provenance = { ...partialProvenance.provenance, relations: [] };
    await expect(repository.complete(partialProvenance)).resolves.toEqual({ status: "invalid-receipt" });
    for (const field of ["revisionSealDigest", "safetyEnvelopeDigest", "modelProposalDigest"] as const) {
      const tampered = completion(claim.fence.generation);
      tampered.validationReceipt = { ...tampered.validationReceipt, [field]: "sha256:tampered" };
      await expect(repository.complete(tampered)).resolves.toEqual({ status: "invalid-receipt" });
    }
    await expect(repository.getWorkout(RUN_ID, "coach:one", "member:one")).resolves.toBeUndefined();

    await repository.awaitClarification(claim.fence, "2026-08-07T10:00:03.000Z", ["joint:knee"]);
    await repository.answerClarification(RUN_ID, "coach:one", "member:one", {
      inputRevisionId: asWorkoutInputRevisionId("input:2"),
      revision: 2,
      protectedPromptSnapshotId: "prompt:2",
      promptDigest: "sha256:prompt:2",
      effectiveInputDigest: "sha256:effective:2",
      createdAt: "2026-08-07T10:00:04.000Z",
    });
    await expect(repository.getRun(RUN_ID, "coach:one", "member:one")).resolves.toMatchObject({ state: "queued", inputRevisions: [{ revision: 1 }, { revision: 2 }] });

    const failedClaim = await repository.claim(RUN_ID, "worker:two", "2026-08-07T10:00:05.000Z", "2026-08-07T10:01:00.000Z");
    if (failedClaim.status !== "claimed") throw new Error("claim failed");
    await repository.fail(failedClaim.fence, { kind: "provider-failure", stage: "compose", safeMessage: "Provider unavailable", occurredAt: "2026-08-07T10:00:06.000Z" });
    const retry = run({ runId: asWorkoutRunId("workout-run:retry"), idempotencyKeyDigest: "sha256:retry", retryOfRunId: RUN_ID });
    await expect(repository.createRetry(RUN_ID, "coach:one", "member:one", retry)).resolves.toMatchObject({ status: "created", run: { retryOfRunId: RUN_ID } });
    await expect(repository.getRun(RUN_ID, "coach:one", "member:one")).resolves.toMatchObject({ state: "failed" });
  });
});
