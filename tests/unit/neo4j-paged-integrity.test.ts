import { describe, expect, it } from "vitest";
import { mintAuthorizedMemberContextScope } from "../../src/application/use-cases/retrieve-member-context";
import { MEMBER_CONTEXT_CYPHER } from "../../src/graph/cypher/member-context";
import { MOVEMENT_CYPHER } from "../../src/graph/cypher/movement";
import { compileMemberContextGraph } from "../../src/graph/ingest/member-context";
import { compileDefaultMovementGraph } from "../../src/graph/ingest/movement-clinical";
import type { Neo4jClient, Neo4jQueryResult } from "../../src/graph/neo4j/client";
import { canonicalMemberContextDigest } from "../../src/graph/revisions/member-context";
import { canonicalJson, sha256 } from "../../src/graph/revisions/movement-graph";
import { createNeo4jMemberContextReadProvider } from "../../src/graph/repositories/neo4j-member-context";
import { createNeo4jMovementGraphReadProvider } from "../../src/graph/repositories/neo4j-movement-graph";
import { buildMemberContextFixture } from "../fixtures/member-context-builder";

const page = { nodeOffset: 0, relationshipOffset: 0, pageSize: 2 } as const;

function record(values: Readonly<Record<string, unknown>>) {
  return { get: (key: string) => values[key] };
}

function fakeClient(run: (query: string) => Promise<Neo4jQueryResult>): Neo4jClient {
  const executeRead: Neo4jClient["executeRead"] = async (work) => work({ run });
  return {
    executeRead,
    executeWrite: async () => { throw new Error("Unexpected write"); },
    verifyConnectivity: async () => undefined,
    close: async () => undefined,
  };
}

function movementClient(options: { readonly corruptPayload?: boolean; readonly mismatchedSeal?: boolean }) {
  const compiled = compileDefaultMovementGraph();
  if (compiled.status !== "valid") throw new Error("Expected a valid movement fixture");
  const snapshot = compiled.snapshot;
  const canonicalDigest = `sha256:${sha256(canonicalJson(snapshot))}`;
  let pageRead = false;
  const client = fakeClient(async (query) => {
    if (query === MOVEMENT_CYPHER.readActiveRevision) {
      return { records: [record({ activeRevisionId: snapshot.graphRevisionId })] };
    }
    if (query === MOVEMENT_CYPHER.readSealedRevision) {
      return { records: [record({
        sealId: "revision-seal:test",
        canonicalDigest: options.mismatchedSeal ? "sha256:mismatched" : canonicalDigest,
        nodeCount: snapshot.nodes.length,
        edgeCount: snapshot.edges.length,
      })] };
    }
    if (query === MOVEMENT_CYPHER.findRevision) {
      return { records: [record({ revisionId: snapshot.graphRevisionId })] };
    }
    if (query === MOVEMENT_CYPHER.readNodes) {
      return { records: snapshot.nodes.map((node, index) => record({
        payload: options.corruptPayload && index === 0 ? "{" : JSON.stringify(node),
      })) };
    }
    if (query === MOVEMENT_CYPHER.readEdges) {
      return { records: snapshot.edges.map((edge) => record({ payload: JSON.stringify(edge) })) };
    }
    if (query === MOVEMENT_CYPHER.readPage) {
      pageRead = true;
      return { records: [record({
        revisionId: snapshot.graphRevisionId,
        canonicalDigest,
        nodeCount: snapshot.nodes.length,
        edgeCount: snapshot.edges.length,
        nodePayloads: snapshot.nodes.slice(0, page.pageSize + 1).map((node) => JSON.stringify(node)),
        relationshipPayloads: snapshot.edges.slice(0, page.pageSize + 1).map((edge) => JSON.stringify(edge)),
      })] };
    }
    throw new Error("Unexpected movement query");
  });
  return { client, pageRead: () => pageRead };
}

