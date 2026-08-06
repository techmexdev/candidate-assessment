import type {
  MatchedClinicalRulePath,
  MovementLaterality,
  MovementSafetyContributingPath,
  MovementSafetyPolicyInput,
  MovementSafetyResult,
} from "../contracts/movement-safety";

const effectPriority = Object.freeze({ "hard-contraindication": 0, caution: 1, "down-rank": 2 });
const lateralities = new Set<MovementLaterality>(["left", "right", "bilateral", "unknown"]);

function lateralityApplies(
  policy: MatchedClinicalRulePath["applicability"]["lateralityPolicy"],
  affected: MovementLaterality,
  loaded: MovementLaterality,
) {
  if (policy === "either-side") return true;
  if (affected === "bilateral" || loaded === "bilateral" || affected === "unknown" || loaded === "unknown") return true;
  return affected === loaded;
}

function applies(path: MatchedClinicalRulePath, context: MovementSafetyPolicyInput["evaluations"][number]["context"]) {
  return path.applicability.conditionStatuses.includes(context.conditionStatus!)
    && path.applicability.recoveryStages.includes(context.recoveryStage!)
    && path.applicability.severityBands.includes(context.severityBand!)
    && lateralityApplies(path.applicability.lateralityPolicy, context.affectedLaterality, context.loadedLaterality);
}

function contributingPath(path: MatchedClinicalRulePath): MovementSafetyContributingPath {
  return {
    conditionConceptId: path.conditionConceptId,
    ruleConceptId: path.ruleConceptId,
    targetConceptId: path.targetConceptId,
    effect: path.effect,
    assertionIds: [...new Set([...path.pathAssertionIds, ...path.exercisePathAssertionIds, ...path.mappingAssertionIds, ...path.evidenceAssertionIds])].sort(),
    ruleAssertionIds: [path.ruleAssertionId],
    mappingAssertionIds: [...new Set(path.mappingAssertionIds)].sort(),
    evidenceAssertionIds: [...new Set(path.evidenceAssertionIds)].sort(),
  };
}

export function decideMovementSafety(input: MovementSafetyPolicyInput): MovementSafetyResult {
  if (input.authority !== "canonical") {
    return { status: "fail_closed", graphRevisionId: input.graphRevisionId, authority: input.authority, exerciseConceptId: input.exerciseConceptId, reason: "non_authoritative_graph", assertionIds: [] };
  }
  const relevant = input.evaluations.filter((evaluation) => evaluation.matchedPaths.length > 0);
  if (relevant.some(({ context, matchedPaths }) => !context.conditionStatus || !context.recoveryStage || !context.severityBand
    || matchedPaths.some((path) => path.applicability.lateralityPolicy !== "either-side"
      && (!lateralities.has(context.affectedLaterality) || !lateralities.has(context.loadedLaterality))))) {
    return { status: "fail_closed", graphRevisionId: input.graphRevisionId, authority: input.authority, exerciseConceptId: input.exerciseConceptId, reason: "insufficient_member_context", assertionIds: [input.exerciseAssertionId] };
  }

  const paths = relevant.flatMap(({ context, matchedPaths }) => matchedPaths.filter((path) => applies(path, context)))
    .sort((left, right) => effectPriority[left.effect] - effectPriority[right.effect]
      || left.ruleConceptId.localeCompare(right.ruleConceptId)
      || left.targetConceptId.localeCompare(right.targetConceptId));
  const contributingPaths = paths.map(contributingPath);
  const assertionIds = [...new Set([input.exerciseAssertionId, ...contributingPaths.flatMap((path) => path.assertionIds)])].sort();
  const strongest = paths[0]?.effect;
  const status = strongest === "hard-contraindication" ? "excluded"
    : strongest === "caution" ? "caution"
      : strongest === "down-rank" ? "downranked" : "allowed";
  return {
    status,
    graphRevisionId: input.graphRevisionId,
    authority: input.authority,
    exerciseConceptId: input.exerciseConceptId,
    exerciseAssertionId: input.exerciseAssertionId,
    contributingPaths,
    assertionIds,
  };
}
