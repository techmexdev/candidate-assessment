export type OntologySubset = "OPE" | "COPPER" | "SNOMED CT" | "SKOS" | "PROV-O";

export type OntologyMappingRecord = {
  id: string;
  sourceOntology: OntologySubset;
  sourceTerm: string;
  sourceUri: string;
  targetKind: "anatomy" | "condition" | "equipment" | "movement-pattern";
  targetId: string;
  relation: "exactMatch" | "closeMatch" | "broadMatch" | "narrowMatch";
  confidence: number;
  rationale: string;
  revision: string;
};
