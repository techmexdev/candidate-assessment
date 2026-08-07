import {
  CATALOG_SAFETY_MAX_EXERCISES,
  type CatalogAnatomyContribution,
  type CatalogClinicalContribution,
  type CatalogEquipmentContribution,
  type CatalogExplicitExclusionContribution,
  type CatalogPreferenceContribution,
  type CatalogSafetyCandidateInput,
  type CatalogSafetyContribution,
  type CatalogSafetyDecision,
  type CatalogSafetyFailClosedResult,
  type CatalogSafetyPolicyInput,
  type CatalogSafetyResult,
} from "../contracts/catalog-safety";

const contributionPriority = Object.freeze({
  "clinical:hard-contraindication": 0,
  "clinical:caution": 1,
  "clinical:down-rank": 2,
  "anatomy:corroboration": 3,
  "equipment:hard-exclusion": 4,
  "explicit-exclusion:hard-exclusion": 5,
  "preference:down-rank": 6,
});

function stable(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function isFailure(value: unknown): value is CatalogSafetyFailClosedResult {
  return typeof value === "object" && value !== null && "status" in value;
}

function failure(
  input: CatalogSafetyPolicyInput,
  reason: CatalogSafetyFailClosedResult["reason"],
  exerciseConceptId?: string,
  assertionIds: readonly string[] = [],
  evidenceIds: readonly string[] = [],
): CatalogSafetyFailClosedResult {
  return {
    status: "fail_closed",
    movementGraphRevisionId: input.movementGraphRevisionId || undefined,
    memberContextRevisionId: input.memberContextRevisionId || undefined,
    authority: input.authority,
    reason,
    ...(exerciseConceptId ? { exerciseConceptId } : {}),
    assertionIds: stable(assertionIds),
    evidenceIds: stable(evidenceIds),
  };
}

function duplicates(values: readonly string[]) {
  return new Set(values).size !== values.length;
}

function validateInput(input: CatalogSafetyPolicyInput): CatalogSafetyFailClosedResult | undefined {
  if (input.authority !== "canonical") return failure(input, "non_authoritative_graph");
  if (!input.movementGraphRevisionId || !input.memberContextRevisionId) return failure(input, "invalid_input");
  if (input.expectedExerciseConceptIds.length === 0 || input.expectedExerciseConceptIds.length > CATALOG_SAFETY_MAX_EXERCISES) {
    return failure(input, input.expectedExerciseConceptIds.length > CATALOG_SAFETY_MAX_EXERCISES
      ? "catalog_limit_exceeded" : "incomplete_catalog");
  }
  const candidateIds = input.candidates.map((candidate) => candidate.exerciseConceptId);
  if (duplicates(input.expectedExerciseConceptIds) || duplicates(candidateIds)) return failure(input, "duplicate_exercise");
  if (input.candidates.length > CATALOG_SAFETY_MAX_EXERCISES) return failure(input, "catalog_limit_exceeded");
  const expected = stable(input.expectedExerciseConceptIds);
  if (expected.length !== candidateIds.length || expected.some((id, index) => id !== stable(candidateIds)[index])) {
    return failure(input, "incomplete_catalog");
  }
  for (const candidate of input.candidates) {
    if (candidate.movementGraphRevisionId !== input.movementGraphRevisionId
      || candidate.memberContextRevisionId !== input.memberContextRevisionId) {
      return failure(input, "mixed_revision", candidate.exerciseConceptId, [candidate.exerciseAssertionId]);
    }
    if (!candidate.evaluationComplete) {
      return failure(input, "incomplete_evaluation", candidate.exerciseConceptId, [candidate.exerciseAssertionId]);
    }
    if (!candidate.exerciseConceptId || !candidate.exerciseAssertionId || typeof candidate.isBilateral !== "boolean") {
      return failure(input, "invalid_input", candidate.exerciseConceptId || undefined);
    }
    if (candidate.preferences.some((preference) => !Number.isInteger(preference.rankPenalty) || preference.rankPenalty < 0)) {
      return failure(input, "invalid_input", candidate.exerciseConceptId, [candidate.exerciseAssertionId]);
    }
  }
  return undefined;
}

function clinicalContributions(
  input: CatalogSafetyPolicyInput,
  candidate: CatalogSafetyCandidateInput,
): readonly (CatalogClinicalContribution | CatalogAnatomyContribution)[] | CatalogSafetyFailClosedResult {
  const contributions: (CatalogClinicalContribution | CatalogAnatomyContribution)[] = [];
  for (const evaluation of candidate.clinicalEvaluations) {
    if (!evaluation.applicabilityMatched || evaluation.targetPathAssertionIds.length === 0) continue;
    if (evaluation.anatomyPathAssertionIds.length === 0) {
      return failure(input, "graph_consistency_failure", candidate.exerciseConceptId, [
        candidate.exerciseAssertionId,
        evaluation.conditionAssertionId,
        evaluation.ruleAssertionId,
        ...evaluation.targetPathAssertionIds,
      ], [evaluation.conditionEvidenceId]);
    }
    contributions.push({
      kind: "clinical",
      effect: evaluation.effect,
      conditionConceptId: evaluation.conditionConceptId,
      ruleConceptId: evaluation.ruleConceptId,
      targetConceptId: evaluation.targetConceptId,
      targetPathAssertionIds: stable(evaluation.targetPathAssertionIds),
      assertionIds: stable([
        evaluation.conditionAssertionId,
        evaluation.ruleAssertionId,
        ...evaluation.targetPathAssertionIds,
        ...evaluation.mappingAssertionIds,
        ...evaluation.evidenceAssertionIds,
      ]),
      evidenceIds: [evaluation.conditionEvidenceId],
    });
    contributions.push({
      kind: "anatomy",
      effect: "corroboration",
      affectedAnatomyConceptId: evaluation.affectedAnatomyConceptId,
      assertionIds: stable(evaluation.anatomyPathAssertionIds),
      evidenceIds: [evaluation.conditionEvidenceId],
    });
  }
  return contributions;
}

function equipmentContributions(
  input: CatalogSafetyPolicyInput,
  candidate: CatalogSafetyCandidateInput,
): readonly CatalogEquipmentContribution[] {
  const available = new Set(input.availableEquipment.map((item) => item.equipmentConceptId));
  return candidate.requiredEquipment
    .filter((requirement) => !available.has(requirement.equipmentConceptId))
    .map((requirement) => ({
      kind: "equipment",
      effect: "hard-exclusion",
      equipmentConceptId: requirement.equipmentConceptId,
      assertionIds: stable([requirement.equipmentAssertionId, requirement.requiresAssertionId]),
      evidenceIds: stable(input.equipmentEvidenceIds),
    }));
}

function explicitContributions(candidate: CatalogSafetyCandidateInput): readonly CatalogExplicitExclusionContribution[] {
  return candidate.explicitExclusions.map((exclusion) => ({
    kind: "explicit-exclusion",
    effect: "hard-exclusion",
    matchKind: exclusion.matchKind,
    resolvedConceptId: exclusion.resolvedConceptId,
    assertionIds: stable(exclusion.assertionIds),
    evidenceIds: [exclusion.evidenceId],
  }));
}

function preferenceContributions(candidate: CatalogSafetyCandidateInput): readonly CatalogPreferenceContribution[] {
  return candidate.preferences.map((preference) => ({
    kind: "preference",
    effect: "down-rank",
    matchKind: preference.matchKind,
    resolvedConceptId: preference.resolvedConceptId,
    rankPenalty: preference.rankPenalty,
    assertionIds: stable(preference.assertionIds),
    evidenceIds: [preference.evidenceId],
  }));
}

function contributionKey(contribution: CatalogSafetyContribution): keyof typeof contributionPriority {
  return `${contribution.kind}:${contribution.effect}` as keyof typeof contributionPriority;
}

function classification(contributions: readonly CatalogSafetyContribution[]) {
  if (contributions.some((item) => item.effect === "hard-exclusion" || item.effect === "hard-contraindication")) return "excluded" as const;
  if (contributions.some((item) => item.effect === "caution")) return "caution" as const;
  if (contributions.some((item) => item.effect === "down-rank")) return "downranked" as const;
  return "allowed" as const;
}

function decideCandidate(
  input: CatalogSafetyPolicyInput,
  candidate: CatalogSafetyCandidateInput,
): CatalogSafetyDecision | CatalogSafetyFailClosedResult {
  const clinical = clinicalContributions(input, candidate);
  if (isFailure(clinical)) return clinical;
  const contributions: CatalogSafetyContribution[] = [
    ...clinical,
    ...equipmentContributions(input, candidate),
    ...explicitContributions(candidate),
    ...preferenceContributions(candidate),
  ];
  contributions.sort((left, right) => contributionPriority[contributionKey(left)] - contributionPriority[contributionKey(right)]
    || left.kind.localeCompare(right.kind)
    || left.assertionIds.join("\0").localeCompare(right.assertionIds.join("\0")));
  const preferenceRank = contributions.reduce((total, contribution) => (
    contribution.kind === "preference" ? total + contribution.rankPenalty : total
  ), 0);
  const availableEquipment = new Map(input.availableEquipment.map((item) => [item.equipmentConceptId, item]));
  const satisfiedEquipment = candidate.requiredEquipment.flatMap((requirement) => {
    const available = availableEquipment.get(requirement.equipmentConceptId);
    return available ? [available] : [];
  });
  return {
    movementGraphRevisionId: input.movementGraphRevisionId,
    memberContextRevisionId: input.memberContextRevisionId,
    exerciseConceptId: candidate.exerciseConceptId,
    exerciseAssertionId: candidate.exerciseAssertionId,
    classification: classification(contributions),
    loadedLaterality: candidate.isBilateral ? "bilateral" : "unknown",
    preferenceRank,
    contributions,
    assertionIds: stable([
      candidate.exerciseAssertionId,
      ...contributions.flatMap((item) => item.assertionIds),
      ...satisfiedEquipment.map((item) => item.assertionId),
    ]),
    evidenceIds: stable([
      ...input.equipmentEvidenceIds,
      ...contributions.flatMap((item) => item.evidenceIds),
      ...satisfiedEquipment.map((item) => item.evidenceId),
    ]),
  };
}

function compareDecisions(left: CatalogSafetyDecision, right: CatalogSafetyDecision) {
  return left.preferenceRank - right.preferenceRank || left.exerciseConceptId.localeCompare(right.exerciseConceptId);
}

export function classifyCatalogSafety(input: CatalogSafetyPolicyInput): CatalogSafetyResult {
  const invalid = validateInput(input);
  if (invalid) return invalid;
  const decisions: CatalogSafetyDecision[] = [];
  for (const candidate of input.candidates) {
    const decision = decideCandidate(input, candidate);
    if (isFailure(decision)) return decision;
    decisions.push(decision);
  }
  decisions.sort((left, right) => left.exerciseConceptId.localeCompare(right.exerciseConceptId));
  const byClassification = (value: CatalogSafetyDecision["classification"]) => decisions
    .filter((decision) => decision.classification === value)
    .sort(compareDecisions);
  return {
    status: "ready",
    movementGraphRevisionId: input.movementGraphRevisionId,
    memberContextRevisionId: input.memberContextRevisionId,
    authority: "canonical",
    decisions,
    excluded: byClassification("excluded"),
    caution: byClassification("caution"),
    downranked: byClassification("downranked"),
    allowed: byClassification("allowed"),
    assertionIds: stable(decisions.flatMap((decision) => decision.assertionIds)),
    evidenceIds: stable(decisions.flatMap((decision) => decision.evidenceIds)),
  };
}
