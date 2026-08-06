import type {
  ClinicalRuleFact,
  ExerciseConstraintFact,
  MovementGraphReadHandle,
  MovementGraphReadProvider,
  MovementGraphReadFailure,
} from "../../domain/contracts/movement-clinical-queries";
import type {
  MatchedClinicalRulePath,
  MovementSafetyRequest,
  MovementSafetyResult,
} from "../../domain/contracts/movement-safety";
import { decideMovementSafety } from "../../domain/policies/movement-safety";

export const MOVEMENT_SAFETY_QUERY_LIMITS = Object.freeze({ maxConditions: 8, maxExerciseFacts: 32, maxRules: 32, maxAnatomyDepth: 4, maxAnatomyPaths: 32 });

function fail(
  request: MovementSafetyRequest,
  reason: Extract<MovementSafetyResult, { status: "fail_closed" }>["reason"],
  handle?: MovementGraphReadHandle,
): MovementSafetyResult {
  return {
    status: "fail_closed",
    graphRevisionId: handle?.graphRevisionId ?? request.graphRevisionId,
    authority: handle?.authority,
    exerciseConceptId: request.exerciseConceptId,
    reason,
    assertionIds: [],
  };
}

function failureReason(failure: MovementGraphReadFailure, unresolved: "unresolved_exercise" | "unresolved_condition") {
  if (failure.code === "unresolved_concept") return unresolved;
  if (failure.code === "traversal_limit_exceeded") return "query_limit_exceeded" as const;
  if (failure.code === "broken_assertion") return "broken_rule_path" as const;
  if (failure.code === "invalid_query") return "invalid_input" as const;
  return "graph_unavailable" as const;
}

async function matchRuleToExercise(
  handle: MovementGraphReadHandle,
  exercise: ExerciseConstraintFact,
  rule: ClinicalRuleFact,
): Promise<MatchedClinicalRulePath | Extract<MovementSafetyResult, { status: "fail_closed" }> | undefined> {
  const directKind = rule.targetKind === "movement-demand" ? "has-demand"
    : rule.targetKind === "movement-pattern" ? "expresses" : undefined;
  if (directKind) {
    const relation = exercise.relations.find((fact) => fact.kind === directKind && fact.targetConceptId === rule.targetConceptId);
    return relation ? { ...rule, exercisePathAssertionIds: [exercise.exerciseAssertionId, relation.edgeAssertionId, relation.targetAssertionId] } : undefined;
  }

  const stresses = exercise.relations.filter((fact) => fact.kind === "stresses");
  if (stresses.length === 0) return undefined;
  const anatomy = await handle.getAnatomyPaths({
    conceptId: rule.targetConceptId,
    includeSelf: true,
    maxDepth: MOVEMENT_SAFETY_QUERY_LIMITS.maxAnatomyDepth,
    maxResults: MOVEMENT_SAFETY_QUERY_LIMITS.maxAnatomyPaths,
  });
  if (anatomy.status !== "ok") {
    return {
      status: "fail_closed",
      graphRevisionId: handle.graphRevisionId,
      authority: handle.authority,
      exerciseConceptId: exercise.exerciseConceptId,
      reason: failureReason(anatomy.failure, "unresolved_condition"),
      assertionIds: [],
    };
  }
  for (const stress of stresses) {
    const path = anatomy.data.find((fact) => fact.descendantConceptId === stress.targetConceptId);
    if (path) return {
      ...rule,
      exercisePathAssertionIds: [exercise.exerciseAssertionId, stress.edgeAssertionId, stress.targetAssertionId, ...path.nodeAssertionIds, ...path.edgeAssertionIds],
    };
  }
  return undefined;
}

export async function evaluateMovementSafetyWithHandle(
  handle: MovementGraphReadHandle,
  request: MovementSafetyRequest,
): Promise<MovementSafetyResult> {
  if (handle.authority !== "canonical") return fail(request, "non_authoritative_graph", handle);
  if (!request.exerciseConceptId || request.conditions.length > MOVEMENT_SAFETY_QUERY_LIMITS.maxConditions) return fail(request, "invalid_input", handle);

  const exerciseResult = await handle.getExerciseConstraintFacts({ exerciseConceptId: request.exerciseConceptId, maxResults: MOVEMENT_SAFETY_QUERY_LIMITS.maxExerciseFacts });
  if (exerciseResult.status !== "ok") return fail(request, failureReason(exerciseResult.failure, "unresolved_exercise"), handle);
  return evaluateMovementSafetyFactsWithHandle(handle, request, exerciseResult.data);
}

export async function evaluateMovementSafetyFactsWithHandle(
  handle: MovementGraphReadHandle,
  request: MovementSafetyRequest,
  exercise: ExerciseConstraintFact,
): Promise<MovementSafetyResult> {
  if (handle.authority !== "canonical") return fail(request, "non_authoritative_graph", handle);
  if (!request.exerciseConceptId || request.conditions.length > MOVEMENT_SAFETY_QUERY_LIMITS.maxConditions) return fail(request, "invalid_input", handle);
  if (exercise.exerciseConceptId !== request.exerciseConceptId) return fail(request, "unresolved_exercise", handle);

  const evaluations = [];
  for (const context of request.conditions) {
    const rulesResult = await handle.getClinicalRuleFacts({ conditionConceptId: context.conditionConceptId, maxResults: MOVEMENT_SAFETY_QUERY_LIMITS.maxRules });
    if (rulesResult.status !== "ok") return fail(request, failureReason(rulesResult.failure, "unresolved_condition"), handle);
    const matchedPaths: MatchedClinicalRulePath[] = [];
    for (const rule of rulesResult.data) {
      const matched = await matchRuleToExercise(handle, exercise, rule);
      if (matched && "status" in matched) return matched;
      if (matched) matchedPaths.push(matched);
    }
    evaluations.push({ context, matchedPaths });
  }
  return decideMovementSafety({
    graphRevisionId: handle.graphRevisionId,
    authority: handle.authority,
    exerciseConceptId: exercise.exerciseConceptId,
    exerciseAssertionId: exercise.exerciseAssertionId,
    evaluations,
  });
}

export async function evaluateMovementSafety(
  provider: MovementGraphReadProvider,
  request: MovementSafetyRequest,
): Promise<MovementSafetyResult> {
  const opened = request.graphRevisionId
    ? await provider.openRevision(request.graphRevisionId)
    : await provider.openActive();
  return opened.status === "ready"
    ? evaluateMovementSafetyWithHandle(opened.handle, request)
    : fail(request, "graph_unavailable");
}
