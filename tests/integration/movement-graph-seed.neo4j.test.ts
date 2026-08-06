import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MovementGraphPublisher } from "../../src/domain/contracts/movement-graph-publication";
import { createNeo4jClient, type Neo4jClient } from "../../src/graph/neo4j/client";
import { setupMovementNeo4jSchema } from "../../src/graph/neo4j/movement-schema";
import { createNeo4jMovementPublisher } from "../../src/graph/publication/neo4j-movement-publisher";
import {
  executePreparedMovementGraphSeed,
  prepareMovementGraphSeed,
  type PreparedMovementGraphSeed,
} from "../../scripts/seed-movement-graph";
import { movementGraphSources } from "../../src/graph/ingest/movement-clinical";
import { canonicalJson, sha256 } from "../../src/graph/revisions/movement-graph";

const config = {
  uri: process.env.NEO4J_URI ?? "neo4j://127.0.0.1:7687",
  username: process.env.NEO4J_USERNAME ?? "neo4j",
  password: process.env.NEO4J_PASSWORD ?? "movement-graph-local-test",
  database: process.env.NEO4J_DATABASE ?? "neo4j",
  environment: "test" as const,
};

async function clearMovementNamespace(client: Neo4jClient) {
  await client.executeWrite(async (transaction) => {
    await transaction.run(`
      MATCH (node)
      WHERE node:GraphCatalog OR node:MovementRevision OR node:MovementConcept
        OR node:PublicationAttempt OR node:RevisionSeal OR node:ActivationEvent
      DETACH DELETE node
    `);
  });
  await setupMovementNeo4jSchema(client);
}

function prepared(): PreparedMovementGraphSeed {
  const result = prepareMovementGraphSeed();
  if (result.status !== "valid") throw new Error(JSON.stringify(result.validationErrors));
  return result;
}

const stageOptions = {
  mode: "stage" as const,
  clinicalReviewApprovalId: "clinical-review:synthetic-curated-v1",
};

