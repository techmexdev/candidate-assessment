import type {
  ExerciseConstraintRelationFact,
  SubstitutionCandidateFact,
} from "../contracts/movement-clinical-queries";
import type { MovementSafetyContext, MovementSafetyResult } from "../contracts/movement-safety";
import type { GraphAuthority } from "../contracts/movement-graph";

export type MovementSubstitutionRequest = {
  readonly graphRevisionId?: string;
  readonly exerciseConceptId: string;
  readonly candidateExerciseConceptIds?: readonly string[];
  readonly availableEquipmentConceptIds: readonly string[];
  readonly excludedExerciseConceptIds: readonly string[];
  readonly conditions: readonly MovementSafetyContext[];
};

export type MovementSubstitutionPolicyCandidate = {
  readonly review: SubstitutionCandidateFact;
  readonly requiredEquipment: readonly ExerciseConstraintRelationFact[];
  readonly safety: MovementSafetyResult;
};

export type MovementSubstitutionPolicyInput = {
  readonly graphRevisionId: string;
  readonly authority: GraphAuthority;
  readonly originalExerciseConceptId: string;
  readonly availableEquipmentConceptIds: readonly string[];
  readonly excludedExerciseConceptIds: readonly string[];
  readonly candidates: readonly MovementSubstitutionPolicyCandidate[];
};

export type RankedMovementSubstitute = {
  readonly exerciseConceptId: string;
  readonly rank: number;
  readonly preservedIntent: string;
  readonly safetyStatus: "allowed" | "caution" | "downranked";
  readonly assertionIds: readonly string[];
  readonly safetyEvidenceIds?: readonly string[];
};

export type MovementSubstitutionResult =
  | {
      readonly status: "substitutes_found";
      readonly graphRevisionId: string;
      readonly authority: "canonical";
      readonly originalExerciseConceptId: string;
      readonly candidates: readonly RankedMovementSubstitute[];
      readonly assertionIds: readonly string[];
    }
  | {
      readonly status: "no_safe_alternative";
      readonly graphRevisionId?: string;
      readonly authority?: GraphAuthority;
      readonly originalExerciseConceptId: string;
      readonly reason: "graph_unavailable" | "non_authoritative_graph" | "unresolved_original" | "no_reviewed_candidate" | "no_safe_candidate" | "invalid_input";
      readonly assertionIds: readonly string[];
    };

const safetyPriority = Object.freeze({ allowed: 0, caution: 1, downranked: 2 });

export function rankMovementSubstitutes(input: MovementSubstitutionPolicyInput): MovementSubstitutionResult {
  if (input.authority !== "canonical") {
    return { status: "no_safe_alternative", graphRevisionId: input.graphRevisionId, authority: input.authority, originalExerciseConceptId: input.originalExerciseConceptId, reason: "non_authoritative_graph", assertionIds: [] };
  }
  const equipment = new Set(input.availableEquipmentConceptIds);
  const excluded = new Set(input.excludedExerciseConceptIds);
  const eligible = input.candidates.flatMap((candidate): RankedMovementSubstitute[] => {
    const { review, safety } = candidate;
    if (!review.substitutionAssertionId || excluded.has(review.exerciseConceptId)) return [];
    if (candidate.requiredEquipment.some((fact) => !equipment.has(fact.targetConceptId))) return [];
    if (safety.status !== "allowed" && safety.status !== "caution" && safety.status !== "downranked") return [];
    return [{
      exerciseConceptId: review.exerciseConceptId,
      rank: review.rank,
      preservedIntent: review.preservedIntent,
      safetyStatus: safety.status,
      assertionIds: [...new Set([
        review.exerciseAssertionId,
        review.substitutionAssertionId,
        ...candidate.requiredEquipment.flatMap((fact) => [fact.edgeAssertionId, fact.targetAssertionId]),
        ...safety.assertionIds,
      ])].sort(),
      safetyEvidenceIds: [...new Set(safety.contributingPaths.flatMap((path) => path.sourceEvidenceId ? [path.sourceEvidenceId] : []))].sort(),
    }];
  }).sort((left, right) => safetyPriority[left.safetyStatus] - safetyPriority[right.safetyStatus]
    || left.rank - right.rank
    || left.exerciseConceptId.localeCompare(right.exerciseConceptId));

  if (eligible.length === 0) {
    return { status: "no_safe_alternative", graphRevisionId: input.graphRevisionId, authority: input.authority, originalExerciseConceptId: input.originalExerciseConceptId, reason: input.candidates.length === 0 ? "no_reviewed_candidate" : "no_safe_candidate", assertionIds: [] };
  }
  return {
    status: "substitutes_found",
    graphRevisionId: input.graphRevisionId,
    authority: input.authority,
    originalExerciseConceptId: input.originalExerciseConceptId,
    candidates: eligible,
    assertionIds: [...new Set(eligible.flatMap((candidate) => candidate.assertionIds))].sort(),
  };
}
