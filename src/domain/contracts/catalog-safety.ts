import type { ClinicalRuleEffect, GraphAuthority } from "./movement-graph";

/** Hard server-owned bounds for catalog safety graph reads. */
export const CATALOG_SAFETY_MAX_EXERCISES = 100;
export const CATALOG_SAFETY_MAX_FAMILY_DEPTH = 4;

export type CatalogSafetyClassification = "excluded" | "caution" | "downranked" | "allowed";
export type CatalogLoadedLaterality = "bilateral" | "unknown";
export type CatalogPathMatchKind = "exact-exercise" | "variant-of" | "expresses";

export type ClinicalCatalogContributionInput = {
  readonly kind: "clinical";
  readonly conditionConceptId: string;
  readonly conditionAssertionId: string;
  readonly conditionEvidenceId: string;
  readonly affectedAnatomyConceptId: string;
  readonly ruleConceptId: string;
  readonly ruleAssertionId: string;
  readonly targetConceptId: string;
  readonly effect: ClinicalRuleEffect;
  readonly applicabilityMatched: boolean;
  readonly targetPathAssertionIds: readonly string[];
  readonly anatomyPathAssertionIds: readonly string[];
  readonly mappingAssertionIds: readonly string[];
  readonly evidenceAssertionIds: readonly string[];
};

export type CatalogEquipmentRequirementInput = {
  readonly equipmentConceptId: string;
  readonly equipmentAssertionId: string;
  readonly requiresAssertionId: string;
};

export type CatalogExplicitExclusionInput = {
  readonly matchKind: CatalogPathMatchKind;
  readonly resolvedConceptId: string;
  readonly evidenceId: string;
  readonly assertionIds: readonly string[];
};

export type CatalogPreferenceInput = {
  readonly matchKind: CatalogPathMatchKind;
  readonly resolvedConceptId: string;
  readonly evidenceId: string;
  readonly rankPenalty: number;
  readonly assertionIds: readonly string[];
};

export type CatalogAvailableEquipmentInput = {
  readonly equipmentConceptId: string;
  readonly assertionId: string;
  readonly evidenceId: string;
};

export type CatalogSafetyCandidateInput = {
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly exerciseConceptId: string;
  readonly exerciseAssertionId: string;
  readonly isBilateral: boolean;
  readonly evaluationComplete: boolean;
  readonly requiredEquipment: readonly CatalogEquipmentRequirementInput[];
  readonly clinicalEvaluations: readonly ClinicalCatalogContributionInput[];
  readonly explicitExclusions: readonly CatalogExplicitExclusionInput[];
  readonly preferences: readonly CatalogPreferenceInput[];
};

export type CatalogSafetyPolicyInput = {
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly authority: GraphAuthority;
  readonly expectedExerciseConceptIds: readonly string[];
  readonly availableEquipment: readonly CatalogAvailableEquipmentInput[];
  readonly equipmentEvidenceIds: readonly string[];
  readonly candidates: readonly CatalogSafetyCandidateInput[];
};

type CatalogContributionBase<K extends "clinical" | "anatomy" | "equipment" | "explicit-exclusion" | "preference"> = {
  readonly kind: K;
  readonly assertionIds: readonly string[];
  readonly evidenceIds: readonly string[];
};

export type CatalogClinicalContribution = CatalogContributionBase<"clinical"> & {
  readonly effect: ClinicalRuleEffect;
  readonly conditionConceptId: string;
  readonly ruleConceptId: string;
  readonly targetConceptId: string;
  readonly targetPathAssertionIds: readonly string[];
};

export type CatalogAnatomyContribution = CatalogContributionBase<"anatomy"> & {
  readonly effect: "corroboration";
  readonly affectedAnatomyConceptId: string;
};

export type CatalogEquipmentContribution = CatalogContributionBase<"equipment"> & {
  readonly effect: "hard-exclusion";
  readonly equipmentConceptId: string;
};

export type CatalogExplicitExclusionContribution = CatalogContributionBase<"explicit-exclusion"> & {
  readonly effect: "hard-exclusion";
  readonly matchKind: CatalogPathMatchKind;
  readonly resolvedConceptId: string;
};

export type CatalogPreferenceContribution = CatalogContributionBase<"preference"> & {
  readonly effect: "down-rank";
  readonly matchKind: CatalogPathMatchKind;
  readonly resolvedConceptId: string;
  readonly rankPenalty: number;
};

export type CatalogSafetyContribution =
  | CatalogClinicalContribution
  | CatalogAnatomyContribution
  | CatalogEquipmentContribution
  | CatalogExplicitExclusionContribution
  | CatalogPreferenceContribution;

export type CatalogSafetyDecision = {
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly exerciseConceptId: string;
  readonly exerciseAssertionId: string;
  readonly classification: CatalogSafetyClassification;
  readonly loadedLaterality: CatalogLoadedLaterality;
  readonly preferenceRank: number;
  readonly contributions: readonly CatalogSafetyContribution[];
  readonly assertionIds: readonly string[];
  readonly evidenceIds: readonly string[];
};

export type CatalogSafetyReadyResult = {
  readonly status: "ready";
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly authority: "canonical";
  readonly decisions: readonly CatalogSafetyDecision[];
  readonly excluded: readonly CatalogSafetyDecision[];
  readonly caution: readonly CatalogSafetyDecision[];
  readonly downranked: readonly CatalogSafetyDecision[];
  readonly allowed: readonly CatalogSafetyDecision[];
  readonly assertionIds: readonly string[];
  readonly evidenceIds: readonly string[];
};

export type CatalogSafetyFailureReason =
  | "non_authoritative_graph"
  | "mixed_revision"
  | "duplicate_exercise"
  | "incomplete_catalog"
  | "incomplete_evaluation"
  | "catalog_limit_exceeded"
  | "graph_consistency_failure"
  | "invalid_input";

export type CatalogSafetyFailClosedResult = {
  readonly status: "fail_closed";
  readonly movementGraphRevisionId?: string;
  readonly memberContextRevisionId?: string;
  readonly authority?: GraphAuthority;
  readonly reason: CatalogSafetyFailureReason;
  readonly exerciseConceptId?: string;
  readonly assertionIds: readonly string[];
  readonly evidenceIds: readonly string[];
};

export type CatalogSafetyResult = CatalogSafetyReadyResult | CatalogSafetyFailClosedResult;
