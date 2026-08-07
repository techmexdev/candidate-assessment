import { describe, expect, it } from "vitest";
import type {
  MovementGraphNodeAssertion,
  MovementGraphSnapshot,
} from "../../src/domain/contracts/movement-graph";
import { CATALOG_SAFETY_MAX_FAMILY_DEPTH } from "../../src/domain/contracts/catalog-safety";
import {
  compileDefaultMovementGraph,
  compileMovementGraph,
  movementGraphSources,
} from "../../src/graph/ingest/movement-clinical";
import {
  validateMovementGraph,
  type MovementGraphValidationErrorCode,
} from "../../src/graph/validation/movement-graph";
import { buildMovementVariantDiamondFixture } from "../fixtures/movement-variant-diamond";

type MutableNode = Record<string, unknown> & {
  assertionId: string;
  conceptId: string;
  graphRevisionId: string;
  kind: string;
};
type MutableEdge = Record<string, unknown> & {
  assertionId: string;
  graphRevisionId: string;
  kind: string;
  fromConceptId: string;
  fromKind: string;
  toConceptId: string;
  toKind: string;
};
type MutableSnapshot = {
  graphRevisionId: string;
  nodes: MutableNode[];
  edges: MutableEdge[];
};
type MutationCase = readonly [MovementGraphValidationErrorCode, (copy: MutableSnapshot) => void];

function validSnapshot() {
  const result = compileDefaultMovementGraph();
  expect(result.status).toBe("valid");
  if (result.status !== "valid") throw new Error("fixture did not compile");
  return result.snapshot;
}

function mutableCopy(snapshot: MovementGraphSnapshot): MutableSnapshot {
  return structuredClone(snapshot) as unknown as MutableSnapshot;
}

function expectCode(snapshot: MutableSnapshot, code: MovementGraphValidationErrorCode) {
  const report = validateMovementGraph(snapshot as unknown as MovementGraphSnapshot);
  expect(report.status).toBe("invalid");
  expect(report.errors.map((error) => error.code)).toContain(code);
}

