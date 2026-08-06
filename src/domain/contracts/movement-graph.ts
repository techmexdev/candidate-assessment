export const MOVEMENT_NODE_KINDS = [
  "exercise",
  "muscle",
  "joint",
  "body-region",
  "movement-pattern",
  "movement-demand",
  "equipment",
  "condition",
  "clinical-rule",
  "ontology-concept",
  "evidence-source",
  "graph-revision",
  "ingestion-activity",
] as const;

export type MovementNodeKind = (typeof MOVEMENT_NODE_KINDS)[number];

export const MOVEMENT_EDGE_KINDS = [
  "targets",
  "stresses",
  "expresses",
  "has-demand",
  "requires",
  "part-of",
  "variant-of",
  "substitution-candidate-for",
  "has-constraint",
  "contraindicates",
  "cautions",
  "downranks",
  "maps-to",
  "supported-by",
  "in-revision",
  "was-generated-by",
  "used",
] as const;

export type MovementEdgeKind = (typeof MOVEMENT_EDGE_KINDS)[number];

export const RESOLVABLE_CONCEPT_KINDS = [
  "exercise",
  "muscle",
  "joint",
  "body-region",
  "movement-pattern",
  "movement-demand",
  "equipment",
  "condition",
] as const;

export type ResolvableConceptKind = (typeof RESOLVABLE_CONCEPT_KINDS)[number];
export type GraphAuthority = "canonical" | "fixture";

export type AssertionProvenance = {
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly sourceRecordId?: string;
};

type NodeAssertion<K extends MovementNodeKind> = {
  readonly assertionId: string;
  readonly conceptId: string;
  readonly graphRevisionId: string;
  readonly kind: K;
  readonly label: string;
  readonly source: AssertionProvenance;
};

export type ExerciseAttributes = {
  readonly priorityTier: string;
  readonly supportsWeight: boolean;
  readonly isBilateral: boolean;
  readonly bilateralPairCatalogId?: string;
};

export type ExerciseNodeAssertion = NodeAssertion<"exercise"> & {
  readonly aliases: readonly string[];
  readonly catalogId: string;
  readonly catalogRevision: string;
  readonly attributes: ExerciseAttributes;
};

export type MuscleNodeAssertion = NodeAssertion<"muscle"> & {
  readonly aliases: readonly string[];
};

export type JointNodeAssertion = NodeAssertion<"joint"> & {
  readonly aliases: readonly string[];
};

export type BodyRegionNodeAssertion = NodeAssertion<"body-region"> & {
  readonly aliases: readonly string[];
};

export type MovementPatternNodeAssertion = NodeAssertion<"movement-pattern"> & {
  readonly aliases: readonly string[];
  readonly taxonomyId: string;
};

export type MovementDemandNodeAssertion = NodeAssertion<"movement-demand"> & {
  readonly definition: string;
  readonly scope: string;
  readonly reviewerEvidenceIds: readonly string[];
};

export type EquipmentNodeAssertion = NodeAssertion<"equipment"> & {
  readonly aliases: readonly string[];
  readonly category: string;
};

export type ConditionNodeAssertion = NodeAssertion<"condition"> & {
  readonly aliases: readonly string[];
};

export type ClinicalRuleEffect = "hard-contraindication" | "caution" | "down-rank";
export type ClinicalRuleApplicability = {
  readonly conditionStatuses: readonly string[];
  readonly recoveryStages: readonly string[];
  readonly severityBands: readonly string[];
  readonly lateralityPolicy: "same-side" | "either-side" | "conservative-when-unknown";
};

export type ClinicalRuleOverridePolicy = {
  readonly allowed: boolean;
  readonly requiredRole?: "coach" | "clinical-reviewer";
  readonly rationaleRequired: boolean;
};

export type ClinicalRuleNodeAssertion = NodeAssertion<"clinical-rule"> & {
  readonly effect: ClinicalRuleEffect;
  readonly severity: "critical" | "high" | "moderate" | "low";
  readonly applicability: ClinicalRuleApplicability;
  readonly overridePolicy: ClinicalRuleOverridePolicy;
  readonly evidenceConceptIds: readonly string[];
  readonly reviewer: string;
  readonly ruleRevision: string;
};

export type OntologyConceptNodeAssertion = NodeAssertion<"ontology-concept"> & {
  readonly ontology: "OPE" | "SNOMED CT";
  readonly code: string;
  readonly conceptUri: string;
  readonly preferredLabel: string;
  readonly sourceRelease: string;
  readonly status: "active" | "inactive";
};

export type EvidenceSourceNodeAssertion = NodeAssertion<"evidence-source"> & {
  readonly title: string;
  readonly owner: string;
  readonly versionOrAccessDate: string;
  readonly uri?: string;
  readonly evidenceRole: "clinical" | "project-policy" | "catalog" | "ontology" | "graph-build";
};

export type GraphRevisionNodeAssertion = NodeAssertion<"graph-revision"> & {
  readonly createdAt: string;
  readonly validationResult: "valid" | "invalid";
  readonly sourceDigests: Readonly<Record<string, string>>;
  readonly wasRevisionOf?: string;
};

export type IngestionActivityNodeAssertion = NodeAssertion<"ingestion-activity"> & {
  readonly softwareVersion: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly inputConceptIds: readonly string[];
  readonly outcome: "succeeded" | "failed";
};

export type MovementGraphNodeAssertion =
  | ExerciseNodeAssertion
  | MuscleNodeAssertion
  | JointNodeAssertion
  | BodyRegionNodeAssertion
  | MovementPatternNodeAssertion
  | MovementDemandNodeAssertion
  | EquipmentNodeAssertion
  | ConditionNodeAssertion
  | ClinicalRuleNodeAssertion
  | OntologyConceptNodeAssertion
  | EvidenceSourceNodeAssertion
  | GraphRevisionNodeAssertion
  | IngestionActivityNodeAssertion;

