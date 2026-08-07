import type { WorkoutCompletionProjection } from "../ports/workout-run-repository";
import type { ImmutableWorkoutVersion } from "../../domain/contracts/workout";
import type { WorkoutRun } from "../../domain/contracts/workout-run";
import type { WorkoutProvenanceBundle } from "../../domain/contracts/workout-provenance";
import { workoutDecisionWasSelected } from "../../domain/contracts/workout-provenance";
import {
  canonicalWorkoutDecisionSetDigest,
  canonicalWorkoutDigest,
  canonicalWorkoutPayloadDigest,
  canonicalWorkoutProvenanceDigest,
  canonicalWorkoutRevisionSealDigest,
} from "../../graph/schema/workout-run-schema";

export type HistoricalWorkoutTraceInput = {
  readonly run: WorkoutRun;
  readonly workout: ImmutableWorkoutVersion;
  readonly provenance: WorkoutProvenanceBundle;
  readonly completion: WorkoutCompletionProjection;
  readonly sessionAuthorizationId: string;
};

export type CanonicalHistoricalTraceEvidence = {
  readonly status: "ready";
  readonly revisionSeals: WorkoutCompletionProjection["revisionSeals"];
  readonly movementAssertionIds: readonly string[];
  readonly memberCitations: readonly { readonly evidenceId: string; readonly assertionId: string }[];
};

export type CanonicalHistoricalTraceReader = (input: {
  readonly coachId: string;
  readonly memberId: string;
  readonly sessionAuthorizationId: string;
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly assertionIds: readonly string[];
  readonly evidenceIds: readonly string[];
}) => Promise<CanonicalHistoricalTraceEvidence | { readonly status: "unavailable" }>;

const same = (left: unknown, right: unknown) => canonicalWorkoutDigest(left) === canonicalWorkoutDigest(right);
const sortedUnique = (values: readonly string[]) => [...new Set(values)].sort();
const selectedIds = (provenance: WorkoutProvenanceBundle) => sortedUnique(provenance.decisions
  .filter(workoutDecisionWasSelected)
  .map((decision) => decision.exerciseConceptId));
const workoutIds = (workout: ImmutableWorkoutVersion) => sortedUnique(workout.workout.sections
  .flatMap((section) => section.items.map((item) => item.exerciseConceptId)));
const proposalIds = (completion: WorkoutCompletionProjection) => sortedUnique(completion.modelProposal.sections
  .flatMap((section) => section.items.map((item) => item.exerciseConceptId)));

