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
  MovementGraphEdgeAssertion,
  MovementGraphNodeAssertion,
  MovementGraphSnapshot,
  MovementNodeKind,
} from "../../domain/contracts/movement-graph";
import { deriveAssertionId, deriveRevisionId, canonicalJson, deepFreeze, sha256 } from "../revisions/movement-graph";
import { MOVEMENT_GRAPH_COMPILER_VERSION, MOVEMENT_GRAPH_SCHEMA_VERSION } from "../schema/movement-schema";
import {
  invalidSourceReport,
  validateMovementGraph,
  type MovementGraphValidationError,
  type MovementGraphValidationReport,
} from "../validation/movement-graph";

export const movementGraphSources = deepFreeze({ catalog, concepts, anatomy, demands, evidence, rules, substitutions, mappings, sourceReviews });
export type MovementGraphSources = typeof movementGraphSources;
export type MovementGraphCompileResult =
  | { readonly status: "valid"; readonly snapshot: MovementGraphSnapshot }
  | { readonly status: "invalid"; readonly report: MovementGraphValidationReport };

type SourceRecord = { source_id: string; source_revision: string };
const source = (record: SourceRecord, sourceRecordId?: string): AssertionProvenance => ({
  sourceId: record.source_id, sourceRevision: record.source_revision, ...(sourceRecordId ? { sourceRecordId } : {}),
});
const slug = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function compileMovementGraph(sources: MovementGraphSources): MovementGraphCompileResult {
  const sourceEntries = Object.entries(sources).sort(([left], [right]) => left.localeCompare(right));
  const sourceDigests = sourceEntries.map(([name, value]) => [name, `sha256:${sha256(canonicalJson(value))}`] as [string, string]);
  const graphRevisionId = deriveRevisionId(MOVEMENT_GRAPH_SCHEMA_VERSION, MOVEMENT_GRAPH_COMPILER_VERSION, sourceDigests);
  const sourceErrors: MovementGraphValidationError[] = [];
  const mappingsManifest = sources.mappings as any;
  for (const record of mappingsManifest.records as any[]) {
    if (record.status === "local-only") {
      if ("source_code" in record || "source_uri" in record || "ontology_concept_id" in record) sourceErrors.push({ code: "invalid_local_only_mapping", message: `Local-only mapping ${record.verification_id} contains an external identifier` });
      if (!record.verification_id || record.verification_status !== "not-verified" || !record.review_reason || record.review?.status !== "reviewed") sourceErrors.push({ code: "invalid_local_only_mapping", message: `Incomplete local-only mapping ${record.verification_id ?? "unknown"}` });
    } else if (record.status === "reviewed") {
      const required = [record.mapping_id, record.assertion_id, record.source_code, record.source_uri, record.source_release, record.source_artifact_digest, record.curator, record.reviewed_at];
      if (required.some((value) => typeof value !== "string" || value.length === 0) || record.review?.status !== "reviewed") sourceErrors.push({ code: "incomplete_mapping", message: `Incomplete reviewed mapping ${record.mapping_id ?? "unknown"}` });
    }
  }
  const effectEdges: Record<string, string> = { "hard-contraindication": "contraindicates", caution: "cautions", "down-rank": "downranks" };
  for (const record of (sources.rules as any).records as any[]) {
    if (!record.clinical_review || record.clinical_review.status !== "approved" || !record.clinical_review.reviewer
      || record.review?.status !== "reviewed" || !Array.isArray(record.evidence_ids) || record.evidence_ids.length === 0) {
      sourceErrors.push({ code: "incomplete_clinical_rule", message: `Incomplete clinical rule ${record.stable_id ?? "unknown"}` });
    }
    if (effectEdges[record.effect] !== record.target?.edge_kind) sourceErrors.push({ code: "rule_effect_mismatch", message: `Rule effect mismatch ${record.stable_id ?? "unknown"}` });
  }
  if (sourceErrors.length) return { status: "invalid", report: invalidSourceReport(sourceErrors) };

  const nodes: MovementGraphNodeAssertion[] = [];
  const edges: MovementGraphEdgeAssertion[] = [];
  const nodeSourceById = new Map<string, AssertionProvenance>();
  const addNode = (identity: unknown, value: Omit<MovementGraphNodeAssertion, "assertionId" | "graphRevisionId">) => {
    const assertionId = deriveAssertionId(graphRevisionId, ["node", identity]);
    const node = { ...value, assertionId, graphRevisionId } as MovementGraphNodeAssertion;
    nodes.push(node); nodeSourceById.set(node.conceptId, node.source); return node;
  };
  const addEdge = (identity: unknown, value: Omit<MovementGraphEdgeAssertion, "assertionId" | "graphRevisionId">) => {
    const assertionId = deriveAssertionId(graphRevisionId, ["edge", identity]);
    edges.push({ ...value, assertionId, graphRevisionId } as MovementGraphEdgeAssertion);
  };

  for (const record of (sources.concepts as any).records as any[]) {
    const common = { conceptId: record.stable_id, kind: record.kind, label: record.label, source: source(record.source, record.stable_id) };
    const aliases = [...record.aliases].sort();
    if (record.kind === "exercise") addNode(record.stable_id, { ...common, aliases, catalogId: record.catalog_id, catalogRevision: record.source.source_revision, attributes: { priorityTier: String(record.catalog.priority_tier), supportsWeight: record.catalog.supports_weight, isBilateral: record.catalog.is_bilateral, ...(record.catalog.bilateral_pair_id ? { bilateralPairCatalogId: record.catalog.bilateral_pair_id } : {}) } } as any);
    else if (record.kind === "movement-pattern") addNode(record.stable_id, { ...common, aliases, taxonomyId: record.stable_id } as any);
    else if (record.kind === "equipment") addNode(record.stable_id, { ...common, aliases, category: record.catalog_scope } as any);
    else addNode(record.stable_id, { ...common, aliases } as any);
  }
  for (const record of (sources.demands as any).records as any[]) addNode(record.stable_id, { conceptId: record.stable_id, kind: "movement-demand", label: record.label, definition: record.definition, scope: canonicalJson(record.scope), reviewerEvidenceIds: [...record.reviewer_evidence_ids].sort(), source: source(record.source, record.stable_id) } as any);
  for (const record of (sources.evidence as any).records as any[]) addNode(record.stable_id, { conceptId: record.stable_id, kind: "evidence-source", label: record.title, title: record.title, owner: record.owner, versionOrAccessDate: record.version_or_access_date, evidenceRole: record.evidence_role, source: source(record.source, record.stable_id) } as any);
  for (const record of (sources.sourceReviews as any).records as any[]) addNode(`evidence-source:${record.source_id}`, { conceptId: `evidence-source:${record.source_id}`, kind: "evidence-source", label: record.title, title: record.title, owner: record.publisher, versionOrAccessDate: record.source_release, uri: record.uri, evidenceRole: "ontology", source: source(record, record.source_id) } as any);
  const manifestEvidenceIds: string[] = [];
  for (const [name, value] of sourceEntries) {
    const manifest = value as any; const conceptId = `evidence-source:${manifest.manifest_id ?? `catalog:${name}`}`;
    manifestEvidenceIds.push(conceptId);
    addNode(conceptId, { conceptId, kind: "evidence-source", label: manifest.manifest_id ?? "Exercise catalog", title: manifest.manifest_id ?? "Exercise catalog", owner: "checked-in source", versionOrAccessDate: manifest.revision ?? sourceDigests.find(([key]) => key === name)![1], evidenceRole: name === "catalog" ? "catalog" : "graph-build", source: { sourceId: manifest.manifest_id ?? "source:exercise-catalog", sourceRevision: manifest.revision ?? sourceDigests.find(([key]) => key === name)![1] } } as any);
  }
  for (const record of (sources.rules as any).records as any[]) addNode(record.stable_id, { conceptId: record.stable_id, kind: "clinical-rule", label: record.stable_id, effect: record.effect, severity: record.severity, applicability: { conditionStatuses: [...record.applicability.condition_statuses].sort(), recoveryStages: [...record.applicability.recovery_stages].sort(), severityBands: [...record.applicability.severity_bands].sort(), lateralityPolicy: record.applicability.laterality_policy }, overridePolicy: { allowed: record.override_policy.allowed, ...(record.override_policy.required_role ? { requiredRole: record.override_policy.required_role } : {}), rationaleRequired: record.override_policy.rationale_required }, evidenceConceptIds: [...record.evidence_ids].sort(), reviewer: record.clinical_review.reviewer, ruleRevision: record.source.source_revision, source: source(record.source, record.assertion_id) } as any);
  for (const record of (sources.mappings as any).records.filter((item: any) => item.status === "reviewed")) addNode(record.ontology_concept_id, { conceptId: record.ontology_concept_id, kind: "ontology-concept", label: record.source_term, ontology: record.source_ontology, code: record.source_code, conceptUri: record.source_uri, preferredLabel: record.source_term, sourceRelease: record.source_release, status: record.external_status, source: source(record.source, record.mapping_id) } as any);

  const labelIds = new Map(nodes.filter((node: any) => "aliases" in node).map((node: any) => [`${node.kind}:${slug(node.label)}`, node.conceptId]));
  const catalogSource: AssertionProvenance = { sourceId: "source:exercise-catalog", sourceRevision: (sources.concepts as any).source_artifacts[0].source_revision };
  for (const exercise of sources.catalog as any[]) {
    const exerciseId = `exercise:${exercise.id}`;
    const relationships: [string, MovementNodeKind, string[]][] = [["targets", "muscle", exercise.muscle_groups], ["stresses", "joint", exercise.joints_loaded], ["expresses", "movement-pattern", exercise.movement_patterns], ["requires", "equipment", exercise.equipment_required]];
    for (const [kind, targetKind, labels] of relationships) for (const label of [...new Set(labels)].sort()) {
      const targetId = labelIds.get(`${targetKind}:${slug(label)}`) ?? `${targetKind}:${slug(label)}`;
      addEdge([kind, exerciseId, targetId], { kind, fromConceptId: exerciseId, fromKind: "exercise", toConceptId: targetId, toKind: targetKind, source: { ...catalogSource, sourceRecordId: exercise.id } } as any);
    }
  }
  for (const record of (sources.anatomy as any).part_of) addEdge(record.assertion_id, { kind: "part-of", fromConceptId: record.child_id, fromKind: record.child_kind, toConceptId: record.parent_id, toKind: record.parent_kind, source: source(record.source, record.assertion_id) } as any);
  for (const record of (sources.anatomy as any).exercise_stresses) addEdge(record.assertion_id, { kind: "stresses", fromConceptId: record.exercise_id, fromKind: "exercise", toConceptId: record.anatomy_id, toKind: record.anatomy_kind, source: source(record.source, record.assertion_id) } as any);
  for (const record of (sources.demands as any).assignments) addEdge(record.assertion_id, { kind: "has-demand", fromConceptId: record.exercise_id, fromKind: "exercise", toConceptId: record.demand_id, toKind: "movement-demand", source: source(record.source, record.assertion_id) } as any);
  for (const record of (sources.substitutions as any).records) addEdge(record.assertion_id, { kind: "substitution-candidate-for", fromConceptId: record.source_exercise_id, fromKind: "exercise", toConceptId: record.target_exercise_id, toKind: "exercise", rank: record.rank, preservedIntent: record.preserved_intent, curator: record.review.reviewer, reviewedAt: record.review.reviewed_at, source: source(record.source, record.assertion_id) } as any);
  for (const record of (sources.rules as any).records) {
    addEdge([record.assertion_id, "constraint"], { kind: "has-constraint", fromConceptId: record.condition_id, fromKind: "condition", toConceptId: record.stable_id, toKind: "clinical-rule", source: source(record.source, record.assertion_id) } as any);
    addEdge([record.assertion_id, "target"], { kind: record.target.edge_kind, fromConceptId: record.stable_id, fromKind: "clinical-rule", toConceptId: record.target.target_id, toKind: record.target.target_kind, source: source(record.source, record.assertion_id) } as any);
    for (const evidenceId of record.evidence_ids) addEdge([record.assertion_id, "evidence", evidenceId], { kind: "supported-by", fromConceptId: record.stable_id, fromKind: "clinical-rule", toConceptId: evidenceId, toKind: "evidence-source", source: source(record.source, record.assertion_id) } as any);
  }
  for (const record of (sources.mappings as any).records.filter((item: any) => item.status === "reviewed")) addEdge(record.assertion_id, { kind: "maps-to", fromConceptId: record.target_concept_id, fromKind: record.target_kind, toConceptId: record.ontology_concept_id, toKind: "ontology-concept", mappingAssertionId: record.mapping_id, relation: record.relation, confidence: record.confidence, rationale: record.rationale, curator: record.curator, reviewedAt: record.reviewed_at, sourceRelease: record.source_release, sourceArtifactDigest: record.source_artifact_digest, source: source(record.source, record.assertion_id) } as any);

  const revisionConceptId = graphRevisionId;
  const activityConceptId = `ingestion-activity:${graphRevisionId.slice("graph:sha256:".length)}`;
  addNode(revisionConceptId, { conceptId: revisionConceptId, kind: "graph-revision", label: revisionConceptId, createdAt: "2026-08-06T00:00:00.000Z", validationResult: "valid", sourceDigests: Object.fromEntries(sourceDigests), source: { sourceId: "source:movement-graph-compiler", sourceRevision: MOVEMENT_GRAPH_COMPILER_VERSION } } as any);
  addNode(activityConceptId, { conceptId: activityConceptId, kind: "ingestion-activity", label: "Movement graph deterministic compilation", softwareVersion: MOVEMENT_GRAPH_COMPILER_VERSION, startedAt: "2026-08-06T00:00:00.000Z", endedAt: "2026-08-06T00:00:00.000Z", inputConceptIds: [...manifestEvidenceIds].sort(), outcome: "succeeded", source: { sourceId: "source:movement-graph-compiler", sourceRevision: MOVEMENT_GRAPH_COMPILER_VERSION } } as any);
  for (const node of nodes.filter((item) => item.kind !== "graph-revision" && item.kind !== "ingestion-activity")) addEdge(["in-revision", node.conceptId], { kind: "in-revision", fromConceptId: node.conceptId, fromKind: node.kind, toConceptId: revisionConceptId, toKind: "graph-revision", source: node.source } as any);
  addEdge("was-generated-by", { kind: "was-generated-by", fromConceptId: revisionConceptId, fromKind: "graph-revision", toConceptId: activityConceptId, toKind: "ingestion-activity", source: { sourceId: "source:movement-graph-compiler", sourceRevision: MOVEMENT_GRAPH_COMPILER_VERSION } } as any);
  for (const evidenceId of manifestEvidenceIds) addEdge(["used", evidenceId], { kind: "used", fromConceptId: activityConceptId, fromKind: "ingestion-activity", toConceptId: evidenceId, toKind: "evidence-source", source: nodeSourceById.get(evidenceId)! } as any);

  const snapshot = { graphRevisionId, nodes: nodes.sort((a, b) => a.assertionId.localeCompare(b.assertionId)), edges: edges.sort((a, b) => a.assertionId.localeCompare(b.assertionId)) } satisfies MovementGraphSnapshot;
  const report = validateMovementGraph(snapshot);
  return report.status === "valid" ? { status: "valid", snapshot: deepFreeze(snapshot) } : { status: "invalid", report };
}

export function compileDefaultMovementGraph() { return compileMovementGraph(movementGraphSources); }
