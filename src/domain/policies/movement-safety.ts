import type {
  MatchedClinicalRulePath,
  MovementLaterality,
  MovementSafetyContributingPath,
  MovementSafetyPolicyInput,
  MovementSafetyResult,
} from "../contracts/movement-safety";
import type { ClinicalRuleFact } from "../contracts/movement-clinical-queries";

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

export function hasSufficientMovementSafetyContext(
  rule: Pick<ClinicalRuleFact, "applicability">,
  context: MovementSafetyPolicyInput["evaluations"][number]["context"],
) {
  return Boolean(context.conditionStatus && context.recoveryStage && context.severityBand)
    && (rule.applicability.lateralityPolicy === "either-side"
      || (lateralities.has(context.affectedLaterality) && lateralities.has(context.loadedLaterality)));
}

export function clinicalRuleApplies(
  path: Pick<ClinicalRuleFact, "applicability">,
  context: MovementSafetyPolicyInput["evaluations"][number]["context"],
) {
  if (!hasSufficientMovementSafetyContext(path, context)) return false;
  return path.applicability.conditionStatuses.includes(context.conditionStatus!)
    && path.applicability.recoveryStages.includes(context.recoveryStage!)
    && path.applicability.severityBands.includes(context.severityBand!)
    && lateralityApplies(path.applicability.lateralityPolicy, context.affectedLaterality, context.loadedLaterality);
}

function contributingPath(
  path: MatchedClinicalRulePath,
  context: MovementSafetyPolicyInput["evaluations"][number]["context"],
): MovementSafetyContributingPath {
  return {
    conditionConceptId: path.conditionConceptId,
    affectedAnatomyConceptId: path.affectedAnatomyConceptId,
    ruleConceptId: path.ruleConceptId,
    targetConceptId: path.targetConceptId,
    effect: path.effect,
    assertionIds: [...new Set([...path.pathAssertionIds, ...path.exercisePathAssertionIds, ...path.affectedAnatomyPathAssertionIds, ...path.mappingAssertionIds, ...path.evidenceAssertionIds])].sort(),
    ruleAssertionIds: [path.ruleAssertionId],
    mappingAssertionIds: [...new Set(path.mappingAssertionIds)].sort(),
    evidenceAssertionIds: [...new Set(path.evidenceAssertionIds)].sort(),
    affectedAnatomyPathAssertionIds: [...new Set(path.affectedAnatomyPathAssertionIds)].sort(),
    ...(context.sourceKey ? { sourceKey: context.sourceKey } : {}),
    ...(context.sourceAssertionId ? { sourceAssertionId: context.sourceAssertionId } : {}),
    ...(context.sourceEvidenceId ? { sourceEvidenceId: context.sourceEvidenceId } : {}),
  };
}

export function decideMovementSafety(input: MovementSafetyPolicyInput): MovementSafetyResult {
  if (input.authority !== "canonical") {
    return { status: "fail_closed", graphRevisionId: input.graphRevisionId, authority: input.authority, exerciseConceptId: input.exerciseConceptId, reason: "non_authoritative_graph", assertionIds: [] };
  }
  const relevant = input.evaluations.filter((evaluation) => evaluation.matchedPaths.length > 0);
  if (relevant.some(({ context, matchedPaths }) => matchedPaths.some((path) => !hasSufficientMovementSafetyContext(path, context)))) {
    return { status: "fail_closed", graphRevisionId: input.graphRevisionId, authority: input.authority, exerciseConceptId: input.exerciseConceptId, reason: "insufficient_member_context", assertionIds: [input.exerciseAssertionId] };
  }

  const applicable = relevant.flatMap(({ context, matchedPaths }) => matchedPaths
    .filter((path) => clinicalRuleApplies(path, context))
    .map((path) => ({ context, path })));
  const missingCorroboration = applicable.find(({ path }) => path.affectedAnatomyPathAssertionIds.length === 0)?.path;
  if (missingCorroboration) {
    return {
      status: "fail_closed",
      graphRevisionId: input.graphRevisionId,
      authority: input.authority,
      exerciseConceptId: input.exerciseConceptId,
      reason: "graph_consistency_failure",
      assertionIds: [...new Set([
        input.exerciseAssertionId,
        missingCorroboration.conditionAssertionId,
        missingCorroboration.ruleAssertionId,
        ...missingCorroboration.exercisePathAssertionIds,
      ])].sort(),
    };
  }
  const paths = applicable
    .sort((left, right) => effectPriority[left.path.effect] - effectPriority[right.path.effect]
      || left.path.ruleConceptId.localeCompare(right.path.ruleConceptId)
      || left.path.targetConceptId.localeCompare(right.path.targetConceptId)
      || (left.context.sourceKey ?? "").localeCompare(right.context.sourceKey ?? ""));
  const contributingPaths = paths.map(({ path, context }) => contributingPath(path, context));
  const assertionIds = [...new Set([input.exerciseAssertionId, ...contributingPaths.flatMap((path) => path.assertionIds)])].sort();
  const strongest = paths[0]?.path.effect;
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
