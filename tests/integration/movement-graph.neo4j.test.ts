import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MovementGraphSnapshot } from "../../src/domain/contracts/movement-graph";
import { compileDefaultMovementGraph } from "../../src/graph/ingest/movement-clinical";
import { createNeo4jClient, type Neo4jClient } from "../../src/graph/neo4j/client";
import { setupMovementNeo4jSchema } from "../../src/graph/neo4j/movement-schema";
import { createNeo4jMovementPublisher } from "../../src/graph/publication/neo4j-movement-publisher";
import { createNeo4jMovementGraphReadProvider } from "../../src/graph/repositories/neo4j-movement-graph";
import { InMemoryMovementGraphReadProvider } from "../../src/graph/repositories/movement-graph";
import { canonicalJson, sha256 } from "../../src/graph/revisions/movement-graph";
import { MOVEMENT_CYPHER } from "../../src/graph/cypher/movement";

const config = {
  uri: process.env.NEO4J_URI ?? "neo4j://127.0.0.1:7687",
  username: process.env.NEO4J_USERNAME ?? "neo4j",
  password: process.env.NEO4J_PASSWORD ?? "movement-graph-local-test",
  database: process.env.NEO4J_DATABASE ?? "neo4j",
  environment: "test" as const,
};

function compiledSnapshot(): MovementGraphSnapshot {
  const compiled = compileDefaultMovementGraph();
  if (compiled.status !== "valid") throw new Error(JSON.stringify(compiled.report));
  return compiled.snapshot;
}

const requestFor = (snapshot: MovementGraphSnapshot) => ({
  snapshot,
  canonicalDigest: `sha256:${sha256(canonicalJson(snapshot))}`,
  nodeCount: snapshot.nodes.length,
  edgeCount: snapshot.edges.length,
});

async function clearDatabase(client: Neo4jClient) {
  await client.executeWrite(async (transaction) => {
    await transaction.run("MATCH (node) DETACH DELETE node");
  });
  await setupMovementNeo4jSchema(client);
}

async function publishAndSeal(client: Neo4jClient, snapshot = compiledSnapshot()) {
  const publisher = createNeo4jMovementPublisher(client, {
    now: () => "2026-08-06T12:00:00.000Z",
    createId: (kind) => `${kind}:integration-test`,
  });
  const staged = await publisher.stage(requestFor(snapshot));
  if (staged.status !== "ok") throw new Error(JSON.stringify(staged.failure));
  const sealed = await publisher.validate({
    publicationAttemptId: staged.data.publicationAttemptId,
    clinicalReviewApprovalId: "clinical-review:integration-test",
  });
  if (sealed.status !== "ok") throw new Error(JSON.stringify(sealed.failure));
  return { publisher, staged: staged.data, sealed: sealed.data };
}

