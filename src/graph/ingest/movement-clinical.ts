import catalog from "../../../data/exercises.json";
import anatomy from "../../../data/movement-anatomy.json";
import concepts from "../../../data/movement-concepts.json";
import demands from "../../../data/movement-demands.json";
import evidence from "../../../data/clinical-evidence.json";
import rules from "../../../data/clinical-rules.json";
import mappings from "../../../data/movement-ontology-mappings.json";
import sourceReviews from "../../../data/movement-source-reviews.json";
import substitutions from "../../../data/movement-substitutions.json";
import type {
  AssertionProvenance,
  ClinicalRuleNodeAssertion,
  EvidenceSourceNodeAssertion,
  MovementGraphEdgeAssertion,
  MovementGraphNodeAssertion,
  MovementGraphSnapshot,
  ResolvableConceptKind,
} from "../../domain/contracts/movement-graph";
import { canonicalJson, deepFreeze, deriveAssertionId, deriveRevisionId, sha256 } from "../revisions/movement-graph";
import {
  CLINICAL_RULE_EFFECT_TARGET_EDGE,
  MOVEMENT_GRAPH_COMPILER_VERSION,
  MOVEMENT_GRAPH_SCHEMA_VERSION,
} from "../schema/movement-schema";
import {
  invalidSourceReport,
  validateMovementGraph,
  type MovementGraphValidationError,
  type MovementGraphValidationReport,
} from "../validation/movement-graph";

type SourceRecord = { readonly source_id: string; readonly source_revision: string };
type ReviewRecord = { readonly status: string; readonly reviewer: string; readonly reviewed_at: string };
type ManifestBase = { readonly manifest_id: string; readonly revision: string };
type CatalogExercise = (typeof catalog)[number];

type ExerciseConceptRecord = {
  readonly stable_id: string;
  readonly kind: "exercise";
  readonly label: string;
  readonly aliases: readonly string[];
  readonly catalog_id: string;
  readonly catalog_scope: string;
  readonly catalog: {
    readonly priority_tier: string | number;
    readonly supports_weight: boolean;
    readonly is_bilateral: boolean;
    readonly bilateral_pair_id: string | null;
  };
  readonly source: SourceRecord;
};
type PatternConceptRecord = Omit<ExerciseConceptRecord, "kind" | "catalog_id" | "catalog"> & {
  readonly kind: "movement-pattern";
};
type EquipmentConceptRecord = Omit<PatternConceptRecord, "kind"> & { readonly kind: "equipment" };
type SimpleConceptRecord = Omit<PatternConceptRecord, "kind"> & {
  readonly kind: "muscle" | "joint" | "body-region" | "condition";
};
type ConceptRecord = ExerciseConceptRecord | PatternConceptRecord | EquipmentConceptRecord | SimpleConceptRecord;

