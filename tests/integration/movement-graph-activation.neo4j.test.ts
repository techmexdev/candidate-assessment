import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MovementGraphSnapshot } from "../../src/domain/contracts/movement-graph";
import { compileDefaultMovementGraph } from "../../src/graph/ingest/movement-clinical";
import { createNeo4jClient, type Neo4jClient } from "../../src/graph/neo4j/client";
import { setupMovementNeo4jSchema } from "../../src/graph/neo4j/movement-schema";
import { createNeo4jMovementPublisher } from "../../src/graph/publication/neo4j-movement-publisher";
import { createNeo4jMovementGraphReadProvider } from "../../src/graph/repositories/neo4j-movement-graph";
import { canonicalJson, sha256 } from "../../src/graph/revisions/movement-graph";

const config = {
  uri: process.env.NEO4J_URI ?? "neo4j://127.0.0.1:7687",
  username: process.env.NEO4J_USERNAME ?? "neo4j",
  password: process.env.NEO4J_PASSWORD ?? "movement-graph-local-test",
  database: process.env.NEO4J_DATABASE ?? "neo4j",
  environment: "test" as const,
};

function baseSnapshot() {
  const result = compileDefaultMovementGraph();
  if (result.status !== "valid") throw new Error(JSON.stringify(result.report));
  return result.snapshot;
}

function revision(snapshot: MovementGraphSnapshot, suffix: string): MovementGraphSnapshot {
  const graphRevisionId = `graph:sha256:integration-${suffix}`;
  return {
    graphRevisionId,
    nodes: snapshot.nodes.map((node) => ({ ...node, graphRevisionId })),
    edges: snapshot.edges.map((edge) => ({ ...edge, graphRevisionId })),
  };
}

const requestFor = (snapshot: MovementGraphSnapshot) => ({ snapshot, canonicalDigest: `sha256:${sha256(canonicalJson(snapshot))}`, nodeCount: snapshot.nodes.length, edgeCount: snapshot.edges.length });

