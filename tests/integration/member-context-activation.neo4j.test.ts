import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import jordan from "../../data/member-context.json";
import type { MemberContextGraphSnapshot } from "../../src/domain/contracts/member-context";
import { compileMemberContextGraph } from "../../src/graph/ingest/member-context";
import { createNeo4jClient, type Neo4jClient } from "../../src/graph/neo4j/client";
import { setupMemberContextNeo4jSchema } from "../../src/graph/neo4j/member-context-schema";
import { createNeo4jMemberContextPublisher } from "../../src/graph/publication/neo4j-member-context-publisher";
import { canonicalMemberContextDigest } from "../../src/graph/revisions/member-context";
import { buildMemberContextFixture } from "../fixtures/member-context-builder";
import { resetMemberContextTestGraph } from "./member-context-neo4j-test-support";

const config = { uri: process.env.NEO4J_URI ?? "neo4j://127.0.0.1:7687", username: process.env.NEO4J_USERNAME ?? "neo4j", password: process.env.NEO4J_PASSWORD ?? "movement-graph-local-test", database: process.env.NEO4J_DATABASE ?? "neo4j", environment: "test" as const };
const requestFor = (snapshot: MemberContextGraphSnapshot) => ({ snapshot, canonicalDigest: canonicalMemberContextDigest(snapshot), nodeCount: snapshot.nodes.length, relationshipCount: snapshot.relationships.length });

describe.sequential("Neo4j member context activation", () => {
  let client: Neo4jClient;
  beforeAll(async () => { client = createNeo4jClient(config); await client.verifyConnectivity(); await setupMemberContextNeo4jSchema(client); });
  beforeEach(async () => { await resetMemberContextTestGraph(client, config.uri); await setupMemberContextNeo4jSchema(client); });
  afterAll(async () => client.close());

  async function seal(snapshot: MemberContextGraphSnapshot) {
    const publisher = createNeo4jMemberContextPublisher(client, { now: () => "2026-08-06T12:00:00.000Z", createId: () => `activation:${snapshot.contextRevisionId}` });
    const staged = await publisher.stage(requestFor(snapshot));
    if (staged.status !== "ok") throw new Error(staged.failure.code);
    const validated = await publisher.validate({ publicationAttemptId: staged.data.publicationAttemptId });
    if (validated.status !== "ok") throw new Error(validated.failure.code);
    return publisher;
  }

  it("activates only sealed revisions and makes same-target activation idempotent", async () => {
    const first = compileMemberContextGraph(jordan);
    const publisher = await seal(first);
    await expect(publisher.activate({ memberId: first.memberId, contextRevisionId: first.contextRevisionId, expectedPriorRevisionId: null, actorId: "seed:first" }))
      .resolves.toMatchObject({ status: "ok", data: { state: "activated", priorRevisionId: null } });
    await expect(publisher.activate({ memberId: first.memberId, contextRevisionId: first.contextRevisionId, expectedPriorRevisionId: null, actorId: "seed:first" }))
      .resolves.toMatchObject({ status: "ok", data: { state: "already-active" } });

    const unsealed = compileMemberContextGraph(buildMemberContextFixture((source) => { source.biomarkers.hrv_ms += 1; }));
    await publisher.stage(requestFor(unsealed));
    await expect(publisher.activate({ memberId: unsealed.memberId, contextRevisionId: unsealed.contextRevisionId, expectedPriorRevisionId: first.contextRevisionId, actorId: "seed:unsealed" }))
      .resolves.toEqual({ status: "failed", failure: { code: "not_sealed", memberId: unsealed.memberId, contextRevisionId: unsealed.contextRevisionId } });
  });

  it("serializes concurrent compare-and-swap activation for different targets", async () => {
    const first = compileMemberContextGraph(jordan);
    const second = compileMemberContextGraph(buildMemberContextFixture((source) => { source.biomarkers.hrv_ms += 1; }));
    const third = compileMemberContextGraph(buildMemberContextFixture((source) => { source.biomarkers.hrv_ms += 2; }));
    const publisher = await seal(first);
    await seal(second); await seal(third);
    await publisher.activate({ memberId: first.memberId, contextRevisionId: first.contextRevisionId, expectedPriorRevisionId: null, actorId: "seed:first" });
    const outcomes = await Promise.all([
      publisher.activate({ memberId: second.memberId, contextRevisionId: second.contextRevisionId, expectedPriorRevisionId: first.contextRevisionId, actorId: "seed:second" }),
      publisher.activate({ memberId: third.memberId, contextRevisionId: third.contextRevisionId, expectedPriorRevisionId: first.contextRevisionId, actorId: "seed:third" }),
    ]);
    expect(outcomes.filter((result) => result.status === "ok")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "failed" && result.failure.code === "stale_revision")).toHaveLength(1);
  });

  it("does not activate a sealed revision after canonical payload tampering", async () => {
    const snapshot = compileMemberContextGraph(jordan);
    const publisher = await seal(snapshot);
    await client.executeWrite(async (transaction) => {
      await transaction.run("MATCH (fact:MemberContextFact {memberId: $memberId, contextRevisionId: $revisionId}) WITH fact LIMIT 1 SET fact.payload = $payload", { memberId: snapshot.memberId, revisionId: snapshot.contextRevisionId, payload: "{\"tampered\":true}" });
    });
    await expect(publisher.activate({ memberId: snapshot.memberId, contextRevisionId: snapshot.contextRevisionId, expectedPriorRevisionId: null, actorId: "seed:test" }))
      .resolves.toEqual({ status: "failed", failure: { code: "not_sealed", memberId: snapshot.memberId, contextRevisionId: snapshot.contextRevisionId } });
  });

  it("keeps immutable history and preserves catalog state across client restart", async () => {
    const first = compileMemberContextGraph(jordan);
    const second = compileMemberContextGraph(buildMemberContextFixture((source) => { source.biomarkers.hrv_ms += 1; }));
    const publisher = await seal(first); await seal(second);
    await publisher.activate({ memberId: first.memberId, contextRevisionId: first.contextRevisionId, expectedPriorRevisionId: null, actorId: "seed:first" });
    await publisher.activate({ memberId: second.memberId, contextRevisionId: second.contextRevisionId, expectedPriorRevisionId: first.contextRevisionId, actorId: "seed:second" });

    const restarted = createNeo4jClient(config);
    try {
      const restartedPublisher = createNeo4jMemberContextPublisher(restarted);
      await expect(restartedPublisher.inspect(first.memberId)).resolves.toMatchObject({ status: "ok", data: { activeRevisionId: second.contextRevisionId } });
      await expect(restartedPublisher.inspect(first.memberId, first.contextRevisionId)).resolves.toMatchObject({ status: "ok", data: { state: "sealed" } });
      const events = await restarted.executeRead(async (transaction) => {
        const result = await transaction.run("MATCH (event:MemberContextActivationEvent {memberId: $memberId}) RETURN event.contextRevisionId AS revisionId ORDER BY event.activatedAt, event.eventId", { memberId: first.memberId });
        return result.records.map((record) => record.get("revisionId"));
      });
      expect(events).toHaveLength(2);
    } finally {
      await restarted.close();
    }
  });
});
