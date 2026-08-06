import { describe, expect, it } from "vitest";
import type { MovementGraphSnapshot } from "../../src/domain/contracts/movement-graph";
import {
  compileDefaultMovementGraph,
  compileMovementGraph,
  movementGraphSources,
} from "../../src/graph/ingest/movement-clinical";
import { validateMovementGraph } from "../../src/graph/validation/movement-graph";

function validSnapshot() {
  const result = compileDefaultMovementGraph();
  expect(result.status).toBe("valid");
  if (result.status !== "valid") throw new Error("fixture did not compile");
  return result.snapshot;
}

function mutableCopy(snapshot: MovementGraphSnapshot): any {
  return structuredClone(snapshot);
}

function expectCode(snapshot: any, code: string) {
  const report = validateMovementGraph(snapshot);
  expect(report.status).toBe("invalid");
  expect(report.errors.map((error) => error.code)).toContain(code);
}

describe("movement graph compiler and validator", () => {
  it("pins the deterministic golden revision and deeply freezes the snapshot", () => {
    const first = compileDefaultMovementGraph();
    const second = compileMovementGraph(structuredClone(movementGraphSources));
    expect(first.status).toBe("valid");
    expect(second.status).toBe("valid");
    if (first.status !== "valid" || second.status !== "valid") return;

    expect(first.snapshot.graphRevisionId).toBe("graph:sha256:c94ad209883875ba3294388d3db82f4d2bcae2aefd55a11b7d1f52ddccb1217a");
    expect(second.snapshot).toEqual(first.snapshot);
    expect(Object.isFrozen(first.snapshot)).toBe(true);
    expect(Object.isFrozen(first.snapshot.nodes)).toBe(true);
    expect(Object.isFrozen(first.snapshot.nodes[0]?.source)).toBe(true);
    expect(() => (first.snapshot.nodes as any[]).push({})).toThrow();
  });

  it.each([
    ["duplicate_concept_id", (copy: any) => copy.nodes.push({ ...copy.nodes[0], assertionId: "assertion:duplicate-node" })],
    ["duplicate_assertion_id", (copy: any) => copy.edges.push({ ...copy.edges[0], fromConceptId: copy.edges[1].fromConceptId, toConceptId: copy.edges[1].toConceptId })],
    ["dangling_reference", (copy: any) => { copy.edges[0].toConceptId = "muscle:missing"; }],
    ["invalid_endpoint", (copy: any) => { copy.edges[0].fromKind = "condition"; }],
    ["forbidden_direct_clinical_edge", (copy: any) => copy.edges.push({ ...copy.edges[0], assertionId: "assertion:direct", kind: "contraindicated-for", fromKind: "condition", toKind: "exercise" })],
    ["unsupported_mapping_relation", (copy: any) => { copy.edges.find((edge: any) => edge.kind === "maps-to").relation = "relatedMatch"; }],
    ["incomplete_mapping", (copy: any) => { delete copy.edges.find((edge: any) => edge.kind === "maps-to").sourceArtifactDigest; }],
    ["rule_effect_mismatch", (copy: any) => { copy.nodes.find((node: any) => node.kind === "clinical-rule" && node.effect === "hard-contraindication").effect = "caution"; }],
    ["incomplete_clinical_rule", (copy: any) => { copy.nodes.find((node: any) => node.kind === "clinical-rule").reviewer = ""; }],
    ["anatomy_cycle", (copy: any) => { const edge = copy.edges.find((item: any) => item.kind === "part-of"); copy.edges.push({ ...edge, assertionId: "assertion:cycle", fromConceptId: edge.toConceptId, fromKind: edge.toKind, toConceptId: edge.fromConceptId, toKind: edge.fromKind }); }],
    ["mixed_revision", (copy: any) => { copy.edges[0].graphRevisionId = "graph:sha256:other"; }],
    ["bounds_exceeded", (copy: any) => { copy.nodes = Array.from({ length: 513 }, (_, index) => ({ ...copy.nodes[0], conceptId: `exercise:overflow-${index}`, assertionId: `assertion:overflow-${index}` })); }],
  ])("rejects %s", (code, mutate) => {
    const copy = mutableCopy(validSnapshot());
    mutate(copy);
    expectCode(copy, code);
  });

  it("returns a typed report and never a partial snapshot for invalid sources", () => {
    const sources = structuredClone(movementGraphSources) as any;
    sources.mappings.records.find((record: any) => record.status === "local-only").source_code = "invented";
    const result = compileMovementGraph(sources);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") expect(result.report.errors.map((error) => error.code)).toContain("invalid_local_only_mapping");
    expect("snapshot" in result).toBe(false);
  });
});