describe.sequential("Neo4j movement graph activation", () => {
  let client: Neo4jClient;
  beforeAll(async () => { client = createNeo4jClient(config); await client.verifyConnectivity(); await setupMovementNeo4jSchema(client); });
  beforeEach(async () => { await client.executeWrite(async (tx) => { await tx.run("MATCH (node) DETACH DELETE node"); }); await setupMovementNeo4jSchema(client); });
  afterAll(async () => client.close());

  async function seal(snapshot: MovementGraphSnapshot) {
    const publisher = createNeo4jMovementPublisher(client, { now: () => "2026-08-06T12:00:00.000Z", createId: (kind) => `${kind}:${snapshot.graphRevisionId}` });
    const staged = await publisher.stage(requestFor(snapshot));
    if (staged.status !== "ok") throw new Error(JSON.stringify(staged.failure));
    const sealed = await publisher.validate({ publicationAttemptId: staged.data.publicationAttemptId, clinicalReviewApprovalId: "clinical-review:test" });
    if (sealed.status !== "ok") throw new Error(JSON.stringify(sealed.failure));
    return publisher;
  }

  it("supports first activation, same-target retry, and rejects an unsealed revision", async () => {
    const first = baseSnapshot();
    const publisher = await seal(first);
    await expect(publisher.activate({ graphRevisionId: first.graphRevisionId, expectedPriorRevisionId: null, actorId: "curator:test" }))
      .resolves.toMatchObject({ status: "ok", data: { state: "activated", priorRevisionId: null } });
    await expect(publisher.activate({ graphRevisionId: first.graphRevisionId, expectedPriorRevisionId: null, actorId: "curator:test" }))
      .resolves.toMatchObject({ status: "ok", data: { state: "already_active" } });

    const unsealed = revision(first, "unsealed");
    await publisher.stage(requestFor(unsealed));
    await expect(publisher.activate({ graphRevisionId: unsealed.graphRevisionId, expectedPriorRevisionId: first.graphRevisionId, actorId: "curator:test" }))
      .resolves.toEqual({ status: "failed", failure: { code: "not_sealed", graphRevisionId: unsealed.graphRevisionId } });
  });

  it("serializes concurrent different-target activation so exactly one compare-and-swap is stale", async () => {
    const first = baseSnapshot();
    const second = revision(first, "second");
    const third = revision(first, "third");
    const publisher = await seal(first);
    await seal(second); await seal(third);
    await publisher.activate({ graphRevisionId: first.graphRevisionId, expectedPriorRevisionId: null, actorId: "curator:baseline" });

    const outcomes = await Promise.all([
      publisher.activate({ graphRevisionId: second.graphRevisionId, expectedPriorRevisionId: first.graphRevisionId, actorId: "curator:second" }),
      publisher.activate({ graphRevisionId: third.graphRevisionId, expectedPriorRevisionId: first.graphRevisionId, actorId: "curator:third" }),
    ]);
    expect(outcomes.filter((result) => result.status === "ok")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "failed" && result.failure.code === "stale_revision")).toHaveLength(1);
  });

  it("does not activate a revision whose canonical payload changed after sealing", async () => {
    const snapshot = baseSnapshot();
    const publisher = await seal(snapshot);
    await client.executeWrite(async (transaction) => {
      await transaction.run(
        "MATCH (node:MovementConcept {graphRevisionId: $revisionId}) WITH node LIMIT 1 SET node.payload = $payload",
        { revisionId: snapshot.graphRevisionId, payload: "{\"tamperedAfterSeal\":true}" },
      );
    });
    await expect(publisher.activate({ graphRevisionId: snapshot.graphRevisionId, expectedPriorRevisionId: null, actorId: "curator:test" }))
      .resolves.toEqual({ status: "failed", failure: { code: "not_sealed", graphRevisionId: snapshot.graphRevisionId } });
    await expect(publisher.inspect()).resolves.toMatchObject({ status: "ok", data: { activeRevisionId: null } });
  });

  it("records rollback without mutating historical revisions and pins already-open handles", async () => {
    const first = baseSnapshot();
    const second = revision(first, "rollback-target");
    const publisher = await seal(first); await seal(second);
    await publisher.activate({ graphRevisionId: first.graphRevisionId, expectedPriorRevisionId: null, actorId: "curator:first" });
    const provider = createNeo4jMovementGraphReadProvider(client);
    const firstOpened = await provider.openActive();
    if (firstOpened.status !== "ready") throw new Error("first revision unavailable");
    await publisher.activate({ graphRevisionId: second.graphRevisionId, expectedPriorRevisionId: first.graphRevisionId, actorId: "curator:second" });
    expect(firstOpened.handle.graphRevisionId).toBe(first.graphRevisionId);
    const pinnedFacts = await firstOpened.handle.resolveConceptCandidates({ text: "knee", kinds: ["joint"], maxResults: 10 });
    expect(pinnedFacts.graphRevisionId).toBe(first.graphRevisionId);
    await publisher.activate({ graphRevisionId: first.graphRevisionId, expectedPriorRevisionId: second.graphRevisionId, actorId: "curator:rollback" });

    const historical = await provider.openRevision(second.graphRevisionId);
    const active = await createNeo4jMovementGraphReadProvider(client).openActive();
    expect(historical.status === "ready" && historical.handle.graphRevisionId).toBe(second.graphRevisionId);
    expect(active.status === "ready" && active.handle.graphRevisionId).toBe(first.graphRevisionId);
    const inspection = await publisher.inspect(first.graphRevisionId);
    expect(inspection).toMatchObject({ status: "ok", data: { state: "active" } });
    const history = await client.executeRead(async (transaction) => {
      const result = await transaction.run("MATCH (event:ActivationEvent) RETURN event.graphRevisionId AS revisionId, event.priorRevisionId AS priorRevisionId ORDER BY event.activatedAt, event.eventId");
      return result.records.map((record) => ({ revisionId: record.get("revisionId"), priorRevisionId: record.get("priorRevisionId") ?? null }));
    });
    expect(history).toHaveLength(3);
    expect(history).toEqual(expect.arrayContaining([
      { revisionId: first.graphRevisionId, priorRevisionId: null },
      { revisionId: second.graphRevisionId, priorRevisionId: first.graphRevisionId },
      { revisionId: first.graphRevisionId, priorRevisionId: second.graphRevisionId },
    ]));
  });

  it("preserves the active pointer, seal, and historical reads across a new client", async () => {
    const first = baseSnapshot();
    const publisher = await seal(first);
    await publisher.activate({ graphRevisionId: first.graphRevisionId, expectedPriorRevisionId: null, actorId: "curator:test" });
    const restarted = createNeo4jClient(config);
    try {
      const opened = await createNeo4jMovementGraphReadProvider(restarted).openRevision(first.graphRevisionId);
      const active = await createNeo4jMovementGraphReadProvider(restarted).openActive();
      expect(opened.status).toBe("ready");
      expect(active.status === "ready" && active.handle.graphRevisionId).toBe(first.graphRevisionId);
    } finally {
      await restarted.close();
    }
  });
});
