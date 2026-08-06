import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compileMemberContextGraph } from "../../src/graph/ingest/member-context";
import { createNeo4jClient, type Neo4jClient } from "../../src/graph/neo4j/client";
import { setupMemberContextNeo4jSchema } from "../../src/graph/neo4j/member-context-schema";
import { createNeo4jMemberContextPublisher } from "../../src/graph/publication/neo4j-member-context-publisher";
import { runMemberContextSeed } from "../../scripts/seed-member-context";
import { buildMemberContextFixture } from "../fixtures/member-context-builder";
import { resetMemberContextTestGraph } from "./member-context-neo4j-test-support";

const config = {
  uri: process.env.NEO4J_URI ?? "neo4j://127.0.0.1:7687",
  username: process.env.NEO4J_USERNAME ?? "neo4j",
  password: process.env.NEO4J_PASSWORD ?? "movement-graph-local-test",
  database: process.env.NEO4J_DATABASE ?? "neo4j",
  environment: "test" as const,
};

describe.sequential("member context seed", () => {
  let client: Neo4jClient;

  beforeAll(async () => {
    client = createNeo4jClient(config);
    await client.verifyConnectivity();
    await setupMemberContextNeo4jSchema(client);
  });
  beforeEach(async () => {
    await resetMemberContextTestGraph(client, config.uri);
    await setupMemberContextNeo4jSchema(client);
  });
  afterAll(async () => client.close());

  it("loads only the tracked source and dry-runs without database writes", async () => {
    const publisher = createNeo4jMemberContextPublisher(client);
    const result = await runMemberContextSeed({ mode: "dry-run" }, { publisher });

    expect(result).toMatchObject({ outcome: "validated", sourcePath: "data/member-context.json", valid: true });
    expect(result.nodeCount).toBeGreaterThan(0);
    expect(result.relationshipCount).toBeGreaterThan(0);
    await expect(publisher.inspect(result.memberId)).resolves.toMatchObject({
      status: "ok",
      data: { state: "missing", activeRevisionId: null },
    });
  });

  it("activates once and repeats as an idempotent no-op", async () => {
    const publisher = createNeo4jMemberContextPublisher(client, {
      now: () => "2026-08-06T12:00:00.000Z",
      createId: () => "member-activation-event:seed-test",
    });

    const first = await runMemberContextSeed({ mode: "publish" }, { publisher });
    const repeated = await runMemberContextSeed({ mode: "publish" }, { publisher });

    expect(first).toMatchObject({ outcome: "activated", activeRevisionBefore: null });
    expect(repeated).toMatchObject({
      outcome: "already-active",
      activeRevisionBefore: first.contextRevisionId,
      activeRevisionAfter: first.contextRevisionId,
    });
    expect(repeated.contextRevisionId).toBe(first.contextRevisionId);
  });

  it("validates before write and preserves the active revision on validation failure", async () => {
    const publisher = createNeo4jMemberContextPublisher(client);
    const active = await runMemberContextSeed({ mode: "publish" }, { publisher });
    const invalid = structuredClone(compileMemberContextGraph(buildMemberContextFixture())) as unknown as {
      nodes: Array<Record<string, unknown>>;
    };
    invalid.nodes = invalid.nodes.filter((node) => node.kind !== "member-profile");

    const failed = await runMemberContextSeed(
      { mode: "publish", snapshot: invalid as never },
      { publisher },
    );

    expect(failed).toMatchObject({
      outcome: "validation-failed",
      valid: false,
      activeRevisionBefore: active.contextRevisionId,
      activeRevisionAfter: active.contextRevisionId,
    });
    await expect(publisher.inspect(active.memberId)).resolves.toMatchObject({
      status: "ok",
      data: { activeRevisionId: active.contextRevisionId },
    });
  });

  it("inspects the active revision without publishing", async () => {
    const publisher = createNeo4jMemberContextPublisher(client);
    const active = await runMemberContextSeed({ mode: "publish" }, { publisher });

    await expect(runMemberContextSeed({ mode: "inspect" }, { publisher })).resolves.toMatchObject({
      outcome: "active",
      memberId: active.memberId,
      activeRevisionAfter: active.contextRevisionId,
    });
  });
});