describe("movement graph compiler and validator", () => {
  it("accepts an acyclic multi-parent movement variant diamond", () => {
    const { snapshot } = buildMovementVariantDiamondFixture();

    expect(validateMovementGraph(snapshot)).toEqual({ status: "valid", errors: [] });
  });

  it("continues to reject variant DAGs beyond the bounded family depth", () => {
    const diamond = buildMovementVariantDiamondFixture();
    const copy = mutableCopy(diamond.snapshot);
    const template = copy.edges.find((edge) => edge.kind === "variant-of")!;
    const variantConceptIds = new Set(copy.edges
      .filter((edge) => edge.kind === "variant-of")
      .flatMap((edge) => [edge.fromConceptId, edge.toConceptId]));
    const descendants = copy.nodes
      .filter((node) => node.kind === "exercise" && !variantConceptIds.has(node.conceptId))
      .slice(0, CATALOG_SAFETY_MAX_FAMILY_DEPTH - 1);
    let parentConceptId = diamond.mergedConceptId;
    for (const [index, descendant] of descendants.entries()) {
      copy.edges.push({
        ...template,
        assertionId: `assertion:test:variant-depth:${index}`,
        fromConceptId: descendant.conceptId,
        toConceptId: parentConceptId,
      });
      parentConceptId = descendant.conceptId;
    }

    expectCode(copy, "variant_depth_exceeded");
  });

  it("pins the deterministic golden revision and deeply freezes the snapshot", () => {
    const first = compileDefaultMovementGraph();
    const second = compileMovementGraph(structuredClone(movementGraphSources));
    expect(first.status).toBe("valid");
    expect(second.status).toBe("valid");
    if (first.status !== "valid" || second.status !== "valid") return;

    expect(first.snapshot.graphRevisionId).toBe("graph:sha256:f02cd7de83eb2abb539098dbdf6c7090435133bdf3c01c2de96f7808f2b6c5a7");
    expect(second.snapshot).toEqual(first.snapshot);
    expect(Object.isFrozen(first.snapshot)).toBe(true);
    expect(Object.isFrozen(first.snapshot.nodes)).toBe(true);
    expect(Object.isFrozen(first.snapshot.nodes[0]?.source)).toBe(true);
    expect(() => (first.snapshot.nodes as unknown as MovementGraphNodeAssertion[]).push({} as MovementGraphNodeAssertion)).toThrow();
  });

  const mutationCases: readonly MutationCase[] = [
    ["duplicate_concept_id", (copy) => copy.nodes.push({ ...copy.nodes[0]!, assertionId: "assertion:duplicate-node" })],
    ["duplicate_assertion_id", (copy) => copy.edges.push({ ...copy.edges[0]!, fromConceptId: copy.edges[1]!.fromConceptId, toConceptId: copy.edges[1]!.toConceptId })],
    ["dangling_reference", (copy) => { copy.edges[0]!.toConceptId = "muscle:missing"; }],
    ["invalid_endpoint", (copy) => { copy.edges[0]!.fromKind = "condition"; }],
    ["forbidden_direct_clinical_edge", (copy) => copy.edges.push({ ...copy.edges[0]!, assertionId: "assertion:direct", kind: "contraindicated-for", fromKind: "condition", toKind: "exercise" })],
    ["unsupported_mapping_relation", (copy) => { copy.edges.find((edge) => edge.kind === "maps-to")!.relation = "relatedMatch"; }],
    ["incomplete_mapping", (copy) => { delete copy.edges.find((edge) => edge.kind === "maps-to")!.sourceArtifactDigest; }],
    ["rule_effect_mismatch", (copy) => { copy.nodes.find((node) => node.kind === "clinical-rule" && node.effect === "hard-contraindication")!.effect = "caution"; }],
    ["incomplete_clinical_rule", (copy) => { copy.nodes.find((node) => node.kind === "clinical-rule")!.reviewer = ""; }],
    ["anatomy_cycle", (copy) => {
      const edge = copy.edges.find((item) => item.kind === "part-of")!;
      copy.edges.push({ ...edge, assertionId: "assertion:cycle", fromConceptId: edge.toConceptId, fromKind: edge.toKind, toConceptId: edge.fromConceptId, toKind: edge.fromKind });
    }],
    ["variant_cycle", (copy) => {
      const edge = copy.edges.find((item) => item.kind === "variant-of")!;
      copy.edges.push({
        ...edge,
        assertionId: "assertion:variant-cycle",
        fromConceptId: edge.toConceptId,
        toConceptId: edge.fromConceptId,
      });
    }],
    ["mixed_revision", (copy) => { copy.edges[0]!.graphRevisionId = "graph:sha256:other"; }],
    ["bounds_exceeded", (copy) => { copy.nodes = Array.from({ length: 513 }, (_, index) => ({ ...copy.nodes[0]!, conceptId: `exercise:overflow-${index}`, assertionId: `assertion:overflow-${index}` })); }],
  ];

  it.each(mutationCases)("rejects %s", (code, mutate) => {
    const copy = mutableCopy(validSnapshot());
    mutate(copy);
    expectCode(copy, code);
  });

  it("returns a typed report and never a partial snapshot for invalid sources", () => {
    const sources = structuredClone(movementGraphSources) as unknown as {
      mappings: { records: Array<Record<string, unknown> & { status: string }> };
    };
    sources.mappings.records.find((record) => record.status === "local-only")!.source_code = "invented";
    const result = compileMovementGraph(sources as unknown as typeof movementGraphSources);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") expect(result.report.errors.map((error) => error.code)).toContain("invalid_local_only_mapping");
    expect("snapshot" in result).toBe(false);
  });

  it.each([
    "catalog",
    "concepts",
    "anatomy",
    "demands",
    "evidence",
    "rules",
    "substitutions",
    "variants",
    "mappings",
    "sourceReviews",
  ] as const)("returns a typed invalid report for a malformed %s source manifest", (manifest) => {
    const sources = structuredClone(movementGraphSources) as unknown as Record<string, unknown>;
    sources[manifest] = null;

    expect(() => compileMovementGraph(sources as unknown as typeof movementGraphSources)).not.toThrow();
    const result = compileMovementGraph(sources as unknown as typeof movementGraphSources);

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.report.errors).toContainEqual({
        code: "invalid_source_manifest",
        message: `Malformed source manifest ${manifest}`,
      });
    }
    expect("snapshot" in result).toBe(false);
  });

  it("returns a typed invalid report for malformed nested manifest data", () => {
    const sources = structuredClone(movementGraphSources) as unknown as {
      demands: { records: Array<{ scope: unknown }> };
    };
    sources.demands.records[0]!.scope = 1n;

    const result = compileMovementGraph(sources);

    expect(result).toMatchObject({
      status: "invalid",
      report: { errors: [{ code: "invalid_source_manifest", message: "Malformed source manifest demands" }] },
    });
  });

  it.each([
    ["draft review", { status: "draft", reviewer: "curator", reviewed_at: "2026-08-06" }],
    ["rejected review", { status: "rejected", reviewer: "curator", reviewed_at: "2026-08-06" }],
    ["blank reviewer", { status: "reviewed", reviewer: " ", reviewed_at: "2026-08-06" }],
    ["blank review date", { status: "reviewed", reviewer: "curator", reviewed_at: " " }],
  ])("rejects a substitution with %s", (_label, review) => {
    const sources = structuredClone(movementGraphSources) as unknown as {
      substitutions: { records: Array<{ review: typeof review }> };
    };
    sources.substitutions.records[0]!.review = review;

    const result = compileMovementGraph(sources as unknown as typeof movementGraphSources);

    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.report.errors.map((error) => error.code)).toContain("incomplete_substitution");
    }
    expect("snapshot" in result).toBe(false);
  });

  it.each([
    ["draft review", { status: "draft", reviewer: "curator", reviewed_at: "2026-08-06" }],
    ["self reference", undefined],
  ])("rejects a movement variant with %s", (label, review) => {
    const sources = structuredClone(movementGraphSources) as unknown as {
      variants: { records: Array<{
        variant_exercise_id: string;
        family_root_exercise_id: string;
        review: { status: string; reviewer: string; reviewed_at: string };
      }> };
    };
    if (label === "self reference") {
      sources.variants.records[0]!.variant_exercise_id = sources.variants.records[0]!.family_root_exercise_id;
    } else if (review) {
      sources.variants.records[0]!.review = review;
    }

    const result = compileMovementGraph(sources as unknown as typeof movementGraphSources);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.report.errors.map((error) => error.code)).toContain("incomplete_variant");
    }
    expect("snapshot" in result).toBe(false);
  });
});
