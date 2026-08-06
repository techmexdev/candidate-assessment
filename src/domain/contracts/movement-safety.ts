import type {
  ClinicalRuleFact,
  ExerciseConstraintFact,
} from "./movement-clinical-queries";
import type { GraphAuthority } from "./movement-graph";

export type MovementLaterality = "left" | "right" | "bilateral" | "unknown";

export type MovementSafetyContext = {
  readonly conditionConceptId: string;
  readonly conditionStatus?: string;
  readonly recoveryStage?: string;
  readonly severityBand?: string;
  readonly affectedLaterality: MovementLaterality;
  readonly loadedLaterality: MovementLaterality;
};

export type MatchedClinicalRulePath = ClinicalRuleFact & {
  readonly exercisePathAssertionIds: readonly string[];
};

export type MovementSafetyPolicyInput = {
  readonly graphRevisionId: string;
  readonly authority: GraphAuthority;
  readonly exerciseConceptId: string;
  readonly exerciseAssertionId: string;
  readonly evaluations: readonly {
    readonly context: MovementSafetyContext;
    readonly matchedPaths: readonly MatchedClinicalRulePath[];
  }[];
};

export type MovementSafetyRequest = {
  readonly graphRevisionId?: string;
  readonly exerciseConceptId: string;
  readonly conditions: readonly MovementSafetyContext[];
};

export type MovementSafetyContributingPath = {
  readonly conditionConceptId: string;
  readonly ruleConceptId: string;
  readonly targetConceptId: string;
  readonly effect: ClinicalRuleFact["effect"];
  readonly assertionIds: readonly string[];
  readonly ruleAssertionIds: readonly string[];
  readonly mappingAssertionIds: readonly string[];
  readonly evidenceAssertionIds: readonly string[];
};

type MovementSafetySuccessContext = {
  readonly graphRevisionId: string;
  readonly authority: "canonical";
  readonly exerciseConceptId: string;
  readonly exerciseAssertionId: string;
  readonly contributingPaths: readonly MovementSafetyContributingPath[];
  readonly assertionIds: readonly string[];
};

export type MovementSafetyResult =
  | (MovementSafetySuccessContext & { readonly status: "excluded" | "caution" | "downranked" | "allowed" })
  | {
      readonly status: "fail_closed";
      readonly graphRevisionId?: string;
      readonly authority?: GraphAuthority;
      readonly exerciseConceptId: string;
      readonly reason: "graph_unavailable" | "non_authoritative_graph" | "unresolved_exercise" | "unresolved_condition" | "insufficient_member_context" | "broken_rule_path" | "query_limit_exceeded" | "invalid_input";
      readonly assertionIds: readonly string[];
    };

export type RetrievedExerciseSafetyFacts = {
  readonly exercise: ExerciseConstraintFact;
  readonly evaluations: MovementSafetyPolicyInput["evaluations"];
};
