import { describe, expect, it, vi } from "vitest";
import { asWorkoutInputRevisionId, asWorkoutRunId, asWorkoutVersionId } from "../../src/domain/contracts/workout";
import type { WorkoutRun } from "../../src/domain/contracts/workout-run";
import { createWorkoutProvenanceBundle } from "../../src/domain/contracts/workout-provenance";
import { createRetrieveWorkoutRun } from "../../src/application/use-cases/retrieve-workout-run";
import {
  createVerifyHistoricalWorkoutTrace,
  validateHistoricalCompletionBindings,
} from "../../src/application/use-cases/verify-historical-workout-trace";
import type { WorkoutRunRepository } from "../../src/application/ports/workout-run-repository";
import type { WorkerAuthorizationPort } from "../../src/application/ports/worker-authorization";
import { validateWorkoutComposition } from "../../src/domain/policies/workout-composition";
import {
  canonicalWorkoutDecisionSetDigest,
  canonicalWorkoutDigest,
  canonicalWorkoutPayloadDigest,
  canonicalWorkoutProvenanceDigest,
} from "../../src/graph/schema/workout-run-schema";
import { catalogResult, validationInput } from "../fixtures/workout-runtime-builder";

const runId = asWorkoutRunId("workout-run:historical-integrity");
const movementGraphRevisionId = "movement-revision:workout-test";
const memberContextRevisionId = "member-revision:workout-test";

function fixture() {
  const source = validationInput();
  const validated = validateWorkoutComposition(source);
  if (validated.status !== "valid" || source.catalogSafety.status !== "ready") throw new Error("fixture must validate");
  const run: WorkoutRun = {
    runId,
    coachId: "coach:one",
    memberId: "member:one",
    authorizationReferenceId: "grant:one",
    idempotencyKeyDigest: "sha256:idempotency",
    requestDigest: "sha256:request",
    requestedDurationMinutes: 45,
    modelConfigurationId: "model:test",
    policyRevision: "policy:v1",
    movementGraphRevisionId,
    memberContextRevisionId,
    state: "completed",
    inputRevisions: [{
      inputRevisionId: asWorkoutInputRevisionId("input:one"),
      revision: 1,
      protectedPromptSnapshotId: "prompt:one",
      promptDigest: "sha256:prompt",
      effectiveInputDigest: "sha256:effective",
      createdAt: "2026-08-07T10:00:00.000Z",
    }],
    activeInputRevisionId: asWorkoutInputRevisionId("input:one"),
    constraintSnapshot: {
      schemaVersion: "resolved-constraint-snapshot/v1",
      movementGraphRevisionId,
      memberContextRevisionId,
      canonicalConstraintIds: ["constraint:one"],
      applicabilityAssertionIds: ["assertion:applicability"],
      evidenceIds: ["evidence:exercise:main"],
      zeroMatchCertificates: [],
      resolverVersion: "resolver:v1",
      searchPolicyVersion: "search:v1",
      digest: "sha256:constraints",
    },
    startedAt: "2026-08-07T10:00:01.000Z",
    endedAt: "2026-08-07T10:05:00.000Z",
  };
  const workout = {
    workoutVersionId: asWorkoutVersionId("workout-version:historical-integrity"),
    version: 1 as const,
    createdAt: run.endedAt!,
    workout: { ...validated.workout, runId },
  };
  const selected = new Set(workout.workout.sections.flatMap((section) => section.items.map((item) => item.exerciseConceptId)));
  const decisions = source.catalogSafety.decisions.map((decision) => ({
    decisionId: `decision:${decision.exerciseConceptId}`,
    kind: decision.classification === "excluded" ? "excluded" as const
      : decision.classification === "caution" ? "cautioned" as const
        : decision.classification === "downranked" ? "downranked" as const
          : selected.has(decision.exerciseConceptId) ? "selected" as const : "not-selected" as const,
    selectionDisposition: selected.has(decision.exerciseConceptId) ? "selected" as const : "not-selected" as const,
    safetyClassification: decision.classification,
    exerciseConceptId: decision.exerciseConceptId,
    movementGraphRevisionId,
    memberContextRevisionId,
    sourceAssertionIds: [...decision.assertionIds],
    contributingPathIds: [...decision.assertionIds],
    evidenceIds: [...decision.evidenceIds],
    explanation: "canonical safety decision",
  }));
  const revisionSeals = {
    schemaVersion: "workout-revision-seals/v1" as const,
    movementGraphRevisionId,
    movementGraphSealId: "movement-seal:one",
    movementGraphSealDigest: "sha256:movement-seal",
    memberContextRevisionId,
    memberContextSealId: "member-seal:one",
    memberContextSealDigest: "sha256:member-seal",
  };
  const safetyEnvelope = source.catalogSafety;
  const modelProposal = source.proposal;
  let provenance = createWorkoutProvenanceBundle({
    runId,
    workoutVersionId: workout.workoutVersionId,
    promptEntityId: "prompt:one",
    candidateSetEntityId: `candidate-set:${canonicalWorkoutDigest(safetyEnvelope)}`,
    modelProposalEntityId: `model-proposal:${canonicalWorkoutDigest(modelProposal)}`,
    policyEntityId: "policy:v1",
    movementGraphRevisionId,
    memberContextRevisionId,
    decisions,
    traceSchemaVersion: "workout-provenance/v1",
    digest: "sha256:pending",
  });
  provenance = { ...provenance, digest: canonicalWorkoutProvenanceDigest(provenance) };
  const validationReceipt = {
    ...validated.receipt,
    runId,
    claimGeneration: 1,
    requestDigest: run.requestDigest,
    movementGraphRevisionId,
    memberContextRevisionId,
    revisionSealDigest: canonicalWorkoutDigest(revisionSeals),
    resolvedConstraintDigest: run.constraintSnapshot!.digest,
    safetyEnvelopeDigest: canonicalWorkoutDigest(safetyEnvelope),
    completeDecisionSetDigest: canonicalWorkoutDecisionSetDigest(provenance.decisions),
    modelProposalDigest: canonicalWorkoutDigest(modelProposal),
    workoutPayloadDigest: canonicalWorkoutPayloadDigest(workout),
    provenanceDigest: provenance.digest,
  };
  const completion = { revisionSeals, safetyEnvelope, modelProposal, validationReceipt };
  return { run, workout, provenance, completion };
}