type DemandRecord = {
  readonly stable_id: string;
  readonly label: string;
  readonly definition: string;
  readonly scope: unknown;
  readonly reviewer_evidence_ids: readonly string[];
  readonly source: SourceRecord;
};
type EvidenceRecord = {
  readonly stable_id: string;
  readonly title: string;
  readonly owner: string;
  readonly version_or_access_date: string;
  readonly evidence_role: EvidenceSourceNodeAssertion["evidenceRole"];
  readonly source: SourceRecord;
};
type SourceReviewRecord = SourceRecord & {
  readonly title: string;
  readonly publisher: string;
  readonly source_release: string;
  readonly uri: string;
};
type ClinicalRuleRecord = {
  readonly stable_id: string;
  readonly assertion_id: string;
  readonly condition_id: string;
  readonly effect: ClinicalRuleNodeAssertion["effect"];
  readonly severity: ClinicalRuleNodeAssertion["severity"];
  readonly applicability: {
    readonly condition_statuses: readonly string[];
    readonly recovery_stages: readonly string[];
    readonly severity_bands: readonly string[];
    readonly laterality_policy: ClinicalRuleNodeAssertion["applicability"]["lateralityPolicy"];
  };
  readonly override_policy: {
    readonly allowed: boolean;
    readonly required_role?: "coach" | "clinical-reviewer";
    readonly rationale_required: boolean;
  };
  readonly target: {
    readonly edge_kind: (typeof CLINICAL_RULE_EFFECT_TARGET_EDGE)[ClinicalRuleNodeAssertion["effect"]];
    readonly target_kind: "movement-demand" | "movement-pattern" | "joint" | "body-region";
    readonly target_id: string;
  };
  readonly evidence_ids: readonly string[];
  readonly clinical_review?: { readonly status: string; readonly reviewer: string };
  readonly review?: ReviewRecord;
  readonly source: SourceRecord;
};
type ReviewedMappingRecord = {
  readonly status: "reviewed";
  readonly mapping_id: string;
  readonly assertion_id: string;
  readonly source_ontology: "OPE" | "SNOMED CT";
  readonly source_code: string;
  readonly source_term: string;
  readonly source_uri: string;
  readonly source_release: string;
  readonly external_status: "active" | "inactive";
  readonly target_kind: ResolvableConceptKind;
  readonly target_concept_id: string;
  readonly ontology_concept_id: string;
  readonly relation: Extract<MovementGraphEdgeAssertion, { kind: "maps-to" }>["relation"];
  readonly confidence: number;
  readonly rationale: string;
  readonly curator: string;
  readonly reviewed_at: string;
  readonly source_artifact_digest: string;
  readonly source: SourceRecord;
  readonly review?: ReviewRecord;
};
type LocalOnlyMappingRecord = {
  readonly status: "local-only";
  readonly verification_id: string;
  readonly verification_status: string;
  readonly review_reason: string;
  readonly source: SourceRecord;
  readonly review?: ReviewRecord;
};
type MappingRecord = ReviewedMappingRecord | LocalOnlyMappingRecord;
type PartOfRecord = {
  readonly assertion_id: string;
  readonly child_id: string;
  readonly child_kind: "muscle" | "joint" | "body-region";
  readonly parent_id: string;
  readonly parent_kind: "joint" | "body-region";
  readonly source: SourceRecord;
};
type ExerciseStressRecord = {
  readonly assertion_id: string;
  readonly exercise_id: string;
  readonly anatomy_id: string;
  readonly anatomy_kind: "joint" | "body-region";
  readonly source: SourceRecord;
};
type DemandAssignmentRecord = {
  readonly assertion_id: string;
  readonly exercise_id: string;
  readonly demand_id: string;
  readonly source: SourceRecord;
};
type SubstitutionRecord = {
  readonly assertion_id: string;
  readonly source_exercise_id: string;
  readonly target_exercise_id: string;
  readonly rank: number;
  readonly preserved_intent: string;
  readonly source: SourceRecord;
  readonly review: ReviewRecord;
};

export type MovementGraphSources = {
  readonly catalog: readonly CatalogExercise[];
  readonly concepts: ManifestBase & { readonly source_artifacts: readonly SourceRecord[]; readonly records: readonly ConceptRecord[] };
  readonly anatomy: ManifestBase & { readonly part_of: readonly PartOfRecord[]; readonly exercise_stresses: readonly ExerciseStressRecord[] };
  readonly demands: ManifestBase & { readonly records: readonly DemandRecord[]; readonly assignments: readonly DemandAssignmentRecord[] };
  readonly evidence: ManifestBase & { readonly records: readonly EvidenceRecord[] };
  readonly rules: ManifestBase & { readonly records: readonly ClinicalRuleRecord[] };
  readonly substitutions: ManifestBase & { readonly records: readonly SubstitutionRecord[] };
  readonly mappings: ManifestBase & { readonly records: readonly MappingRecord[] };
  readonly sourceReviews: ManifestBase & { readonly records: readonly SourceReviewRecord[] };
};

export const movementGraphSources = deepFreeze({
  catalog,
  concepts,
  anatomy,
  demands,
  evidence,
  rules,
  substitutions,
  mappings,
  sourceReviews,
} as unknown as MovementGraphSources);

export type MovementGraphCompileResult =
  | { readonly status: "valid"; readonly snapshot: MovementGraphSnapshot }
  | { readonly status: "invalid"; readonly report: MovementGraphValidationReport };

type WithoutAssertionIdentity<T> = T extends unknown
  ? Omit<T, "assertionId" | "graphRevisionId">
  : never;
