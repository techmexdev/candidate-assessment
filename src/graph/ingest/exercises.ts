import exercisesData from "../../../data/exercises.json";
import mappingsData from "../../../data/movement-ontology-mappings.json";
import type { LegacyOntologyMappingRecord } from "../../domain/contracts/ontology";
import type {
  LegacyMovementEdge,
  LegacyMovementGraphSnapshot,
  LegacyMovementNode,
  LegacyOntologyMapping,
} from "../../domain/contracts/movement-graph";

export type CatalogExercise = (typeof exercisesData)[number];

type CuratedMappingRecord = (typeof mappingsData.records)[number];

const reviewedTargetIds: Readonly<Record<string, Pick<LegacyOntologyMappingRecord, "targetKind" | "targetId">>> = {
  "condition:patellofemoral-pain-syndrome": {
    targetKind: "condition",
    targetId: "condition:patellofemoral-pain",
  },
  "joint:knee": { targetKind: "anatomy", targetId: "anatomy:knee" },
  "joint:patellofemoral": {
    targetKind: "anatomy",
    targetId: "anatomy:patellofemoral-joint",
  },
  "joint:shoulder": { targetKind: "anatomy", targetId: "anatomy:shoulder" },
};

function isLegacyRelation(value: string): value is LegacyOntologyMappingRecord["relation"] {
  return ["exactMatch", "closeMatch", "broadMatch", "narrowMatch"].includes(value);
}

function toLegacyMapping(record: CuratedMappingRecord): LegacyOntologyMappingRecord | undefined {
  if (record.status !== "reviewed") return undefined;
  if (
    typeof record.mapping_id !== "string"
    || typeof record.source_term !== "string"
    || typeof record.source_uri !== "string"
    || typeof record.relation !== "string"
    || !isLegacyRelation(record.relation)
    || typeof record.confidence !== "number"
    || typeof record.rationale !== "string"
  ) return undefined;

  const target = reviewedTargetIds[record.target_concept_id];
  if (!target) return undefined;

  return {
    id: record.mapping_id,
    sourceOntology: record.source_ontology,
    sourceTerm: record.source_term,
    sourceUri: record.source_uri,
    targetKind: target.targetKind,
    targetId: target.targetId,
    relation: record.relation,
    confidence: record.confidence,
    rationale: record.rationale,
    revision: record.source_release,
  };
}

const mappings: LegacyOntologyMappingRecord[] = mappingsData.records.flatMap((record) => {
  const mapping = toLegacyMapping(record);
  return mapping ? [mapping] : [];
});

function slug(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function canonicalId(kind: LegacyMovementNode["kind"], label: string) {
  return `${kind}:${slug(label)}`;
}

function aliasesFor(label: string) {
  const aliases = new Set([label, label.replaceAll("-", " ")]);
  if (label.toLowerCase() === "kettlebell") aliases.add("kettle bell");
  if (label.toLowerCase() === "dumbbell") aliases.add("db");
  if (label.toLowerCase() === "barbell") aliases.add("bb");
  return [...aliases];
}

function node(
  kind: LegacyMovementNode["kind"],
  label: string,
  source: LegacyMovementNode["source"],
  metadata: LegacyMovementNode["metadata"] = {},
  explicitId?: string,
): LegacyMovementNode {
  const id = explicitId ?? canonicalId(kind, label);
  const nodeMappings: LegacyOntologyMapping[] = mappings
    .filter((mapping) => mapping.targetId === id)
    .map((mapping) => ({
      id: mapping.id,
      sourceOntology: mapping.sourceOntology,
      sourceTerm: mapping.sourceTerm,
      sourceUri: mapping.sourceUri,
      relation: mapping.relation,
      confidence: mapping.confidence,
      rationale: mapping.rationale,
      revision: mapping.revision,
    }));

  return { id, kind, label, aliases: aliasesFor(label), source, ontologyMappings: nodeMappings, metadata };
}

function edge(from: string, to: string, kind: LegacyMovementEdge["kind"], source: string): LegacyMovementEdge {
  return { id: `${kind}:${from}->${to}`, from, to, kind, source };
}

function addNode(nodes: Map<string, LegacyMovementNode>, value: LegacyMovementNode) {
  const existing = nodes.get(value.id);
  if (!existing) {
    nodes.set(value.id, value);
    return;
  }
  existing.aliases = [...new Set([...existing.aliases, ...value.aliases])].sort();
  existing.ontologyMappings = [...existing.ontologyMappings, ...value.ontologyMappings];
}

function addEdge(edges: Map<string, LegacyMovementEdge>, value: LegacyMovementEdge) {
  if (!edges.has(value.id)) edges.set(value.id, value);
}

/** Transitional U3-to-U5 resolver fixture. The target compiler is movement-clinical.ts. */
export function buildLegacyMovementResolverGraph(
  exercises: CatalogExercise[],
  revision = "movement-v1",
): LegacyMovementGraphSnapshot {
  const nodes = new Map<string, LegacyMovementNode>();
  const edges = new Map<string, LegacyMovementEdge>();
  const seenExerciseIds = new Set<string>();

  for (const exercise of exercises) {
    if (seenExerciseIds.has(exercise.id)) throw new Error(`Duplicate exercise ID: ${exercise.id}`);
    seenExerciseIds.add(exercise.id);
    const exerciseNode = node("exercise", exercise.name, "exercise-catalog", {
      catalogId: exercise.id,
      priorityTier: exercise.priority_tier,
      supportsWeight: exercise.supports_weight,
      isBilateral: exercise.is_bilateral,
    }, `exercise:${exercise.id}`);
    addNode(nodes, exerciseNode);

    for (const muscle of exercise.muscle_groups) {
      const target = node("muscle", muscle, "exercise-catalog");
      addNode(nodes, target);
      addEdge(edges, edge(exerciseNode.id, target.id, "targets", "exercise-catalog"));
    }
    for (const joint of exercise.joints_loaded) {
      const target = node("anatomy", joint, "exercise-catalog");
      addNode(nodes, target);
      addEdge(edges, edge(exerciseNode.id, target.id, "stresses", "exercise-catalog"));
    }
    for (const pattern of exercise.movement_patterns) {
      const target = node("movement-pattern", pattern, "exercise-catalog");
      addNode(nodes, target);
      addEdge(edges, edge(exerciseNode.id, target.id, "follows", "exercise-catalog"));
    }
    for (const equipment of exercise.equipment_required) {
      const target = node("equipment", equipment, "exercise-catalog");
      addNode(nodes, target);
      addEdge(edges, edge(exerciseNode.id, target.id, "requires", "exercise-catalog"));
    }
  }

  const knee = node("anatomy", "knee", "curated-clinical-subset");
  const patellofemoral = node("anatomy", "patellofemoral joint", "curated-clinical-subset");
  addNode(nodes, knee);
  addNode(nodes, patellofemoral);
  addEdge(edges, edge(patellofemoral.id, knee.id, "part-of", "curated-clinical-subset"));

  return {
    revision,
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}