/** Rebind durable completion material before consulting the canonical revisions. */
export function validateHistoricalCompletionBindings(
  run: WorkoutRun,
  workout: ImmutableWorkoutVersion,
  provenance: WorkoutProvenanceBundle,
  completion: WorkoutCompletionProjection,
): boolean {
  const { revisionSeals, safetyEnvelope, modelProposal, validationReceipt: receipt } = completion;
  if (run.state !== "completed" || !run.endedAt || !revisionSeals || !safetyEnvelope || !modelProposal || !receipt
    || revisionSeals.schemaVersion !== "workout-revision-seals/v1"
    || revisionSeals.movementGraphRevisionId !== run.movementGraphRevisionId
    || revisionSeals.memberContextRevisionId !== run.memberContextRevisionId
    || safetyEnvelope.status !== "ready" || safetyEnvelope.authority !== "canonical"
    || safetyEnvelope.movementGraphRevisionId !== run.movementGraphRevisionId
    || safetyEnvelope.memberContextRevisionId !== run.memberContextRevisionId
    || receipt.schemaVersion !== "workout-validation-receipt/v1"
    || receipt.policyVersion !== "workout-composition/v1"
    || receipt.runId !== run.runId
    || !Number.isSafeInteger(receipt.claimGeneration) || receipt.claimGeneration < 1
    || receipt.requestDigest !== run.requestDigest
    || receipt.movementGraphRevisionId !== run.movementGraphRevisionId
    || receipt.memberContextRevisionId !== run.memberContextRevisionId
    || receipt.resolvedConstraintDigest !== run.constraintSnapshot?.digest
    || receipt.revisionSealDigest !== canonicalWorkoutRevisionSealDigest(revisionSeals)
    || receipt.safetyEnvelopeDigest !== canonicalWorkoutDigest(safetyEnvelope)
    || receipt.modelProposalDigest !== canonicalWorkoutDigest(modelProposal)
    || receipt.workoutPayloadDigest !== canonicalWorkoutPayloadDigest(workout)
    || receipt.provenanceDigest !== provenance.digest
    || receipt.provenanceDigest !== canonicalWorkoutProvenanceDigest(provenance)
    || receipt.completeDecisionSetDigest !== canonicalWorkoutDecisionSetDigest(provenance.decisions)
    || receipt.durationPolicyVersion !== workout.workout.durationPolicyVersion
    || workout.version !== 1 || workout.workout.schemaVersion !== "reviewable-workout/v1"
    || workout.workout.runId !== run.runId
    || workout.workout.movementGraphRevisionId !== run.movementGraphRevisionId
    || workout.workout.memberContextRevisionId !== run.memberContextRevisionId
    || provenance.activity.activityId !== run.runId
    || provenance.movementGraphRevisionId !== run.movementGraphRevisionId
    || provenance.memberContextRevisionId !== run.memberContextRevisionId
    || !same(selectedIds(provenance), workoutIds(workout))
    || !same(proposalIds(completion), workoutIds(workout))) return false;

  const workoutEntity = provenance.entities.find((entity) => entity.kind === "workout-version");
  const candidateSetEntity = provenance.entities.find((entity) => entity.kind === "candidate-set");
  const modelProposalEntity = provenance.entities.find((entity) => entity.kind === "model-proposal");
  if (workoutEntity?.entityId !== workout.workoutVersionId
    || candidateSetEntity?.entityId !== `candidate-set:${receipt.safetyEnvelopeDigest}`
    || modelProposalEntity?.entityId !== `model-proposal:${receipt.modelProposalDigest}`
    || provenance.decisions.length !== safetyEnvelope.decisions.length) return false;

  const safetyByExercise = new Map(safetyEnvelope.decisions.map((decision) => [decision.exerciseConceptId, decision]));
  return provenance.decisions.every((decision) => {
    const safety = safetyByExercise.get(decision.exerciseConceptId);
    return safety
      && decision.movementGraphRevisionId === run.movementGraphRevisionId
      && decision.memberContextRevisionId === run.memberContextRevisionId
      && decision.safetyClassification === safety.classification
      && same(decision.sourceAssertionIds, safety.assertionIds)
      && same(decision.contributingPathIds, safety.assertionIds)
      && same(decision.evidenceIds, safety.evidenceIds);
  });
}

export function createVerifyHistoricalWorkoutTrace(dependencies: {
  readonly readCanonicalTraceEvidence: CanonicalHistoricalTraceReader;
}) {
  return async (input: HistoricalWorkoutTraceInput): Promise<boolean> => {
    if (!validateHistoricalCompletionBindings(input.run, input.workout, input.provenance, input.completion)) return false;
    const assertionIds = sortedUnique(input.provenance.decisions
      .flatMap((decision) => [...decision.sourceAssertionIds, ...decision.contributingPathIds]));
    const evidenceIds = sortedUnique(input.provenance.decisions.flatMap((decision) => decision.evidenceIds));
    let canonical: Awaited<ReturnType<CanonicalHistoricalTraceReader>>;
    try {
      canonical = await dependencies.readCanonicalTraceEvidence({
        coachId: input.run.coachId,
        memberId: input.run.memberId,
        sessionAuthorizationId: input.sessionAuthorizationId,
        movementGraphRevisionId: input.run.movementGraphRevisionId,
        memberContextRevisionId: input.run.memberContextRevisionId,
        assertionIds,
        evidenceIds,
      });
    } catch {
      return false;
    }
    if (canonical.status !== "ready" || !same(canonical.revisionSeals, input.completion.revisionSeals)) return false;
    const canonicalEvidenceIds = new Set(canonical.memberCitations.map((citation) => citation.evidenceId));
    const canonicalAssertionIds = new Set([
      ...canonical.movementAssertionIds,
      ...canonical.memberCitations.map((citation) => citation.assertionId),
    ]);
    return evidenceIds.every((id) => canonicalEvidenceIds.has(id))
      && assertionIds.every((id) => canonicalAssertionIds.has(id));
  };
}