type MovementNodeInput = WithoutAssertionIdentity<MovementGraphNodeAssertion>;
type MovementEdgeInput = WithoutAssertionIdentity<MovementGraphEdgeAssertion>;

const source = (record: SourceRecord, sourceRecordId?: string): AssertionProvenance => ({
  sourceId: record.source_id,
  sourceRevision: record.source_revision,
  ...(sourceRecordId ? { sourceRecordId } : {}),
});

const slug = (value: string) => value
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");

function manifestMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const manifest = value as Readonly<Record<string, unknown>>;
  return {
    manifestId: typeof manifest.manifest_id === "string" ? manifest.manifest_id : undefined,
    revision: typeof manifest.revision === "string" ? manifest.revision : undefined,
  };
}

function sourceValidationErrors(sources: MovementGraphSources): MovementGraphValidationError[] {
  const errors: MovementGraphValidationError[] = [];
  for (const record of sources.mappings.records) {
    if (record.status === "local-only") {
      if ("source_code" in record || "source_uri" in record || "ontology_concept_id" in record) {
        errors.push({ code: "invalid_local_only_mapping", message: `Local-only mapping ${record.verification_id} contains an external identifier` });
      }
      if (!record.verification_id || record.verification_status !== "not-verified" || !record.review_reason || record.review?.status !== "reviewed") {
        errors.push({ code: "invalid_local_only_mapping", message: `Incomplete local-only mapping ${record.verification_id || "unknown"}` });
      }
      continue;
    }
    const required = [
      record.mapping_id,
      record.assertion_id,
      record.source_code,
      record.source_uri,
      record.source_release,
      record.source_artifact_digest,
      record.curator,
      record.reviewed_at,
    ];
    if (required.some((value) => typeof value !== "string" || value.length === 0) || record.review?.status !== "reviewed") {
      errors.push({ code: "incomplete_mapping", message: `Incomplete reviewed mapping ${record.mapping_id || "unknown"}` });
    }
  }
  for (const record of sources.rules.records) {
    if (!record.clinical_review || record.clinical_review.status !== "approved" || !record.clinical_review.reviewer
      || record.review?.status !== "reviewed" || record.evidence_ids.length === 0) {
      errors.push({ code: "incomplete_clinical_rule", message: `Incomplete clinical rule ${record.stable_id || "unknown"}` });
    }
    if (CLINICAL_RULE_EFFECT_TARGET_EDGE[record.effect] !== record.target.edge_kind) {
      errors.push({ code: "rule_effect_mismatch", message: `Rule effect mismatch ${record.stable_id || "unknown"}` });
    }
  }
  return errors;
}

