import type { ResolvableConceptKind } from "./movement-graph";

export type GroundingOntology = "OPE" | "SNOMED CT";
export type SemanticVocabulary = "SKOS" | "PROV-O";
export const ONTOLOGY_SUBSETS = ["OPE", "SNOMED CT", "SKOS", "PROV-O"] as const;
export type OntologySubset = (typeof ONTOLOGY_SUBSETS)[number];
export type SkosMappingRelation = "exactMatch" | "closeMatch" | "broadMatch" | "narrowMatch";

export type OntologyMappingRecord = {
  readonly mappingId: string;
  readonly assertionId: string;
  readonly graphRevisionId: string;
  readonly sourceOntology: GroundingOntology;
  readonly sourceCode: string;
  readonly sourceTerm: string;
  readonly sourceUri: string;
  readonly sourceRelease: string;
  readonly targetKind: ResolvableConceptKind;
  readonly targetConceptId: string;
  readonly ontologyConceptId: string;
  readonly relation: SkosMappingRelation;
  readonly confidence: number;
  readonly rationale: string;
  readonly curator: string;
  readonly reviewedAt: string;
  readonly sourceArtifactDigest: string;
  readonly status: "reviewed" | "rejected" | "local-only";
};

/* Transitional manifest shape used only by the pre-U2 catalog ingestion. */
export type LegacyOntologyMappingRecord = {
  id: string;
  sourceOntology: string;
  sourceTerm: string;
  sourceUri: string;
  targetKind: "anatomy" | "condition" | "equipment" | "movement-pattern";
  targetId: string;
  relation: SkosMappingRelation;
  confidence: number;
  rationale: string;
  revision: string;
};
