import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asWorkoutInputRevisionId, asWorkoutRunId, asWorkoutVersionId } from "../../src/domain/contracts/workout";
import type { WorkoutRun } from "../../src/domain/contracts/workout-run";
import { createWorkoutProvenanceBundle } from "../../src/domain/contracts/workout-provenance";
import { validateWorkoutComposition } from "../../src/domain/policies/workout-composition";
import { createNeo4jClient, type Neo4jClient } from "../../src/graph/neo4j/client";
import { setupWorkoutRunNeo4jSchema } from "../../src/graph/neo4j/workout-run-schema";
import { Neo4jWorkoutRunRepository } from "../../src/graph/repositories/neo4j-workout-runs";
import { canonicalWorkoutDecisionSetDigest, canonicalWorkoutPayloadDigest, canonicalWorkoutProvenanceDigest } from "../../src/graph/schema/workout-run-schema";
import { validationInput, workoutDecision } from "../fixtures/workout-runtime-builder";

const config = {
  uri: process.env.NEO4J_URI ?? "neo4j://127.0.0.1:7687",
  username: process.env.NEO4J_USERNAME ?? "neo4j",
  password: process.env.NEO4J_PASSWORD ?? "movement-graph-local-test",
  database: process.env.NEO4J_DATABASE ?? "neo4j",
  environment: "test" as const,
};
const RUN_ID = asWorkoutRunId("workout-run:neo4j-contract");

function queuedRun(overrides: Partial<WorkoutRun> = {}): WorkoutRun {
  return {
    runId: RUN_ID,
    coachId: "coach:neo4j",
    memberId: "member:neo4j",
    authorizationReferenceId: "grant:neo4j",
    idempotencyKeyDigest: "sha256:neo4j-key",
    requestDigest: "sha256:request",
    requestedDurationMinutes: 45,
    modelConfigurationId: "model:test",
    policyRevision: "policy:v1",
    movementGraphRevisionId: "movement-revision:workout-test",
    memberContextRevisionId: "member-revision:workout-test",
    state: "queued",
    inputRevisions: [{ inputRevisionId: asWorkoutInputRevisionId("input:neo4j:1"), revision: 1, protectedPromptSnapshotId: "prompt:neo4j:1", promptDigest: "sha256:prompt", effectiveInputDigest: "sha256:effective", createdAt: "2026-08-07T10:00:00.000Z" }],
    activeInputRevisionId: asWorkoutInputRevisionId("input:neo4j:1"),
    ...overrides,
  };
}

describe("Neo4j workout run repository", () => {
  let client: Neo4jClient;
  let repository: Neo4jWorkoutRunRepository;

  beforeAll(async () => {
    client = createNeo4jClient(config);
    await client.verifyConnectivity();
    await setupWorkoutRunNeo4jSchema(client);
  });
  beforeEach(async () => {
    await client.executeWrite(async (transaction) => {
      await transaction.run("MATCH (node) WHERE any(label IN labels(node) WHERE label STARTS WITH 'Workout') DETACH DELETE node");
    });
    await setupWorkoutRunNeo4jSchema(client);
    repository = new Neo4jWorkoutRunRepository(client, { cursorSecret: "integration-cursor-secret" });
  });
  afterAll(async () => { await client.close(); });

  it("persists scoped idempotency, fencing, events, and atomic completion across repository instances", async () => {
    await expect(repository.createOrFind(queuedRun())).resolves.toMatchObject({ status: "created" });
    await expect(repository.createOrFind(queuedRun({ runId: asWorkoutRunId("workout-run:neo4j-replay") })))
      .resolves.toMatchObject({ status: "replayed", run: { runId: RUN_ID } });
    await expect(repository.getRun(RUN_ID, "coach:neo4j", "member:foreign")).resolves.toBeUndefined();

    const claim = await repository.claim(RUN_ID, "worker:neo4j", "2026-08-07T10:00:01.000Z", "2026-08-07T10:01:00.000Z");
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") return;
    await repository.saveConstraintSnapshot(claim.fence, {
      schemaVersion: "resolved-constraint-snapshot/v1",
      movementGraphRevisionId: queuedRun().movementGraphRevisionId,
      memberContextRevisionId: queuedRun().memberContextRevisionId,
      canonicalConstraintIds: ["constraint:test"], applicabilityAssertionIds: ["assertion:test"], evidenceIds: ["evidence:test"],
      zeroMatchCertificates: [], resolverVersion: "resolver:v1", searchPolicyVersion: "search:v1", digest: "sha256:constraints",
    });
    await repository.appendEvent(claim.fence, { kind: "stage", occurredAt: "2026-08-07T10:00:02.000Z", safeData: { stage: "validate" } });

    const validated = validateWorkoutComposition(validationInput());
    if (validated.status !== "valid") throw new Error("fixture must validate");
    const workoutVersion = { workoutVersionId: asWorkoutVersionId("workout-version:neo4j"), version: 1, createdAt: "2026-08-07T10:00:05.000Z", workout: { ...validated.workout, runId: RUN_ID } };
    let provenance = createWorkoutProvenanceBundle({
      runId: RUN_ID, workoutVersionId: workoutVersion.workoutVersionId, promptEntityId: "prompt:neo4j:1", candidateSetEntityId: "candidate:neo4j",
      modelProposalEntityId: "proposal:neo4j", policyEntityId: "policy:v1", movementGraphRevisionId: queuedRun().movementGraphRevisionId,
      memberContextRevisionId: queuedRun().memberContextRevisionId,
      decisions: [workoutDecision("exercise:warm-up"), workoutDecision("exercise:main", "cautioned"), workoutDecision("exercise:cool-down", "downranked")],
      traceSchemaVersion: "workout-provenance/v1", digest: "sha256:provenance",
    });
    const provenanceDigest = canonicalWorkoutProvenanceDigest(provenance);
    provenance = { ...provenance, digest: provenanceDigest };
    const completion = { fence: claim.fence, authorizationReferenceId: "grant:neo4j", workoutVersion, provenance, validationReceipt: {
      ...validated.receipt,
      runId: RUN_ID,
      claimGeneration: claim.fence.generation,
      completeDecisionSetDigest: canonicalWorkoutDecisionSetDigest(provenance.decisions),
      workoutPayloadDigest: canonicalWorkoutPayloadDigest(workoutVersion),
      provenanceDigest,
    } };
    await expect(repository.complete(completion)).resolves.toMatchObject({ status: "completed", run: { state: "completed" } });
    await expect(repository.complete(completion)).resolves.toMatchObject({ status: "completed" });

    const restarted = new Neo4jWorkoutRunRepository(client, { cursorSecret: "integration-cursor-secret" });
    await expect(restarted.getWorkout(RUN_ID, "coach:neo4j", "member:neo4j")).resolves.toMatchObject({ workoutVersionId: "workout-version:neo4j" });
    await expect(restarted.getProvenance(RUN_ID, "coach:neo4j", "member:neo4j")).resolves.toEqual(provenance);
    const events = await restarted.readEvents(RUN_ID, "coach:neo4j", "member:neo4j", { limit: 20 });
    expect(events.status === "ready" ? events.events.filter((event) => event.kind === "completed") : []).toHaveLength(1);
  });
});