export function compileMovementGraph(sources: MovementGraphSources): MovementGraphCompileResult {
  const sourceEntries = Object.entries(sources).sort(([left], [right]) => left.localeCompare(right));
  const sourceDigests = sourceEntries.map(([name, value]) => [name, `sha256:${sha256(canonicalJson(value))}`] as [string, string]);
  const graphRevisionId = deriveRevisionId(MOVEMENT_GRAPH_SCHEMA_VERSION, MOVEMENT_GRAPH_COMPILER_VERSION, sourceDigests);
  const sourceErrors = sourceValidationErrors(sources);
  if (sourceErrors.length > 0) return { status: "invalid", report: invalidSourceReport(sourceErrors) };

  const nodes: MovementGraphNodeAssertion[] = [];
  const edges: MovementGraphEdgeAssertion[] = [];
  const nodeSourceById = new Map<string, AssertionProvenance>();
  const addNode = (identity: unknown, value: MovementNodeInput) => {
    const assertionId = deriveAssertionId(graphRevisionId, ["node", identity]);
    const node = { ...value, assertionId, graphRevisionId } as MovementGraphNodeAssertion;
    nodes.push(node);
    nodeSourceById.set(node.conceptId, node.source);
    return node;
  };
  const addEdge = (identity: unknown, value: MovementEdgeInput) => {
    const assertionId = deriveAssertionId(graphRevisionId, ["edge", identity]);
    edges.push({ ...value, assertionId, graphRevisionId } as MovementGraphEdgeAssertion);
  };

  for (const record of sources.concepts.records) {
    const common = {
      conceptId: record.stable_id,
      label: record.label,
      aliases: [...record.aliases].sort(),
      source: source(record.source, record.stable_id),
    };
    if (record.kind === "exercise") {
      addNode(record.stable_id, {
        ...common,
        kind: record.kind,
        catalogId: record.catalog_id,
        catalogRevision: record.source.source_revision,
        attributes: {
          priorityTier: String(record.catalog.priority_tier),
          supportsWeight: record.catalog.supports_weight,
          isBilateral: record.catalog.is_bilateral,
          ...(record.catalog.bilateral_pair_id ? { bilateralPairCatalogId: record.catalog.bilateral_pair_id } : {}),
        },
      });
    } else if (record.kind === "movement-pattern") {
      addNode(record.stable_id, { ...common, kind: record.kind, taxonomyId: record.stable_id });
    } else if (record.kind === "equipment") {
      addNode(record.stable_id, { ...common, kind: record.kind, category: record.catalog_scope });
    } else {
      addNode(record.stable_id, { ...common, kind: record.kind });
    }
  }

  for (const record of sources.demands.records) {
    addNode(record.stable_id, {
      conceptId: record.stable_id,
      kind: "movement-demand",
      label: record.label,
      definition: record.definition,
      scope: canonicalJson(record.scope),
      reviewerEvidenceIds: [...record.reviewer_evidence_ids].sort(),
      source: source(record.source, record.stable_id),
    });
  }
  for (const record of sources.evidence.records) {
    addNode(record.stable_id, {
      conceptId: record.stable_id,
      kind: "evidence-source",
      label: record.title,
      title: record.title,
      owner: record.owner,
      versionOrAccessDate: record.version_or_access_date,
      evidenceRole: record.evidence_role,
      source: source(record.source, record.stable_id),
    });
  }
  for (const record of sources.sourceReviews.records) {
    const conceptId = `evidence-source:${record.source_id}`;
    addNode(conceptId, {
      conceptId,
      kind: "evidence-source",
      label: record.title,
      title: record.title,
      owner: record.publisher,
      versionOrAccessDate: record.source_release,
      uri: record.uri,
      evidenceRole: "ontology",
      source: source(record, record.source_id),
    });
  }

  const manifestEvidenceIds: string[] = [];
  for (const [name, value] of sourceEntries) {
    const metadata = manifestMetadata(value);
    const digest = sourceDigests.find(([key]) => key === name)?.[1];
    if (!digest) throw new Error(`Missing source digest for ${name}`);
    const conceptId = `evidence-source:${metadata.manifestId ?? `catalog:${name}`}`;
    manifestEvidenceIds.push(conceptId);
    addNode(conceptId, {
      conceptId,
      kind: "evidence-source",
      label: metadata.manifestId ?? "Exercise catalog",
      title: metadata.manifestId ?? "Exercise catalog",
      owner: "checked-in source",
      versionOrAccessDate: metadata.revision ?? digest,
      evidenceRole: name === "catalog" ? "catalog" : "graph-build",
      source: {
        sourceId: metadata.manifestId ?? "source:exercise-catalog",
        sourceRevision: metadata.revision ?? digest,
      },
    });
  }

  for (const record of sources.rules.records) {
    addNode(record.stable_id, {
      conceptId: record.stable_id,
      kind: "clinical-rule",
      label: record.stable_id,
      effect: record.effect,
      severity: record.severity,
      applicability: {
        conditionStatuses: [...record.applicability.condition_statuses].sort(),
        recoveryStages: [...record.applicability.recovery_stages].sort(),
        severityBands: [...record.applicability.severity_bands].sort(),
        lateralityPolicy: record.applicability.laterality_policy,
      },
      overridePolicy: {
        allowed: record.override_policy.allowed,
        ...(record.override_policy.required_role ? { requiredRole: record.override_policy.required_role } : {}),
        rationaleRequired: record.override_policy.rationale_required,
      },
      evidenceConceptIds: [...record.evidence_ids].sort(),
      reviewer: record.clinical_review?.reviewer ?? "",
      ruleRevision: record.source.source_revision,
      source: source(record.source, record.assertion_id),
    });
  }

  const reviewedMappings = sources.mappings.records.filter(
    (record): record is ReviewedMappingRecord => record.status === "reviewed",
  );
  for (const record of reviewedMappings) {
    addNode(record.ontology_concept_id, {
      conceptId: record.ontology_concept_id,
      kind: "ontology-concept",
      label: record.source_term,
      ontology: record.source_ontology,
      code: record.source_code,
      conceptUri: record.source_uri,
      preferredLabel: record.source_term,
      sourceRelease: record.source_release,
      status: record.external_status,
      source: source(record.source, record.mapping_id),
    });
  }

  const labelIds = new Map(
    nodes
      .filter((node) => "aliases" in node)
      .map((node) => [`${node.kind}:${slug(node.label)}`, node.conceptId]),
  );
  const catalogSource: AssertionProvenance = {
    sourceId: "source:exercise-catalog",
    sourceRevision: sources.concepts.source_artifacts[0]?.source_revision ?? "unknown",
  };
  const addCatalogEdge = (
    kind: "targets" | "stresses" | "expresses" | "requires",
    targetKind: "muscle" | "joint" | "movement-pattern" | "equipment",
    exercise: CatalogExercise,
    label: string,
  ) => {
    const exerciseId = `exercise:${exercise.id}`;
    const targetId = labelIds.get(`${targetKind}:${slug(label)}`) ?? `${targetKind}:${slug(label)}`;
    addEdge([kind, exerciseId, targetId], {
      kind,
      fromConceptId: exerciseId,
      fromKind: "exercise",
      toConceptId: targetId,
      toKind: targetKind,
      source: { ...catalogSource, sourceRecordId: exercise.id },
    } as MovementEdgeInput);
  };
  for (const exercise of sources.catalog) {
    for (const label of [...new Set(exercise.muscle_groups)].sort()) addCatalogEdge("targets", "muscle", exercise, label);
    for (const label of [...new Set(exercise.joints_loaded)].sort()) addCatalogEdge("stresses", "joint", exercise, label);
    for (const label of [...new Set(exercise.movement_patterns)].sort()) addCatalogEdge("expresses", "movement-pattern", exercise, label);
    for (const label of [...new Set(exercise.equipment_required)].sort()) addCatalogEdge("requires", "equipment", exercise, label);
  }

  for (const record of sources.anatomy.part_of) {
    addEdge(record.assertion_id, {
      kind: "part-of",
      fromConceptId: record.child_id,
      fromKind: record.child_kind,
      toConceptId: record.parent_id,
      toKind: record.parent_kind,
      source: source(record.source, record.assertion_id),
    });
  }
  for (const record of sources.anatomy.exercise_stresses) {
    addEdge(record.assertion_id, {
      kind: "stresses",
      fromConceptId: record.exercise_id,
      fromKind: "exercise",
      toConceptId: record.anatomy_id,
      toKind: record.anatomy_kind,
      source: source(record.source, record.assertion_id),
    });
  }
  for (const record of sources.demands.assignments) {
    addEdge(record.assertion_id, {
      kind: "has-demand",
      fromConceptId: record.exercise_id,
      fromKind: "exercise",
      toConceptId: record.demand_id,
      toKind: "movement-demand",
      source: source(record.source, record.assertion_id),
    });
  }
  for (const record of sources.substitutions.records) {
    addEdge(record.assertion_id, {
      kind: "substitution-candidate-for",
      fromConceptId: record.source_exercise_id,
      fromKind: "exercise",
      toConceptId: record.target_exercise_id,
      toKind: "exercise",
      rank: record.rank,
      preservedIntent: record.preserved_intent,
      curator: record.review.reviewer,
      reviewedAt: record.review.reviewed_at,
      source: source(record.source, record.assertion_id),
    });
  }
  for (const record of sources.rules.records) {
    addEdge([record.assertion_id, "constraint"], {
      kind: "has-constraint",
      fromConceptId: record.condition_id,
      fromKind: "condition",
      toConceptId: record.stable_id,
      toKind: "clinical-rule",
      source: source(record.source, record.assertion_id),
    });
    addEdge([record.assertion_id, "target"], {
      kind: record.target.edge_kind,
      fromConceptId: record.stable_id,
      fromKind: "clinical-rule",
      toConceptId: record.target.target_id,
      toKind: record.target.target_kind,
      source: source(record.source, record.assertion_id),
    } as MovementEdgeInput);
    for (const evidenceId of record.evidence_ids) {
      addEdge([record.assertion_id, "evidence", evidenceId], {
        kind: "supported-by",
        fromConceptId: record.stable_id,
        fromKind: "clinical-rule",
        toConceptId: evidenceId,
        toKind: "evidence-source",
        source: source(record.source, record.assertion_id),
      });
    }
  }
  for (const record of reviewedMappings) {
    addEdge(record.assertion_id, {
      kind: "maps-to",
      fromConceptId: record.target_concept_id,
      fromKind: record.target_kind,
      toConceptId: record.ontology_concept_id,
      toKind: "ontology-concept",
      mappingAssertionId: record.mapping_id,
      relation: record.relation,
      confidence: record.confidence,
      rationale: record.rationale,
      curator: record.curator,
      reviewedAt: record.reviewed_at,
      sourceRelease: record.source_release,
      sourceArtifactDigest: record.source_artifact_digest,
      source: source(record.source, record.assertion_id),
    });
  }

  const revisionConceptId = graphRevisionId;
  const activityConceptId = `ingestion-activity:${graphRevisionId.slice("graph:sha256:".length)}`;
  addNode(revisionConceptId, {
    conceptId: revisionConceptId,
    kind: "graph-revision",
    label: revisionConceptId,
    createdAt: "2026-08-06T00:00:00.000Z",
    validationResult: "valid",
    sourceDigests: Object.fromEntries(sourceDigests),
    source: { sourceId: "source:movement-graph-compiler", sourceRevision: MOVEMENT_GRAPH_COMPILER_VERSION },
  });
  addNode(activityConceptId, {
    conceptId: activityConceptId,
    kind: "ingestion-activity",
    label: "Movement graph deterministic compilation",
    softwareVersion: MOVEMENT_GRAPH_COMPILER_VERSION,
    startedAt: "2026-08-06T00:00:00.000Z",
    endedAt: "2026-08-06T00:00:00.000Z",
    inputConceptIds: [...manifestEvidenceIds].sort(),
    outcome: "succeeded",
    source: { sourceId: "source:movement-graph-compiler", sourceRevision: MOVEMENT_GRAPH_COMPILER_VERSION },
  });
  for (const node of nodes.filter((item) => item.kind !== "graph-revision" && item.kind !== "ingestion-activity")) {
    addEdge(["in-revision", node.conceptId], {
      kind: "in-revision",
      fromConceptId: node.conceptId,
      fromKind: node.kind,
      toConceptId: revisionConceptId,
      toKind: "graph-revision",
      source: node.source,
    } as MovementEdgeInput);
  }
  addEdge("was-generated-by", {
    kind: "was-generated-by",
    fromConceptId: revisionConceptId,
    fromKind: "graph-revision",
    toConceptId: activityConceptId,
    toKind: "ingestion-activity",
    source: { sourceId: "source:movement-graph-compiler", sourceRevision: MOVEMENT_GRAPH_COMPILER_VERSION },
  });
  for (const evidenceId of manifestEvidenceIds) {
    const evidenceSource = nodeSourceById.get(evidenceId);
    if (!evidenceSource) throw new Error(`Missing manifest evidence source ${evidenceId}`);
    addEdge(["used", evidenceId], {
      kind: "used",
      fromConceptId: activityConceptId,
      fromKind: "ingestion-activity",
      toConceptId: evidenceId,
      toKind: "evidence-source",
      source: evidenceSource,
    });
  }

  const snapshot = {
    graphRevisionId,
    nodes: nodes.sort((left, right) => left.assertionId.localeCompare(right.assertionId)),
    edges: edges.sort((left, right) => left.assertionId.localeCompare(right.assertionId)),
  } satisfies MovementGraphSnapshot;
  const report = validateMovementGraph(snapshot);
  return report.status === "valid"
    ? { status: "valid", snapshot: deepFreeze(snapshot) }
    : { status: "invalid", report };
}

export function compileDefaultMovementGraph() {
  return compileMovementGraph(movementGraphSources);
}
