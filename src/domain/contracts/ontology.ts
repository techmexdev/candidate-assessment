import type { ResolvableConceptKind } from "./movement-graph";

export type GroundingOntology = "OPE" | "SNOMED CT";
export type SemanticVocabulary = "SKOS" | "PROV-O";
export const ONTOLOGY_SUBSETS = ["OPE", "SNOMED CT", "SKOS", "PROV-O"] as const;
export type OntologySubset = (typeof ONTOLOGY_SUBSETS)[number];
export type SkosMappingRelation = "exactMatch" | "closeMatch" | "broadMatch" | "narrowMatch";

type OntologyReviewRecordBase = {
  readonly graphRevisionId: string;
  readonly sourceOntology: GroundingOntology;
  readonly sourceRelease: string;
  readonly targetKind: ResolvableConceptKind;
  readonly targetConceptId: string;
  readonly curator: string;
  readonly reviewedAt: string;
};

export type ReviewedOntologyMappingRecord = OntologyReviewRecordBase & {
  readonly status: "reviewed";
  readonly mappingId: string;
  readonly assertionId: string;
  readonly sourceCode: string;
  readonly sourceTerm: string;
  readonly sourceUri: string;
  readonly ontologyConceptId: string;
  readonly relation: SkosMappingRelation;
  readonly confidence: number;
  readonly rationale: string;
  readonly sourceArtifactDigest: string;
};

export type LocalOnlyOntologyVerificationRecord = OntologyReviewRecordBase & {
  readonly status: "local-only";
  readonly verificationId: string;
  readonly verificationStatus: "not-verified";
  readonly reviewReason: string;
};

/**
 * A reviewed mapping is an external assertion with a real code and concept IRI.
 * A local-only record instead captures that verification was attempted and must
 * never be padded with a guessed external identifier.
 */
export type OntologyMappingRecord =
  | ReviewedOntologyMappingRecord
  | LocalOnlyOntologyVerificationRecord;
