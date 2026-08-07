import type {
  ClinicalRuleEffect,
  ClinicalRuleApplicability,
  ClinicalRuleOverridePolicy,
  ExerciseAttributes,
  GraphAuthority,
  MovementGraphAssertion,
  ResolvableConceptKind,
} from "./movement-graph";

export type BoundedGraphQuery = {
  readonly maxResults: number;
  readonly maxDepth?: number;
};

export type MovementGraphReadFailure =
  | { readonly code: "graph_unavailable"; readonly message: string }
  | { readonly code: "revision_not_found"; readonly revisionId: string }
  | { readonly code: "fixture_authority_rejected"; readonly operation: string }
  | { readonly code: "unresolved_concept"; readonly conceptId: string }
  | { readonly code: "broken_assertion"; readonly assertionId: string }
  | { readonly code: "traversal_limit_exceeded"; readonly maxDepth: number; readonly maxResults: number }
  | { readonly code: "invalid_query"; readonly message: string };

export type GraphQueryResult<T> =
  | {
      readonly status: "ok";
      readonly graphRevisionId: string;
      readonly authority: GraphAuthority;
      readonly data: T;
    }
  | {
      readonly status: "failed";
      readonly graphRevisionId: string;
      readonly authority: GraphAuthority;
      readonly failure: MovementGraphReadFailure;
    };

export type ConceptCandidateFact = {
  readonly conceptId: string;
  readonly assertionId: string;
  readonly kind: ResolvableConceptKind;
  readonly label: string;
  readonly exactMatchedAlias?: string;
  readonly fuzzyMatchedAlias: string;
  readonly fuzzyScore: number;
  readonly vectorMatchedAlias: string;
  readonly vectorScore: number;
  readonly groundingStatus: "active-mapping" | "deprecated-mapping" | "local-only";
  readonly mappingAssertionIds: readonly string[];
};

export type ResolveConceptCandidatesQuery = BoundedGraphQuery & {
  readonly text: string;
  readonly kinds: readonly ResolvableConceptKind[];
};

export type AnatomyPathFact = {
  readonly descendantConceptId: string;
  readonly ancestorConceptId: string;
  readonly nodeAssertionIds: readonly string[];
  readonly edgeAssertionIds: readonly string[];
};

export type AnatomyPathsQuery = BoundedGraphQuery & {
  readonly conceptId: string;
  readonly includeSelf: boolean;
};

export type ClinicalRuleFact = {
  readonly conditionConceptId: string;
  readonly conditionAssertionId: string;
  readonly ruleConceptId: string;
  readonly ruleAssertionId: string;
  readonly effect: ClinicalRuleEffect;
  readonly applicability: ClinicalRuleApplicability;
  readonly overridePolicy: ClinicalRuleOverridePolicy;
  readonly targetConceptId: string;
  readonly targetKind: "movement-demand" | "movement-pattern" | "joint" | "body-region";
  readonly pathAssertionIds: readonly string[];
  readonly mappingAssertionIds: readonly string[];
  readonly evidenceAssertionIds: readonly string[];
};

export type ExerciseConstraintRelationFact = {
  readonly kind: "targets" | "has-demand" | "expresses" | "stresses" | "requires";
  readonly targetConceptId: string;
  readonly targetKind: "muscle" | "movement-demand" | "movement-pattern" | "joint" | "body-region" | "equipment";
  readonly targetAssertionId: string;
  readonly edgeAssertionId: string;
};

export type ExerciseConstraintFact = {
  readonly exerciseConceptId: string;
  readonly exerciseAssertionId: string;
  readonly attributes: ExerciseAttributes;
  readonly relations: readonly ExerciseConstraintRelationFact[];
};

export type ExerciseFamilyRelationFact = {
  readonly variantExerciseConceptId: string;
  readonly variantExerciseAssertionId: string;
  readonly familyRootExerciseConceptId: string;
  readonly familyRootExerciseAssertionId: string;
  readonly edgeAssertionId: string;
};

export type CatalogExerciseFact = ExerciseConstraintFact & {
  readonly familyRelations: readonly ExerciseFamilyRelationFact[];
};

export type CatalogExerciseFactsQuery = Pick<BoundedGraphQuery, "maxResults">;

export type CatalogFamilyFact = {
  readonly exerciseConceptId: string;
  readonly exerciseAssertionId: string;
  readonly matchedConceptId: string;
  readonly matchedConceptAssertionId: string;
  readonly matchKind: "exact-exercise" | "variant-of" | "expresses";
  readonly pathAssertionIds: readonly string[];
};

export type CatalogFamilyFactsQuery = BoundedGraphQuery & {
  readonly conceptId: string;
  readonly conceptKind: "exercise" | "movement-pattern";
};

export type ExerciseConstraintFactsQuery = BoundedGraphQuery & {
  readonly exerciseConceptId: string;
};

export type ClinicalRuleFactsQuery = BoundedGraphQuery & {
  readonly conditionConceptId: string;
  readonly targetConceptIds?: readonly string[];
};

export type SubstitutionCandidateFact = {
  readonly exerciseConceptId: string;
  readonly exerciseAssertionId: string;
  readonly substitutionAssertionId: string;
  readonly rank: number;
  readonly preservedIntent: string;
  readonly curator: string;
  readonly reviewedAt: string;
};

export type SubstitutionCandidatesQuery = BoundedGraphQuery & {
  readonly exerciseConceptId: string;
};

export type AssertionLookupQuery = BoundedGraphQuery & {
  readonly assertionIds: readonly string[];
};

export type MovementGraphReadHandle = {
  readonly graphRevisionId: string;
  readonly authority: GraphAuthority;
  readonly resolveConceptCandidates: (
    query: ResolveConceptCandidatesQuery,
  ) => Promise<GraphQueryResult<readonly ConceptCandidateFact[]>>;
  readonly getAnatomyPaths: (
    query: AnatomyPathsQuery,
  ) => Promise<GraphQueryResult<readonly AnatomyPathFact[]>>;
  readonly getClinicalRuleFacts: (
    query: ClinicalRuleFactsQuery,
  ) => Promise<GraphQueryResult<readonly ClinicalRuleFact[]>>;
  readonly getExerciseConstraintFacts: (
    query: ExerciseConstraintFactsQuery,
  ) => Promise<GraphQueryResult<ExerciseConstraintFact>>;
  readonly getCatalogExerciseFacts: (
    query: CatalogExerciseFactsQuery,
  ) => Promise<GraphQueryResult<readonly CatalogExerciseFact[]>>;
  readonly getCatalogFamilyFacts: (
    query: CatalogFamilyFactsQuery,
  ) => Promise<GraphQueryResult<readonly CatalogFamilyFact[]>>;
  readonly getSubstitutionCandidates: (
    query: SubstitutionCandidatesQuery,
  ) => Promise<GraphQueryResult<readonly SubstitutionCandidateFact[]>>;
  readonly getAssertions: (
    query: AssertionLookupQuery,
  ) => Promise<GraphQueryResult<readonly MovementGraphAssertion[]>>;
};

export type MovementGraphReadOpenResult =
  | { readonly status: "ready"; readonly handle: MovementGraphReadHandle }
  | { readonly status: "unavailable"; readonly failure: MovementGraphReadFailure };

export type MovementGraphReadProvider = {
  readonly openActive: () => Promise<MovementGraphReadOpenResult>;
  readonly openRevision: (revisionId: string) => Promise<MovementGraphReadOpenResult>;
};
