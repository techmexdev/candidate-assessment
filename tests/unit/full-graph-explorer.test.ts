import { describe, expect, it } from "vitest";

import type { FullGraphProjection } from "../../src/domain/contracts/full-graph-view";
import { layoutFullGraph } from "../../src/features/coach-dashboard/FullGraphExplorer";

const projection: FullGraphProjection = {
  domain: "movement-clinical",
  revisionId: "movement:one",
  authority: "canonical",
  counts: { nodes: 3, relationships: 2 },
  nodes: [
    { id: "joint:knee", kind: "joint", label: "Knee", category: "domain", revisionId: "movement:one", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:knee", lineageIds: [] } },
    { id: "graph:one", kind: "graph-revision", label: "Revision one", category: "lineage", revisionId: "movement:one", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:revision", lineageIds: [] } },
    { id: "exercise:squat", kind: "exercise", label: "Squat", category: "domain", revisionId: "movement:one", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:squat", lineageIds: [] } },
  ],
  relationships: [
    { id: "assertion:targets", kind: "targets", fromId: "exercise:squat", toId: "joint:knee", revisionId: "movement:one", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:targets", lineageIds: [] } },
    { id: "assertion:revision", kind: "in-revision", fromId: "exercise:squat", toId: "graph:one", revisionId: "movement:one", detail: [], provenance: { directAssertion: "present", assertionId: "assertion:revision", lineageIds: [] } },
  ],
};

describe("full graph explorer layout", () => {
  it("positions every node deterministically and exposes a scrollable canvas size", () => {
    const first = layoutFullGraph(projection);
    const second = layoutFullGraph(projection);

    expect(first.width).toBeGreaterThan(0);
    expect(first.height).toBeGreaterThan(0);
    expect([...first.positions.entries()]).toEqual([...second.positions.entries()]);
    expect(first.positions.size).toBe(projection.nodes.length);
    expect(first.positions.get("exercise:squat")).toEqual({ x: 24, y: 24 });
    expect(first.positions.get("graph:one")?.x).toBeGreaterThan(first.positions.get("exercise:squat")!.x);
  });
});