function memberContextClient(options: { readonly corruptPayload?: boolean; readonly mismatchedSeal?: boolean }) {
  const snapshot = compileMemberContextGraph(buildMemberContextFixture());
  const canonicalDigest = canonicalMemberContextDigest(snapshot);
  let pageRead = false;
  const client = fakeClient(async (query) => {
    if (query === MEMBER_CONTEXT_CYPHER.readActiveRevision) {
      return { records: [record({ activeRevisionId: snapshot.contextRevisionId })] };
    }
    if (query === MEMBER_CONTEXT_CYPHER.readSealedRevision) {
      return { records: [record({
        sealId: "member-revision-seal:test",
        canonicalDigest: options.mismatchedSeal ? "sha256:mismatched" : canonicalDigest,
        nodeCount: snapshot.nodes.length,
        relationshipCount: snapshot.relationships.length,
      })] };
    }
    if (query === MEMBER_CONTEXT_CYPHER.findRevision) {
      return { records: [record({ sourceArtifactDigest: snapshot.sourceArtifactDigest })] };
    }
    if (query === MEMBER_CONTEXT_CYPHER.readNodes) {
      return { records: snapshot.nodes.map((node, index) => record({
        payload: options.corruptPayload && index === 0 ? "{" : JSON.stringify(node),
      })) };
    }
    if (query === MEMBER_CONTEXT_CYPHER.readRelationships) {
      return { records: snapshot.relationships.map((relationship) => record({ payload: JSON.stringify(relationship) })) };
    }
    if (query === MEMBER_CONTEXT_CYPHER.readPage) {
      pageRead = true;
      return { records: [record({
        contextRevisionId: snapshot.contextRevisionId,
        sourceArtifactDigest: snapshot.sourceArtifactDigest,
        canonicalDigest,
        nodeCount: snapshot.nodes.length,
        relationshipCount: snapshot.relationships.length,
        nodePayloads: snapshot.nodes.slice(0, page.pageSize + 1).map((node) => JSON.stringify(node)),
        relationshipPayloads: snapshot.relationships.slice(0, page.pageSize + 1).map((relationship) => JSON.stringify(relationship)),
      })] };
    }
    throw new Error("Unexpected member context query");
  });
  const scope = mintAuthorizedMemberContextScope({
    coachId: "coach:test",
    memberId: snapshot.memberId,
    authorizationId: "authorization:test",
  });
  return { client, scope, pageRead: () => pageRead };
}

describe("Neo4j paged canonical integrity", () => {
  it("preserves the canonical movement page contract after complete-snapshot validation", async () => {
    const fixture = movementClient({});

    await expect(createNeo4jMovementGraphReadProvider(fixture.client).readFullPage!(page)).resolves.toMatchObject({
      status: "ready",
      data: {
        domain: "movement-clinical",
        authority: "canonical",
        page,
      },
    });
    expect(fixture.pageRead()).toBe(true);
  });

  it.each([
    ["a corrupt complete payload", { corruptPayload: true }],
    ["a mismatched complete seal", { mismatchedSeal: true }],
  ])("fails a movement page closed for %s", async (_label, options) => {
    const fixture = movementClient(options);

    await expect(createNeo4jMovementGraphReadProvider(fixture.client).readFullPage!(page)).resolves.toMatchObject({
      status: "unavailable",
      domain: "movement-clinical",
    });
    expect(fixture.pageRead()).toBe(false);
  });

  it("preserves the canonical member context page contract after complete-snapshot validation", async () => {
    const fixture = memberContextClient({});

    await expect(createNeo4jMemberContextReadProvider(fixture.client).readFullPage!(fixture.scope, page)).resolves.toMatchObject({
      status: "ready",
      data: {
        domain: "member-context",
        authority: "canonical",
        page,
      },
    });
    expect(fixture.pageRead()).toBe(true);
  });

  it.each([
    ["a corrupt complete payload", { corruptPayload: true }],
    ["a mismatched complete seal", { mismatchedSeal: true }],
  ])("fails a member context page closed for %s", async (_label, options) => {
    const fixture = memberContextClient(options);

    await expect(createNeo4jMemberContextReadProvider(fixture.client).readFullPage!(fixture.scope, page)).resolves.toMatchObject({
      status: "unavailable",
      domain: "member-context",
    });
    expect(fixture.pageRead()).toBe(false);
  });
});
