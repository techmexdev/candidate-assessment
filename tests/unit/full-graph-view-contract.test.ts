import { describe, expect, it } from "vitest";
import jordan from "../../data/member-context.json";
import type { MemberContextGraphSnapshot } from "../../src/domain/contracts/member-context";
import type { MovementGraphSnapshot } from "../../src/domain/contracts/movement-graph";
import {
  FullGraphProjectionError,
  projectMemberContextGraphSnapshot,
  projectMovementGraphSnapshot,
} from "../../src/domain/contracts/full-graph-view";
import { compileMemberContextGraph } from "../../src/graph/ingest/member-context";
import { compileDefaultMovementGraph } from "../../src/graph/ingest/movement-clinical";

function movementSnapshot(): MovementGraphSnapshot {
  const result = compileDefaultMovementGraph();
  if (result.status !== "valid") throw new Error(JSON.stringify(result.report));
  return result.snapshot;
}

function memberSnapshot(): MemberContextGraphSnapshot {
  return compileMemberContextGraph(jordan);
}

describe("full graph projection contract", () => {
  it("projects every Movement node and edge with stable IDs, provenance, and counts", () => {
    const snapshot = movementSnapshot();
    const projection = projectMovementGraphSnapshot(snapshot, "fixture");

    expect(projection).toMatchObject({
      domain: "movement-clinical",
      revisionId: snapshot.graphRevisionId,
      authority: "fixture",
      counts: { nodes: snapshot.nodes.length, relationships: snapshot.edges.length },
    });
    expect(projection.nodes.map((node) => node.id)).toEqual(
      [...snapshot.nodes].sort((left, right) => left.assertionId.localeCompare(right.assertionId)).map((node) => node.conceptId),
    );
    expect(projection.relationships.map((relationship) => relationship.id)).toEqual(
      [...snapshot.edges].sort((left, right) => left.assertionId.localeCompare(right.assertionId)).map((edge) => edge.assertionId),
    );
    expect(projection.relationships.every((relationship) => projection.nodes.some((node) => node.id === relationship.fromId)
      && projection.nodes.some((node) => node.id === relationship.toId))).toBe(true);
    expect(projection.nodes.every((node) => node.provenance.directAssertion === "present"
      && node.provenance.assertionId
      && node.provenance.source?.sourceRevision)).toBe(true);
  });

  it("projects every member-context node and relationship while marking identity nodes without assertions", () => {
    const snapshot = memberSnapshot();
    const projection = projectMemberContextGraphSnapshot(snapshot, "canonical");

    expect(projection).toMatchObject({
      domain: "member-context",
      memberId: snapshot.memberId,
      revisionId: snapshot.contextRevisionId,
      sourceArtifactDigest: snapshot.sourceArtifactDigest,
      authority: "canonical",
      counts: { nodes: snapshot.nodes.length, relationships: snapshot.relationships.length },
    });
    expect(projection.nodes).toHaveLength(snapshot.nodes.length);
    expect(projection.relationships).toHaveLength(snapshot.relationships.length);
    expect(projection.nodes.find((node) => node.kind === "member")?.provenance.directAssertion).toBe("none");
    expect(projection.nodes.find((node) => node.kind === "member-profile")?.provenance).toMatchObject({
      directAssertion: "present",
      source: { artifactDigest: snapshot.sourceArtifactDigest },
    });
    expect(projection.relationships.every((relationship) => relationship.revisionId === snapshot.contextRevisionId)).toBe(true);
  });

  it.each([
    ["movement mixed revision", () => {
      const snapshot = movementSnapshot();
      return { ...snapshot, nodes: [{ ...snapshot.nodes[0]!, graphRevisionId: "graph-revision:other" }, ...snapshot.nodes.slice(1)] };
    }],
    ["member dangling relationship", () => {
      const snapshot = memberSnapshot();
      return {
        ...snapshot,
        relationships: [{ ...snapshot.relationships[0]!, toSemanticId: "member-context:missing" }, ...snapshot.relationships.slice(1)],
      };
    }],
  ])("fails closed for %s", (_name, makeInvalid) => {
    expect(() => {
      const invalid = makeInvalid();
      if ("edges" in invalid) projectMovementGraphSnapshot(invalid as MovementGraphSnapshot, "fixture");
      else projectMemberContextGraphSnapshot(invalid as MemberContextGraphSnapshot, "fixture");
    }).toThrow(FullGraphProjectionError);
  });
});
