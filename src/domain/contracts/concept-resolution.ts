import {
  RESOLVABLE_CONCEPT_KINDS,
  type GraphAuthority,
  type LegacyMovementNodeKind,
  type ResolvableConceptKind,
} from "./movement-graph";

export { RESOLVABLE_CONCEPT_KINDS };

export type ConceptQueryKind = ResolvableConceptKind | "anatomy";

export function conceptKindsForQuery(kind: ConceptQueryKind): readonly ResolvableConceptKind[] {
  return kind === "anatomy" ? ["joint", "body-region"] : [kind];
}

export type ConceptMention = {
  readonly text: string;
  readonly kind?: ConceptQueryKind;
  readonly role: "target" | "equipment" | "injury" | "exclusion" | "preference";
  readonly safetyCritical: boolean;
};

export type ResolutionMethod = "exact" | "fuzzy" | "semantic";
export type CandidateSummary = {
  readonly conceptId: string;
  readonly assertionId: string;
  readonly label: string;
  readonly kind: ResolvableConceptKind;
  readonly matchedAlias: string;
  readonly confidence: number;
  readonly groundingStatus: "active-mapping" | "deprecated-mapping" | "local-only";
  readonly mappingAssertionIds: readonly string[];
};

type ResolutionContext = {
  readonly graphRevisionId: string;
  readonly authority: GraphAuthority;
  readonly policyRevision: string;
};

export type ConceptResolution =
  | (ResolutionContext & {
      readonly status: "resolved";
      readonly mention: ConceptMention;
      readonly conceptId: string;
      readonly assertionId: string;
      readonly method: ResolutionMethod;
      readonly confidence: number;
      readonly threshold: number;
      readonly matchedAlias: string;
      readonly groundingStatus: "active-mapping" | "local-only";
      readonly mappingAssertionIds: readonly string[];
      readonly alternatives: readonly CandidateSummary[];
    })
  | (ResolutionContext & {
      readonly status: "clarify" | "unresolved";
      readonly mention: ConceptMention;
      readonly reason: "ambiguous" | "below-threshold" | "no-candidate" | "invalid-input" | "graph-unavailable" | "non-authoritative" | "deprecated-mapping";
      readonly candidates: readonly CandidateSummary[];
      readonly requiredConfidence: number;
    });

export type ConceptResolutionBatch =
  | { readonly status: "resolved"; readonly resolutions: readonly Extract<ConceptResolution, { status: "resolved" }>[] }
  | { readonly status: "needs_clarification" | "failed_closed"; readonly resolutions: readonly ConceptResolution[] };

export type ConceptResolutionPolicy = {
  readonly revision: string;
  readonly exactThreshold: number;
  readonly fuzzyThreshold: number;
  readonly safetyCriticalThreshold: number;
  readonly clarificationFloor: number;
  readonly minimumMargin: number;
};

/* Transitional types consumed only by the legacy synchronous resolver. */
export type LegacyConceptMention = {
  text: string;
  kind?: LegacyMovementNodeKind;
  role: "target" | "equipment" | "injury" | "exclusion" | "preference";
  safetyCritical: boolean;
};

export type LegacyCandidateSummary = {
  conceptId: string;
  label: string;
  kind: LegacyMovementNodeKind;
  matchedAlias: string;
  confidence: number;
};

export type LegacyConceptResolution =
  | {
      status: "resolved";
      mention: LegacyConceptMention;
      conceptId: string;
      method: ResolutionMethod;
      confidence: number;
      threshold: number;
      matchedAlias: string;
      alternatives: LegacyCandidateSummary[];
      policyRevision: string;
    }
  | {
      status: "clarify" | "unresolved";
      mention: LegacyConceptMention;
      reason: "ambiguous" | "below-threshold" | "no-candidate" | "invalid-input";
      candidates: LegacyCandidateSummary[];
      requiredConfidence: number;
      policyRevision: string;
    };

export type LegacyConceptResolutionBatch =
  | { status: "resolved"; resolutions: Extract<LegacyConceptResolution, { status: "resolved" }>[] }
  | { status: "needs_clarification"; resolutions: LegacyConceptResolution[] };
