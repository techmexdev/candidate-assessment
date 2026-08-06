import type { MovementEdgeKind, MovementNodeKind } from "../../domain/contracts/movement-graph";

export const MOVEMENT_GRAPH_SCHEMA_VERSION = "movement-clinical-schema:1";
export const MOVEMENT_GRAPH_COMPILER_VERSION = "movement-clinical-compiler:1";
export const MOVEMENT_GRAPH_LIMITS = Object.freeze({ maxNodes: 512, maxEdges: 4096 });
export const MOVEMENT_GRAPH_QUERY_LIMITS = Object.freeze({ maxResults: 100, maxDepth: 16 });

export const MOVEMENT_EDGE_ENDPOINTS = Object.freeze({
  targets: { from: ["exercise"], to: ["muscle"] },
  stresses: { from: ["exercise"], to: ["joint", "body-region"] },
  expresses: { from: ["exercise"], to: ["movement-pattern"] },
  "has-demand": { from: ["exercise"], to: ["movement-demand"] },
  requires: { from: ["exercise"], to: ["equipment"] },
  "part-of": { from: ["muscle", "joint", "body-region"], to: ["joint", "body-region"] },
  "variant-of": { from: ["exercise"], to: ["exercise"] },
  "substitution-candidate-for": { from: ["exercise"], to: ["exercise"] },
  "has-constraint": { from: ["condition"], to: ["clinical-rule"] },
  contraindicates: { from: ["clinical-rule"], to: ["movement-demand", "movement-pattern", "joint", "body-region"] },
  cautions: { from: ["clinical-rule"], to: ["movement-demand", "movement-pattern", "joint", "body-region"] },
  downranks: { from: ["clinical-rule"], to: ["movement-demand", "movement-pattern", "joint", "body-region"] },
  "maps-to": { from: ["exercise", "muscle", "joint", "body-region", "movement-pattern", "movement-demand", "equipment", "condition"], to: ["ontology-concept"] },
  "supported-by": { from: ["clinical-rule"], to: ["evidence-source"] },
  "in-revision": { from: ["exercise", "muscle", "joint", "body-region", "movement-pattern", "movement-demand", "equipment", "condition", "clinical-rule", "ontology-concept", "evidence-source"], to: ["graph-revision"] },
  "was-generated-by": { from: ["graph-revision"], to: ["ingestion-activity"] },
  used: { from: ["ingestion-activity"], to: ["evidence-source"] },
} satisfies Record<MovementEdgeKind, { readonly from: readonly MovementNodeKind[]; readonly to: readonly MovementNodeKind[] }>);

export const ALLOWED_SKOS_RELATIONS = Object.freeze(["exactMatch", "closeMatch", "broadMatch", "narrowMatch"] as const);
