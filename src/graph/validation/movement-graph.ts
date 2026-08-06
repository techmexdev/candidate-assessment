import type { MovementGraphSnapshot } from "../../domain/contracts/movement-graph";
import {
  ALLOWED_SKOS_RELATIONS,
  CLINICAL_RULE_EFFECT_TARGET_EDGE,
  CLINICAL_RULE_TARGET_EDGE_KINDS,
  MOVEMENT_EDGE_ENDPOINTS,
  MOVEMENT_GRAPH_LIMITS,
} from "../schema/movement-schema";

export type MovementGraphValidationErrorCode =
  | "duplicate_concept_id" | "duplicate_assertion_id" | "dangling_reference" | "invalid_endpoint"
  | "forbidden_direct_clinical_edge" | "unsupported_mapping_relation" | "incomplete_mapping"
  | "invalid_local_only_mapping" | "rule_effect_mismatch" | "incomplete_clinical_rule" | "anatomy_cycle"
  | "mixed_revision" | "bounds_exceeded";
export type MovementGraphValidationError = { readonly code: MovementGraphValidationErrorCode; readonly message: string; readonly assertionId?: string };
export type MovementGraphValidationReport =
  | { readonly status: "valid"; readonly errors: readonly [] }
  | { readonly status: "invalid"; readonly errors: readonly MovementGraphValidationError[] };

const required = (value: unknown) => typeof value === "string" && value.trim().length > 0;

export function validateMovementGraph(snapshot: MovementGraphSnapshot): MovementGraphValidationReport {
  const errors: MovementGraphValidationError[] = [];
  const add = (code: MovementGraphValidationErrorCode, message: string, assertionId?: string) => errors.push({ code, message, assertionId });
  if (snapshot.nodes.length > MOVEMENT_GRAPH_LIMITS.maxNodes || snapshot.edges.length > MOVEMENT_GRAPH_LIMITS.maxEdges) add("bounds_exceeded", "Snapshot exceeds compiler bounds");
  const concepts = new Map<string, (typeof snapshot.nodes)[number]>();
  const assertions = new Set<string>();
  for (const node of snapshot.nodes) {
    if (concepts.has(node.conceptId)) add("duplicate_concept_id", `Duplicate concept ${node.conceptId}`, node.assertionId);
    else concepts.set(node.conceptId, node);
    if (assertions.has(node.assertionId)) add("duplicate_assertion_id", `Duplicate assertion ${node.assertionId}`, node.assertionId);
    assertions.add(node.assertionId);
    if (node.graphRevisionId !== snapshot.graphRevisionId) add("mixed_revision", `Node ${node.conceptId} has another revision`, node.assertionId);
    if (node.kind === "clinical-rule") {
      if (!required(node.reviewer) || !required(node.ruleRevision) || node.evidenceConceptIds.length === 0
        || node.applicability.conditionStatuses.length === 0 || node.applicability.recoveryStages.length === 0
        || node.applicability.severityBands.length === 0) add("incomplete_clinical_rule", `Incomplete clinical rule ${node.conceptId}`, node.assertionId);
    }
  }
  for (const edge of snapshot.edges) {
    const edgeKind = edge.kind as string;
    const fromKind = edge.fromKind as string;
    const toKind = edge.toKind as string;
    if (assertions.has(edge.assertionId)) add("duplicate_assertion_id", `Duplicate assertion ${edge.assertionId}`, edge.assertionId);
    assertions.add(edge.assertionId);
    if (edge.graphRevisionId !== snapshot.graphRevisionId) add("mixed_revision", `Edge ${edge.assertionId} has another revision`, edge.assertionId);
    if (edgeKind === "contraindicated-for" || (fromKind === "condition" && toKind === "exercise")) {
      add("forbidden_direct_clinical_edge", "Direct condition-to-exercise clinical assertions are forbidden", edge.assertionId);
      continue;
    }
    const endpoint = MOVEMENT_EDGE_ENDPOINTS[edgeKind as keyof typeof MOVEMENT_EDGE_ENDPOINTS];
    if (!endpoint || !(endpoint.from as readonly string[]).includes(fromKind) || !(endpoint.to as readonly string[]).includes(toKind)) add("invalid_endpoint", `Invalid endpoints for ${edge.kind}`, edge.assertionId);
    const from = concepts.get(edge.fromConceptId);
    const to = concepts.get(edge.toConceptId);
    if (!from || !to) add("dangling_reference", `Dangling reference on ${edge.assertionId}`, edge.assertionId);
    else if (from.kind !== edge.fromKind || to.kind !== edge.toKind) add("invalid_endpoint", `Declared kinds do not match endpoints`, edge.assertionId);
    if (edge.kind === "maps-to") {
      if (!(ALLOWED_SKOS_RELATIONS as readonly string[]).includes(edge.relation)) add("unsupported_mapping_relation", `Unsupported SKOS relation ${edge.relation}`, edge.assertionId);
      const ontology = to?.kind === "ontology-concept" ? to : undefined;
      if (!required(edge.mappingAssertionId) || !required(edge.rationale) || !required(edge.curator) || !required(edge.reviewedAt)
        || !required(edge.sourceRelease) || !required(edge.sourceArtifactDigest) || !ontology || !required(ontology.code)
        || !required(ontology.conceptUri) || !required(ontology.sourceRelease)) add("incomplete_mapping", `Incomplete mapping ${edge.assertionId}`, edge.assertionId);
    }
    if ((CLINICAL_RULE_TARGET_EDGE_KINDS as readonly string[]).includes(edgeKind)) {
      const rule = from?.kind === "clinical-rule" ? from : undefined;
      if (!rule || CLINICAL_RULE_EFFECT_TARGET_EDGE[rule.effect] !== edge.kind) add("rule_effect_mismatch", `Rule effect does not match ${edge.kind}`, edge.assertionId);
    }
  }
  for (const node of snapshot.nodes.filter((item) => item.kind === "clinical-rule")) {
    const supported = snapshot.edges.some((edge) => edge.kind === "supported-by" && edge.fromConceptId === node.conceptId);
    const constraint = snapshot.edges.some((edge) => edge.kind === "has-constraint" && edge.toConceptId === node.conceptId);
    const target = snapshot.edges.some((edge) => (CLINICAL_RULE_TARGET_EDGE_KINDS as readonly string[]).includes(edge.kind) && edge.fromConceptId === node.conceptId);
    if (!supported || !constraint || !target) add("incomplete_clinical_rule", `Broken clinical rule path ${node.conceptId}`, node.assertionId);
  }
  const children = new Map<string, string[]>();
  for (const edge of snapshot.edges.filter((item) => item.kind === "part-of")) children.set(edge.fromConceptId, [...(children.get(edge.fromConceptId) ?? []), edge.toConceptId]);
  const visiting = new Set<string>(); const visited = new Set<string>();
  const cycle = (id: string): boolean => { if (visiting.has(id)) return true; if (visited.has(id)) return false; visiting.add(id); if ((children.get(id) ?? []).some(cycle)) return true; visiting.delete(id); visited.add(id); return false; };
  if ([...children.keys()].some(cycle)) add("anatomy_cycle", "PART_OF must be acyclic and child-to-parent");
  return errors.length ? { status: "invalid", errors } : { status: "valid", errors: [] };
}

export function invalidSourceReport(errors: readonly MovementGraphValidationError[]): MovementGraphValidationReport {
  return { status: "invalid", errors };
}
