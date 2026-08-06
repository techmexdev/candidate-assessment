import { describe, expect, it } from "vitest";
import { compileDefaultMovementGraph } from "../../src/graph/ingest/movement-clinical";
import { InMemoryMovementGraphReadProvider } from "../../src/graph/repositories/movement-graph";

function snapshot() {
  const result = compileDefaultMovementGraph();
  if (result.status !== "valid") throw new Error(JSON.stringify(result.report));
  return result.snapshot;
}

async function openHandle(authority: "canonical" | "fixture" = "fixture") {
  const provider = new InMemoryMovementGraphReadProvider([snapshot()], { authority });
  const opened = await provider.openActive();
  if (opened.status !== "ready") throw new Error("graph unavailable");
  return { provider, handle: opened.handle };
}

describe("in-memory movement graph read contract", () => {
  it("returns stable candidates and identical facts with configurable authority", async () => {
    const fixture = await openHandle("fixture");
    const canonical = await openHandle("canonical");
    const query = { text: "knee", kinds: ["joint" as const], maxResults: 10 };
    const fixtureResult = await fixture.handle.resolveConceptCandidates(query);
    const canonicalResult = await canonical.handle.resolveConceptCandidates(query);
    expect(fixtureResult.status).toBe("ok");
    expect(canonicalResult.status).toBe("ok");
    if (fixtureResult.status !== "ok" || canonicalResult.status !== "ok") return;
    expect(fixtureResult.data).toEqual(canonicalResult.data);
    expect(fixtureResult.authority).toBe("fixture");
    expect(canonicalResult.authority).toBe("canonical");
    expect(fixtureResult.data.map((fact) => fact.conceptId)).toEqual(
      [...fixtureResult.data.map((fact) => fact.conceptId)].sort(),
    );
  });

  it("preserves the full bounded knee descendant path and assertion lookup", async () => {
    const { handle } = await openHandle();
    const result = await handle.getAnatomyPaths({ conceptId: "joint:knee", includeSelf: true, maxDepth: 4, maxResults: 10 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const path = result.data.find((fact) => fact.descendantConceptId === "joint:patellofemoral");
    expect(path).toBeDefined();
    expect(path?.nodeAssertionIds).toHaveLength(2);
    expect(path?.edgeAssertionIds).toHaveLength(1);
    const lookup = await handle.getAssertions({ assertionIds: [...path!.nodeAssertionIds, ...path!.edgeAssertionIds], maxResults: 10 });
    expect(lookup.status).toBe("ok");
    if (lookup.status === "ok") expect(lookup.data).toHaveLength(3);
  });

  it("returns condition-rule-target facts and reviewed substitution facts", async () => {
    const { handle } = await openHandle();
    const rules = await handle.getClinicalRuleFacts({ conditionConceptId: "condition:patellofemoral-pain-syndrome", maxResults: 10 });
    expect(rules.status).toBe("ok");
    if (rules.status === "ok") {
      expect(rules.data.some((fact) => fact.effect === "hard-contraindication" && fact.pathAssertionIds.length >= 3)).toBe(true);
      expect(rules.data.every((fact) => fact.evidenceAssertionIds.length > 0 && fact.mappingAssertionIds.length > 0)).toBe(true);
    }
    const substitutions = await handle.getSubstitutionCandidates({ exerciseConceptId: "exercise:00b26731-066f-4b69-96e8-3472fc6fbc09", maxResults: 10 });
    expect(substitutions.status).toBe("ok");
    if (substitutions.status === "ok") expect(substitutions.data).toHaveLength(3);
  });

  it("fails closed for invalid queries, unresolved concepts, and caps", async () => {
    const { handle } = await openHandle();
    await expect(handle.getAnatomyPaths({ conceptId: "joint:knee", includeSelf: true, maxDepth: 0, maxResults: 10 }))
      .resolves.toMatchObject({ status: "failed", failure: { code: "invalid_query" } });
    await expect(handle.getClinicalRuleFacts({ conditionConceptId: "condition:missing", maxResults: 10 }))
      .resolves.toMatchObject({ status: "failed", failure: { code: "unresolved_concept" } });
    await expect(handle.getAnatomyPaths({ conceptId: "joint:knee", includeSelf: true, maxDepth: 1, maxResults: 1 }))
      .resolves.toMatchObject({ status: "failed", failure: { code: "traversal_limit_exceeded" } });
    await expect(handle.getAssertions({ assertionIds: ["assertion:missing"], maxResults: 1 }))
      .resolves.toMatchObject({ status: "failed", failure: { code: "broken_assertion" } });
    await expect(new InMemoryMovementGraphReadProvider([]).openActive())
      .resolves.toMatchObject({ status: "unavailable", failure: { code: "graph_unavailable" } });
  });

  it("pins an opened handle when the provider active pointer changes", async () => {
    const first = snapshot();
    const second = structuredClone(first) as any;
    second.graphRevisionId = "graph:sha256:alternate";
    second.nodes.forEach((node: any) => { node.graphRevisionId = second.graphRevisionId; });
    second.edges.forEach((edge: any) => { edge.graphRevisionId = second.graphRevisionId; });
    Object.freeze(second);
    const provider = new InMemoryMovementGraphReadProvider([first, second], { activeRevisionId: first.graphRevisionId });
    const opened = await provider.openActive();
    if (opened.status !== "ready") throw new Error("graph unavailable");
    provider.setActiveRevisionForTesting(second.graphRevisionId);
    expect(opened.handle.graphRevisionId).toBe(first.graphRevisionId);
    const later = await provider.openActive();
    expect(later.status === "ready" && later.handle.graphRevisionId).toBe(second.graphRevisionId);
  });
});
