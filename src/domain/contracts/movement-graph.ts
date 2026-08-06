export type MovementNodeKind =
  | "exercise"
  | "muscle"
  | "anatomy"
  | "movement-pattern"
  | "equipment"
  | "condition"
  | "ontology-concept";

export type MovementEdgeKind =
  | "targets"
  | "stresses"
  | "requires"
  | "part-of"
  | "contraindicated-for"
  | "equivalent-to"
  | "variant-of"
  | "follows";

export type OntologyMapping = {
  id: string;
  sourceOntology: string;
  sourceTerm: string;
  sourceUri: string;
  relation: "exactMatch" | "closeMatch" | "broadMatch" | "narrowMatch";
  confidence: number;
  rationale: string;
  revision: string;
};

export type MovementNode = {
  id: string;
  kind: MovementNodeKind;
  label: string;
  aliases: string[];
  source: "exercise-catalog" | "curated-clinical-subset";
  ontologyMappings: OntologyMapping[];
  metadata: Record<string, string | number | boolean | null>;
};

export type MovementEdge = {
  id: string;
  from: string;
  to: string;
  kind: MovementEdgeKind;
  source: string;
};

export type MovementGraphSnapshot = {
  revision: string;
  nodes: MovementNode[];
  edges: MovementEdge[];
};

export type ConceptCandidate = {
  node: MovementNode;
  matchedAlias: string;
  exact: boolean;
  score: number;
};

export type MovementGraphRepository = {
  snapshot(): MovementGraphSnapshot;
  getNode(id: string): MovementNode | undefined;
  getAnatomyDescendants(id: string): MovementNode[];
  findConceptCandidates(query: string, kind?: MovementNodeKind): ConceptCandidate[];
  findEquivalentExercises(exerciseId: string): MovementNode[];
  getRelated(exerciseId: string, kind: MovementEdgeKind): MovementNode[];
};
