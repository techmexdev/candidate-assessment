import type { MovementGraphReadHandle, MovementGraphReadProvider } from "../../domain/contracts/movement-clinical-queries";
import type {
  MovementSubstitutionRequest,
  MovementSubstitutionResult,
  MovementSubstitutionPolicyCandidate,
} from "../../domain/policies/movement-substitution";
import { rankMovementSubstitutes } from "../../domain/policies/movement-substitution";
import { evaluateMovementSafetyWithHandle } from "./evaluate-movement-safety";

export const MOVEMENT_SUBSTITUTION_LIMITS = Object.freeze({ maxCandidates: 16, maxEquipment: 32, maxExclusions: 32, maxExerciseFacts: 32 });

function noAlternative(
  request: MovementSubstitutionRequest,
  reason: Extract<MovementSubstitutionResult, { status: "no_safe_alternative" }>["reason"],
  handle?: MovementGraphReadHandle,
): MovementSubstitutionResult {
  return {
    status: "no_safe_alternative",
    graphRevisionId: handle?.graphRevisionId ?? request.graphRevisionId,
    authority: handle?.authority,
    originalExerciseConceptId: request.exerciseConceptId,
    reason,
    assertionIds: [],
  };
}

export async function findMovementSubstitutes(
  provider: MovementGraphReadProvider,
  request: MovementSubstitutionRequest,
): Promise<MovementSubstitutionResult> {
  if (!request.exerciseConceptId
    || request.availableEquipmentConceptIds.length > MOVEMENT_SUBSTITUTION_LIMITS.maxEquipment
    || request.excludedExerciseConceptIds.length > MOVEMENT_SUBSTITUTION_LIMITS.maxExclusions
    || (request.candidateExerciseConceptIds?.length ?? 0) > MOVEMENT_SUBSTITUTION_LIMITS.maxCandidates) {
    return noAlternative(request, "invalid_input");
  }
  const opened = request.graphRevisionId
    ? await provider.openRevision(request.graphRevisionId)
    : await provider.openActive();
  if (opened.status !== "ready") return noAlternative(request, "graph_unavailable");
  const { handle } = opened;
  if (handle.authority !== "canonical") return noAlternative(request, "non_authoritative_graph", handle);

  const original = await handle.getExerciseConstraintFacts({ exerciseConceptId: request.exerciseConceptId, maxResults: MOVEMENT_SUBSTITUTION_LIMITS.maxExerciseFacts });
  if (original.status !== "ok") return noAlternative(request, original.failure.code === "unresolved_concept" ? "unresolved_original" : "graph_unavailable", handle);
  const reviewed = await handle.getSubstitutionCandidates({ exerciseConceptId: request.exerciseConceptId, maxResults: MOVEMENT_SUBSTITUTION_LIMITS.maxCandidates });
  if (reviewed.status !== "ok") return noAlternative(request, "graph_unavailable", handle);

  const requestedCandidates = request.candidateExerciseConceptIds ? new Set(request.candidateExerciseConceptIds) : undefined;
  const selectedReviews = requestedCandidates
    ? reviewed.data.filter((candidate) => requestedCandidates.has(candidate.exerciseConceptId))
    : reviewed.data;
  if (selectedReviews.length === 0) return noAlternative(request, "no_reviewed_candidate", handle);

  const candidates: MovementSubstitutionPolicyCandidate[] = [];
  for (const review of selectedReviews) {
    const facts = await handle.getExerciseConstraintFacts({ exerciseConceptId: review.exerciseConceptId, maxResults: MOVEMENT_SUBSTITUTION_LIMITS.maxExerciseFacts });
    if (facts.status !== "ok") continue;
    const safety = await evaluateMovementSafetyWithHandle(handle, {
      graphRevisionId: handle.graphRevisionId,
      exerciseConceptId: review.exerciseConceptId,
      conditions: request.conditions,
    });
    candidates.push({ review, requiredEquipment: facts.data.relations.filter((relation) => relation.kind === "requires"), safety });
  }
  return rankMovementSubstitutes({
    graphRevisionId: handle.graphRevisionId,
    authority: handle.authority,
    originalExerciseConceptId: original.data.exerciseConceptId,
    availableEquipmentConceptIds: request.availableEquipmentConceptIds,
    excludedExerciseConceptIds: request.excludedExerciseConceptIds,
    candidates,
  });
}
