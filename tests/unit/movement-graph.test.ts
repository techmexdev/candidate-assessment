import { describe, expect, it } from "vitest";
import { MOVEMENT_NODE_KINDS } from "../../src/domain/contracts/movement-graph";
import { compileDefaultMovementGraph } from "../../src/graph/ingest/movement-clinical";
import { InMemoryMovementGraphReadProvider } from "../../src/graph/repositories/movement-graph";

function compiled() {
  const result = compileDefaultMovementGraph();
  if (result.status !== "valid") throw new Error(JSON.stringify(result.report));
  return result.snapshot;
}

describe("movement graph", () => {
  it("compiles every target role and curated relationship without legacy semantics", () => {
    const snapshot = compiled();
    expect(new Set(snapshot.nodes.map((node) => node.kind))).toEqual(new Set(MOVEMENT_NODE_KINDS));
    expect(snapshot.nodes.filter((node) => node.kind === "exercise")).toHaveLength(50);
    expect(snapshot.nodes.every((node) => node.graphRevisionId === snapshot.graphRevisionId && node.source.sourceId.length > 0)).toBe(true);
    expect(snapshot.edges.every((edge) => edge.graphRevisionId === snapshot.graphRevisionId && edge.source.sourceId.length > 0)).toBe(true);
    expect(snapshot.edges.some((edge) => edge.kind === "has-constraint")).toBe(true);
    expect(snapshot.edges.some((edge) => edge.kind === "contraindicates")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/contraindicated-for|equivalent-to|COPPER/i);
  });

  it("opens explicit and active revisions asynchronously", async () => {
    const snapshot = compiled();
    const provider = new InMemoryMovementGraphReadProvider([snapshot], { authority: "canonical" });
    await expect(provider.openActive()).resolves.toMatchObject({ status: "ready", handle: { graphRevisionId: snapshot.graphRevisionId, authority: "canonical" } });
    await expect(provider.openRevision("graph:sha256:missing")).resolves.toEqual({ status: "unavailable", failure: { code: "revision_not_found", revisionId: "graph:sha256:missing" } });
  });
});