type EdgeAssertion<
  K extends MovementEdgeKind,
  From extends MovementNodeKind,
  To extends MovementNodeKind,
> = {
  readonly assertionId: string;
  readonly graphRevisionId: string;
  readonly kind: K;
  readonly fromConceptId: string;
  readonly fromKind: From;
  readonly toConceptId: string;
  readonly toKind: To;
  readonly source: AssertionProvenance;
};

export type MovementGraphEdgeAssertion =
  | EdgeAssertion<"targets", "exercise", "muscle">
  | EdgeAssertion<"stresses", "exercise", "joint" | "body-region">
  | EdgeAssertion<"expresses", "exercise", "movement-pattern">
  | EdgeAssertion<"has-demand", "exercise", "movement-demand">
  | EdgeAssertion<"requires", "exercise", "equipment">
  | EdgeAssertion<"part-of", "muscle" | "joint" | "body-region", "joint" | "body-region">
  | EdgeAssertion<"variant-of", "exercise", "exercise">
  | (EdgeAssertion<"substitution-candidate-for", "exercise", "exercise"> & {
      readonly rank: number;
      readonly preservedIntent: string;
      readonly curator: string;
      readonly reviewedAt: string;
    })
  | EdgeAssertion<"has-constraint", "condition", "clinical-rule">
  | EdgeAssertion<"contraindicates", "clinical-rule", "movement-demand" | "movement-pattern" | "joint" | "body-region">
  | EdgeAssertion<"cautions", "clinical-rule", "movement-demand" | "movement-pattern" | "joint" | "body-region">
  | EdgeAssertion<"downranks", "clinical-rule", "movement-demand" | "movement-pattern" | "joint" | "body-region">
  | (EdgeAssertion<"maps-to", ResolvableConceptKind, "ontology-concept"> & {
      readonly mappingAssertionId: string;
      readonly relation: "exactMatch" | "closeMatch" | "broadMatch" | "narrowMatch";
      readonly confidence: number;
      readonly rationale: string;
      readonly curator: string;
      readonly reviewedAt: string;
      readonly sourceRelease: string;
      readonly sourceArtifactDigest: string;
    })
  | EdgeAssertion<"supported-by", "clinical-rule", "evidence-source">
  | EdgeAssertion<"in-revision", Exclude<MovementNodeKind, "graph-revision" | "ingestion-activity">, "graph-revision">
  | EdgeAssertion<"was-generated-by", "graph-revision", "ingestion-activity">
  | EdgeAssertion<"used", "ingestion-activity", "evidence-source">;

export type MovementGraphAssertion = MovementGraphNodeAssertion | MovementGraphEdgeAssertion;

export type MovementGraphDecisionReferences = {
  readonly graphRevisionId: string;
  readonly conceptIds: readonly string[];
  readonly assertionIds: readonly string[];
  readonly ruleAssertionIds: readonly string[];
  readonly mappingAssertionIds: readonly string[];
  readonly evidenceAssertionIds: readonly string[];
};

export type MovementGraphSnapshot = {
  readonly graphRevisionId: string;
  readonly nodes: readonly MovementGraphNodeAssertion[];
  readonly edges: readonly MovementGraphEdgeAssertion[];
};

/*
 * Transitional internal shapes for the pre-target in-memory adapter. They are
 * deliberately excluded from the target unions and read ports above, and are
 * removed when the compiler/adapter migrates in U3/U6.
 */
export type LegacyMovementNodeKind =
  | "exercise"
  | "muscle"
  | "anatomy"
  | "movement-pattern"
  | "equipment"
  | "condition"
  | "ontology-concept";

export type LegacyMovementEdgeKind =
  | "targets"
  | "stresses"
  | "requires"
  | "part-of"
  | "contraindicated-for"
  | "equivalent-to"
  | "variant-of"
  | "follows";

export type LegacyOntologyMapping = {
  id: string;
  sourceOntology: string;
  sourceTerm: string;
  sourceUri: string;
  relation: "exactMatch" | "closeMatch" | "broadMatch" | "narrowMatch";
  confidence: number;
  rationale: string;
  revision: string;
};

export type LegacyMovementNode = {
  id: string;
  kind: LegacyMovementNodeKind;
  label: string;
  aliases: string[];
  source: "exercise-catalog" | "curated-clinical-subset";
  ontologyMappings: LegacyOntologyMapping[];
  metadata: Record<string, string | number | boolean | null>;
};

export type LegacyMovementEdge = {
  id: string;
  from: string;
  to: string;
  kind: LegacyMovementEdgeKind;
  source: string;
};

export type LegacyMovementGraphSnapshot = {
  revision: string;
  nodes: LegacyMovementNode[];
  edges: LegacyMovementEdge[];
};

export type LegacyConceptCandidate = {
  node: LegacyMovementNode;
  matchedAlias: string;
  exact: boolean;
  score: number;
};

export type LegacyMovementGraphRepository = {
  snapshot(): LegacyMovementGraphSnapshot;
  getNode(id: string): LegacyMovementNode | undefined;
  getAnatomyDescendants(id: string): LegacyMovementNode[];
  findConceptCandidates(query: string, kind?: LegacyMovementNodeKind): LegacyConceptCandidate[];
  findEquivalentExercises(exerciseId: string): LegacyMovementNode[];
  getRelated(exerciseId: string, kind: LegacyMovementEdgeKind): LegacyMovementNode[];
};