function accessDependencies(value = fixture()) {
  const repository = {
    getRun: vi.fn(async () => value.run),
    getWorkout: vi.fn(async () => value.workout),
    getProvenance: vi.fn(async () => value.provenance),
    getCompletionProjection: vi.fn(async () => value.completion),
  } as unknown as WorkoutRunRepository;
  const authorization: WorkerAuthorizationPort = {
    authorizeSession: vi.fn(async () => ({ status: "authorized" as const, authorizationId: "session:one" })),
    authorize: vi.fn(async () => ({ status: "authorized" as const, authorizationId: "grant:one" })),
    createReference: vi.fn(async () => ({ status: "denied" as const })),
  };
  return { repository, authorization };
}

describe("historical workout trace verification", () => {
  it("returns a completed resource only after the persisted projection and canonical trace pass", async () => {
    const value = fixture();
    const dependencies = accessDependencies(value);
    const verifyHistoricalTrace = vi.fn(async () => true);
    const retrieve = createRetrieveWorkoutRun({ ...dependencies, verifyHistoricalTrace });

    await expect(retrieve({
      runId,
      coachId: "coach:one",
      memberId: "member:one",
      sessionAuthorizationId: "session:one",
    })).resolves.toMatchObject({
      status: "ready",
      resource: { state: "completed", workout: value.workout, provenance: value.provenance },
    });
    expect(dependencies.repository.getCompletionProjection).toHaveBeenCalledWith(runId, "coach:one", "member:one");
    expect(verifyHistoricalTrace).toHaveBeenCalledWith(expect.objectContaining({
      run: value.run,
      completion: value.completion,
      sessionAuthorizationId: "session:one",
    }));
  });

  it("fails closed when completed-read verification is not configured", async () => {
    const dependencies = accessDependencies();
    const retrieve = createRetrieveWorkoutRun(dependencies);

    await expect(retrieve({
      runId,
      coachId: "coach:one",
      memberId: "member:one",
      sessionAuthorizationId: "session:one",
    })).resolves.toEqual({ status: "integrity-failure" });
  });

  it("rejects a self-consistent provenance rewrite whose assertion is outside the pinned revisions", async () => {
    const value = fixture();
    const safetyEnvelope = catalogResult(value.completion.safetyEnvelope.decisions.map((decision, index) => index === 0
      ? { ...decision, assertionIds: ["assertion:forged", ...decision.assertionIds.slice(1)] }
      : decision));
    const candidateSetEntityId = `candidate-set:${canonicalWorkoutDigest(safetyEnvelope)}`;
    const previousCandidateSetEntityId = value.provenance.entities.find((entity) => entity.kind === "candidate-set")!.entityId;
    const altered = {
      ...value.provenance,
      decisions: value.provenance.decisions.map((decision, index) => index === 0
        ? {
            ...decision,
            sourceAssertionIds: ["assertion:forged", ...decision.sourceAssertionIds.slice(1)],
            contributingPathIds: ["assertion:forged", ...decision.contributingPathIds.slice(1)],
          }
        : decision),
      entities: value.provenance.entities.map((entity) => entity.kind === "candidate-set"
        ? { ...entity, entityId: candidateSetEntityId }
        : entity),
      relations: value.provenance.relations.map((relation) => {
        if (relation.kind === "used" && relation.entityId === previousCandidateSetEntityId) {
          return { ...relation, entityId: candidateSetEntityId };
        }
        if (relation.kind === "wasDerivedFrom" && relation.sourceEntityId === previousCandidateSetEntityId) {
          return { ...relation, sourceEntityId: candidateSetEntityId };
        }
        return relation;
      }),
    };
    const provenance = { ...altered, digest: canonicalWorkoutProvenanceDigest(altered) };
    const completion = {
      ...value.completion,
      safetyEnvelope,
      validationReceipt: {
        ...value.completion.validationReceipt,
        safetyEnvelopeDigest: canonicalWorkoutDigest(safetyEnvelope),
        provenanceDigest: provenance.digest,
        completeDecisionSetDigest: canonicalWorkoutDecisionSetDigest(provenance.decisions),
      },
    };
    const verify = createVerifyHistoricalWorkoutTrace({
      readCanonicalTraceEvidence: vi.fn(async () => ({
        status: "ready" as const,
        revisionSeals: value.completion.revisionSeals,
        movementAssertionIds: value.provenance.decisions.flatMap((decision) => [...decision.sourceAssertionIds, ...decision.contributingPathIds]),
        memberCitations: value.provenance.decisions.flatMap((decision) => decision.evidenceIds.map((evidenceId) => ({
          evidenceId,
          assertionId: decision.sourceAssertionIds[0]!,
        }))),
      })),
    });

    expect(validateHistoricalCompletionBindings(value.run, value.workout, provenance, completion)).toBe(true);
    await expect(verify({
      run: value.run,
      workout: value.workout,
      provenance,
      completion,
      sessionAuthorizationId: "session:one",
    })).resolves.toBe(false);
  });

  it("rejects recomputed artifact bindings when the pinned canonical seal does not match", async () => {
    const value = fixture();
    const revisionSeals = { ...value.completion.revisionSeals, movementGraphSealDigest: "sha256:forged" };
    const completion = {
      ...value.completion,
      revisionSeals,
      validationReceipt: {
        ...value.completion.validationReceipt,
        revisionSealDigest: canonicalWorkoutDigest(revisionSeals),
      },
    };
    const verify = createVerifyHistoricalWorkoutTrace({
      readCanonicalTraceEvidence: vi.fn(async () => ({
        status: "ready" as const,
        revisionSeals: value.completion.revisionSeals,
        movementAssertionIds: value.provenance.decisions.flatMap((decision) => [...decision.sourceAssertionIds, ...decision.contributingPathIds]),
        memberCitations: value.provenance.decisions.flatMap((decision) => decision.evidenceIds.map((evidenceId) => ({
          evidenceId,
          assertionId: decision.sourceAssertionIds[0]!,
        }))),
      })),
    });

    expect(validateHistoricalCompletionBindings(value.run, value.workout, value.provenance, completion)).toBe(true);
    await expect(verify({
      run: value.run,
      workout: value.workout,
      provenance: value.provenance,
      completion,
      sessionAuthorizationId: "session:one",
    })).resolves.toBe(false);
  });
});