describe.sequential("Neo4j movement graph persistence", () => {
  let client: Neo4jClient;

  beforeAll(async () => {
    client = createNeo4jClient(config);
    await client.verifyConnectivity();
    await setupMovementNeo4jSchema(client);
  });

  beforeEach(async () => clearDatabase(client));
  afterAll(async () => client.close());

  it("creates the Community-portable identity and operational constraints", async () => {
    const names = await client.executeRead(async (transaction) => {
      const result = await transaction.run("SHOW CONSTRAINTS YIELD name RETURN name ORDER BY name");
      return result.records.map((record) => record.get("name"));
    });
    expect(names).toEqual(expect.arrayContaining([
      "movement_catalog_singleton",
      "movement_revision_identity",
      "movement_concept_identity",
      "movement_node_assertion_identity",
      "movement_edge_assertion_identity",
      "movement_publication_attempt_identity",
      "movement_revision_seal_identity",
      "movement_activation_event_identity",
    ]));
  });

  it("returns exactly the same bounded facts and ordering as the in-memory adapter", async () => {
    const snapshot = compiledSnapshot();
    const { publisher } = await publishAndSeal(client, snapshot);
    const activated = await publisher.activate({ graphRevisionId: snapshot.graphRevisionId, expectedPriorRevisionId: null, actorId: "curator:test" });
    expect(activated.status).toBe("ok");

    const neoOpened = await createNeo4jMovementGraphReadProvider(client).openActive();
    const memoryOpened = await new InMemoryMovementGraphReadProvider([snapshot], { authority: "canonical" }).openActive();
    if (neoOpened.status !== "ready" || memoryOpened.status !== "ready") throw new Error("expected readable adapters");

    const operations = [
      (handle: typeof neoOpened.handle) => handle.resolveConceptCandidates({ text: "knee", kinds: ["joint"], maxResults: 10 }),
      (handle: typeof neoOpened.handle) => handle.getAnatomyPaths({ conceptId: "joint:knee", includeSelf: true, maxDepth: 4, maxResults: 10 }),
      (handle: typeof neoOpened.handle) => handle.getClinicalRuleFacts({ conditionConceptId: "condition:patellofemoral-pain-syndrome", maxResults: 10 }),
      (handle: typeof neoOpened.handle) => handle.getExerciseConstraintFacts({ exerciseConceptId: "exercise:00b26731-066f-4b69-96e8-3472fc6fbc09", maxResults: 20 }),
      (handle: typeof neoOpened.handle) => handle.getSubstitutionCandidates({ exerciseConceptId: "exercise:00b26731-066f-4b69-96e8-3472fc6fbc09", maxResults: 10 }),
      (handle: typeof neoOpened.handle) => handle.getAssertions({ assertionIds: [snapshot.nodes[0]!.assertionId, snapshot.edges[0]!.assertionId], maxResults: 10 }),
    ];
    for (const operation of operations) expect(await operation(neoOpened.handle)).toEqual(await operation(memoryOpened.handle));
  });

  it("rolls back the entire bounded snapshot when staging fails inside the transaction", async () => {
    const snapshot = compiledSnapshot();
    const publisher = createNeo4jMovementPublisher(client, { failureInjection: "after_nodes" });
    await expect(publisher.stage(requestFor(snapshot))).resolves.toMatchObject({ status: "failed", failure: { code: "publication_unavailable" } });
    const counts = await client.executeRead(async (transaction) => {
      const result = await transaction.run("MATCH (node {graphRevisionId: $revisionId}) RETURN count(node) AS count", { revisionId: snapshot.graphRevisionId });
      return Number(result.records[0]?.get("count"));
    });
    expect(counts).toBe(0);
  });

  it("keeps a complete inactive unsealed stage after a post-commit interruption", async () => {
    const snapshot = compiledSnapshot();
    const publisher = createNeo4jMovementPublisher(client, { failureInjection: "after_stage_commit" });
    await expect(publisher.stage(requestFor(snapshot))).resolves.toMatchObject({ status: "failed", failure: { code: "publication_unavailable" } });
    await expect(createNeo4jMovementGraphReadProvider(client).openRevision(snapshot.graphRevisionId))
      .resolves.toMatchObject({ status: "unavailable", failure: { code: "revision_not_found" } });
    await expect(publisher.inspect(snapshot.graphRevisionId)).resolves.toMatchObject({ status: "ok", data: { state: "staged" } });
  });

  it("is idempotent for an exact revision and rejects divergent payload under the same revision ID", async () => {
    const snapshot = compiledSnapshot();
    const publisher = createNeo4jMovementPublisher(client);
    const first = await publisher.stage(requestFor(snapshot));
    expect(first).toMatchObject({ status: "ok", data: { state: "staged" } });
    const retry = await publisher.stage(requestFor(snapshot));
    expect(retry, JSON.stringify(retry)).toMatchObject({ status: "ok", data: { state: "already_staged" } });

    const divergent: MovementGraphSnapshot = {
      ...snapshot,
      nodes: snapshot.nodes.map((node, index) => index === 0 ? { ...node, label: `${node.label} changed` } : node),
    };
    await expect(publisher.stage(requestFor(divergent))).resolves.toEqual({
      status: "failed",
      failure: { code: "immutable_payload_conflict", graphRevisionId: snapshot.graphRevisionId },
    });
  });

  it("converges concurrent publication of one exact revision without overwriting", async () => {
    const snapshot = compiledSnapshot();
    const publisher = createNeo4jMovementPublisher(client);
    const results = await Promise.all([
      publisher.stage(requestFor(snapshot)),
      publisher.stage(requestFor(snapshot)),
    ]);
    expect(results.every((result) => result.status === "ok")).toBe(true);
    expect(results.map((result) => result.status === "ok" && result.data.state).sort()).toEqual(["already_staged", "staged"]);
    const count = await client.executeRead(async (transaction) => {
      const result = await transaction.run("MATCH (revision:MovementRevision {revisionId: $revisionId}) RETURN count(revision) AS count", { revisionId: snapshot.graphRevisionId });
      return Number(result.records[0]?.get("count"));
    });
    expect(count).toBe(1);
  });

  it("rebuilds canonical data and rejects a tampered stage instead of sealing it", async () => {
    const snapshot = compiledSnapshot();
    const publisher = createNeo4jMovementPublisher(client);
    const staged = await publisher.stage(requestFor(snapshot));
    if (staged.status !== "ok") throw new Error("stage failed");
    await client.executeWrite(async (transaction) => {
      await transaction.run(
        "MATCH (node:MovementConcept {graphRevisionId: $revisionId}) WITH node LIMIT 1 SET node.payload = $payload",
        { revisionId: snapshot.graphRevisionId, payload: "{\"tampered\":true}" },
      );
    });
    await expect(publisher.validate({ publicationAttemptId: staged.data.publicationAttemptId, clinicalReviewApprovalId: "clinical-review:test" }))
      .resolves.toMatchObject({ status: "failed", failure: { code: "validation_failed" } });
    await expect(createNeo4jMovementGraphReadProvider(client).openRevision(snapshot.graphRevisionId))
      .resolves.toMatchObject({ status: "unavailable" });
  });

  it("rejects unsafe environment configuration before creating a driver", () => {
    expect(() => createNeo4jClient({ environment: "production" })).toThrow(/credentials/i);
    expect(() => createNeo4jClient({ uri: "neo4j://db.example.com:7687", username: "neo4j", password: "secret", environment: "production" }))
      .toThrow(/encrypted neo4j\+s or bolt\+s/i);
    expect(() => createNeo4jClient({ uri: "neo4j+s://db.example.com:7687", username: "neo4j", password: "movement-graph-local-test", environment: "production" }))
      .toThrow(/credentials/i);
  });

  it("exports only fixed Cypher templates with parameterized values", () => {
    expect(Object.values(MOVEMENT_CYPHER).every((query) => typeof query === "string" && !query.includes("${"))).toBe(true);
    expect(Object.values(MOVEMENT_CYPHER).every((query) => !/\b(apoc|CALL)\b/i.test(query))).toBe(true);
  });
});
