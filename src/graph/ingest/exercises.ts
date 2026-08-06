import exercisesData from "../../../data/exercises.json";
import mappingsData from "../../../data/movement-ontology-mappings.json";
import type { OntologyMappingRecord } from "../../domain/contracts/ontology";
import type {
  MovementEdge,
  MovementGraphSnapshot,
  MovementNode,
  OntologyMapping,
} from "../../domain/contracts/movement-graph";

export type CatalogExercise = (typeof exercisesData)[number];

const mappings = mappingsData as OntologyMappingRecord[];

function slug(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function canonicalId(kind: MovementNode["kind"], label: string) {
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
  kind: MovementNode["kind"],
  label: string,
  source: MovementNode["source"],
  metadata: MovementNode["metadata"] = {},
  explicitId?: string,
): MovementNode {
  const id = explicitId ?? canonicalId(kind, label);
  const nodeMappings: OntologyMapping[] = mappings
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

function edge(from: string, to: string, kind: MovementEdge["kind"], source: string): MovementEdge {
  return { id: `${kind}:${from}->${to}`, from, to, kind, source };
}

function addNode(nodes: Map<string, MovementNode>, value: MovementNode) {
  const existing = nodes.get(value.id);
  if (!existing) {
    nodes.set(value.id, value);
    return;
  }
  existing.aliases = [...new Set([...existing.aliases, ...value.aliases])].sort();
  existing.ontologyMappings = [...existing.ontologyMappings, ...value.ontologyMappings];
}

function addEdge(edges: Map<string, MovementEdge>, value: MovementEdge) {
  if (!edges.has(value.id)) edges.set(value.id, value);
}

export function buildMovementGraph(
  exercises: CatalogExercise[],
  revision = "movement-v1",
): MovementGraphSnapshot {
  const nodes = new Map<string, MovementNode>();
  const edges = new Map<string, MovementEdge>();
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
  const condition = node("condition", "patellofemoral pain", "curated-clinical-subset");
  addNode(nodes, knee);
  addNode(nodes, patellofemoral);
  addNode(nodes, condition);
  addEdge(edges, edge(patellofemoral.id, knee.id, "part-of", "curated-clinical-subset"));

  for (const exercise of exercises) {
    const exerciseNode = nodes.get(`exercise:${exercise.id}`)!;
    if (exercise.movement_patterns.includes("lower push - split squat") || exercise.movement_patterns.includes("cardio - plyometric")) {
      addEdge(edges, edge(condition.id, exerciseNode.id, "contraindicated-for", "curated-clinical-subset"));
    }
  }

  for (const left of exercises) {
    for (const right of exercises) {
      if (left.id >= right.id) continue;
      const samePattern = left.movement_patterns.some((pattern) => right.movement_patterns.includes(pattern));
      const sharedMuscle = left.muscle_groups.some((muscle) => right.muscle_groups.includes(muscle));
      if (!samePattern || !sharedMuscle) continue;
      addEdge(edges, edge(`exercise:${left.id}`, `exercise:${right.id}`, "equivalent-to", "catalog-taxonomy"));
      addEdge(edges, edge(`exercise:${right.id}`, `exercise:${left.id}`, "equivalent-to", "catalog-taxonomy"));
    }
  }

  return {
    revision,
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export const defaultMovementGraph = buildMovementGraph(exercisesData);