describe.sequential("movement graph seed command", () => {
  let client: Neo4jClient;

  beforeAll(async () => {
    client = createNeo4jClient(config);
    await client.verifyConnectivity();
    await setupMovementNeo4jSchema(client);
  });
  beforeEach(async () => clearMovementNamespace(client));
  afterAll(async () => client.close());

  it("builds twice to one revision and dry-run performs no write", async () => {
    const first = prepared();
    const second = prepared();
    expect(first).toEqual(second);

    const before = await client.executeRead(async (transaction) => {
      const result = await transaction.run("MATCH (node) WHERE node:MovementRevision OR node:GraphCatalog RETURN count(node) AS count");
      return Number(result.records[0]?.get("count"));
    });
    const dryRun = await executePreparedMovementGraphSeed(undefined, first, { mode: "dry-run" });
    const after = await client.executeRead(async (transaction) => {
      const result = await transaction.run("MATCH (node) WHERE node:MovementRevision OR node:GraphCatalog RETURN count(node) AS count");
      return Number(result.records[0]?.get("count"));
    });

    expect(dryRun).toMatchObject({ status: "ok", validationStatus: "valid", graphRevisionId: first.snapshot.graphRevisionId });
    expect(after).toBe(before);
  });

  it("repeats and concurrently seeds one immutable snapshot without duplication", async () => {
    const seed = prepared();
    const publisher = createNeo4jMovementPublisher(client);
    const first = await executePreparedMovementGraphSeed(publisher, seed, stageOptions);
    const repeat = await executePreparedMovementGraphSeed(publisher, seed, stageOptions);
    expect(first).toMatchObject({ status: "ok", validationStatus: "sealed" });
    expect(repeat).toMatchObject({ status: "ok", validationStatus: "sealed" });

    await clearMovementNamespace(client);
    const concurrentPublisher = createNeo4jMovementPublisher(client);
    const results = await Promise.all([
      executePreparedMovementGraphSeed(concurrentPublisher, seed, stageOptions),
      executePreparedMovementGraphSeed(concurrentPublisher, seed, stageOptions),
    ]);
    expect(results.every((result) => result.status === "ok")).toBe(true);
    const counts = await client.executeRead(async (transaction) => {
      const result = await transaction.run(`
        MATCH (revision:MovementRevision {revisionId: $revisionId})
        OPTIONAL MATCH (concept:MovementConcept {graphRevisionId: $revisionId})
        RETURN count(DISTINCT revision) AS revisions, count(DISTINCT concept) AS concepts
      `, { revisionId: seed.snapshot.graphRevisionId });
      return {
        revisions: Number(result.records[0]?.get("revisions")),
        concepts: Number(result.records[0]?.get("concepts")),
      };
    });
    expect(counts).toEqual({ revisions: 1, concepts: seed.nodeCount });
  });

  it("quarantines changed immutable payload under an existing revision ID", async () => {
    const seed = prepared();
    const publisher = createNeo4jMovementPublisher(client);
    await executePreparedMovementGraphSeed(publisher, seed, stageOptions);
    const divergentSnapshot = {
      ...seed.snapshot,
      nodes: seed.snapshot.nodes.map((node, index) => index === 0 ? { ...node, label: `${node.label} changed` } : node),
    };
    const divergent = {
      ...seed,
      snapshot: divergentSnapshot,
      canonicalDigest: `sha256:${sha256(canonicalJson(divergentSnapshot))}`,
    };
    await expect(executePreparedMovementGraphSeed(publisher, divergent, stageOptions))
      .resolves.toMatchObject({ status: "failed", failureCode: "immutable_payload_conflict" });
    await expect(publisher.inspect(seed.snapshot.graphRevisionId))
      .resolves.toMatchObject({ status: "ok", data: { state: "sealed" } });
  });

  it("requires the expected prior revision and makes already-active retry safe", async () => {
    const seed = prepared();
    const publisher = createNeo4jMovementPublisher(client);
    await executePreparedMovementGraphSeed(publisher, seed, stageOptions);
    const stale = await executePreparedMovementGraphSeed(publisher, seed, {
      mode: "activate",
      clinicalReviewApprovalId: stageOptions.clinicalReviewApprovalId,
      expectedPriorRevisionId: "graph:sha256:stale",
      actorId: "curator:seed-test",
    });
    expect(stale).toMatchObject({ status: "failed", failureCode: "stale_revision" });
    await expect(publisher.inspect()).resolves.toMatchObject({ status: "ok", data: { activeRevisionId: null } });

    const activated = await executePreparedMovementGraphSeed(publisher, seed, {
      mode: "activate",
      clinicalReviewApprovalId: stageOptions.clinicalReviewApprovalId,
      expectedPriorRevisionId: null,
      actorId: "curator:seed-test",
    });
    const retry = await executePreparedMovementGraphSeed(publisher, seed, {
      mode: "activate",
      clinicalReviewApprovalId: stageOptions.clinicalReviewApprovalId,
      expectedPriorRevisionId: null,
      actorId: "curator:seed-test",
    });
    expect(activated).toMatchObject({ status: "ok", activationOutcome: "activated" });
    expect(retry).toMatchObject({ status: "ok", activationOutcome: "already_active" });
  });

  it("rejects invalid reviewed mappings and license records before writing", async () => {
    const invalidSources = structuredClone(movementGraphSources) as unknown as {
      mappings: { records: Array<{ status: string; source_artifact_digest?: string }> };
      sourceReviews: { records: Array<{ source_id: string; license: string | null }> };
    };
    invalidSources.mappings.records.find((record) => record.status === "reviewed")!.source_artifact_digest = "sha256:wrong";
    invalidSources.sourceReviews.records.find((record) => record.source_id === "source:snomed-gps-license")!.license = null;
    const invalid = prepareMovementGraphSeed(invalidSources as unknown as typeof movementGraphSources);
    expect(invalid).toMatchObject({ status: "invalid", validationStatus: "invalid" });
    const count = await client.executeRead(async (transaction) => {
      const result = await transaction.run("MATCH (revision:MovementRevision) RETURN count(revision) AS count");
      return Number(result.records[0]?.get("count"));
    });
    expect(count).toBe(0);
  });

  it("recovers an inactive sealed stage after interruption without changing the active graph", async () => {
    const seed = prepared();
    const publisher = createNeo4jMovementPublisher(client);
    const staged = await executePreparedMovementGraphSeed(publisher, seed, stageOptions);
    expect(staged).toMatchObject({ status: "ok", validationStatus: "sealed", activationOutcome: "not_requested" });
    await expect(publisher.inspect()).resolves.toMatchObject({ status: "ok", data: { activeRevisionId: null } });

    const recovered = await executePreparedMovementGraphSeed(publisher, seed, {
      mode: "activate",
      clinicalReviewApprovalId: stageOptions.clinicalReviewApprovalId,
      expectedPriorRevisionId: null,
      actorId: "curator:seed-recovery",
    });
    expect(recovered).toMatchObject({ status: "ok", activationOutcome: "activated" });
  });

  it("recovers a committed activation when its response is lost", async () => {
    const seed = prepared();
    const publisher = createNeo4jMovementPublisher(client);
    const responseLossPublisher: MovementGraphPublisher = {
      stage: (request) => publisher.stage(request),
      validate: (request) => publisher.validate(request),
      activate: async (request) => {
        const committed = await publisher.activate(request);
        if (committed.status !== "ok") return committed;
        return { status: "failed", failure: { code: "publication_unavailable", message: "simulated response loss" } };
      },
      inspect: (revisionId) => publisher.inspect(revisionId),
    };
    const lost = await executePreparedMovementGraphSeed(responseLossPublisher, seed, {
      mode: "activate",
      clinicalReviewApprovalId: stageOptions.clinicalReviewApprovalId,
      expectedPriorRevisionId: null,
      actorId: "curator:seed-recovery",
    });
    expect(lost).toMatchObject({ status: "failed", failureCode: "publication_unavailable" });

    const retry = await executePreparedMovementGraphSeed(publisher, seed, {
      mode: "activate",
      clinicalReviewApprovalId: stageOptions.clinicalReviewApprovalId,
      expectedPriorRevisionId: null,
      actorId: "curator:seed-recovery",
    });
    expect(retry).toMatchObject({ status: "ok", activationOutcome: "already_active" });
  });

  it("inspects one catalog pointer, sealed history, and zero forbidden relationships", async () => {
    const seed = prepared();
    const publisher = createNeo4jMovementPublisher(client);
    await executePreparedMovementGraphSeed(publisher, seed, {
      mode: "activate",
      clinicalReviewApprovalId: stageOptions.clinicalReviewApprovalId,
      expectedPriorRevisionId: null,
      actorId: "curator:seed-test",
    });
    const result = await client.executeRead(async (transaction) => {
      const query = await transaction.run(`
        MATCH (catalog:GraphCatalog {catalogId: 'movement-clinical'})
        OPTIONAL MATCH (revision:MovementRevision)
        OPTIONAL MATCH ()-[edge:MOVEMENT_EDGE]->()
        WHERE edge.kind IN ['contraindicated-for', 'equivalent-to', 'follows']
          OR edge.payload CONTAINS 'COPPER'
        RETURN count(DISTINCT catalog) AS catalogs,
          collect(DISTINCT catalog.activeRevisionId) AS activeRevisionIds,
          count(DISTINCT revision) AS revisions,
          count(DISTINCT edge) AS forbiddenEdges
      `);
      const record = query.records[0];
      return {
        catalogs: Number(record?.get("catalogs")),
        activeRevisionIds: record?.get("activeRevisionIds"),
        revisions: Number(record?.get("revisions")),
        forbiddenEdges: Number(record?.get("forbiddenEdges")),
      };
    });
    expect(result).toEqual({ catalogs: 1, activeRevisionIds: [seed.snapshot.graphRevisionId], revisions: 1, forbiddenEdges: 0 });
  });
});
