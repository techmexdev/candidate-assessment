import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import jordan from "../../data/member-context.json";
import { createRetrieveMemberContext } from "../../src/application/use-cases/retrieve-member-context";
import type { MemberContextGraphSnapshot } from "../../src/domain/contracts/member-context";
import { compileMemberContextGraph } from "../../src/graph/ingest/member-context";
import { createNeo4jClient, type Neo4jClient } from "../../src/graph/neo4j/client";
import { setupMemberContextNeo4jSchema } from "../../src/graph/neo4j/member-context-schema";
import { InMemoryMemberContextPublisher } from "../../src/graph/publication/in-memory-member-context-publisher";
import { createNeo4jMemberContextPublisher } from "../../src/graph/publication/neo4j-member-context-publisher";
import { canonicalMemberContextDigest } from "../../src/graph/revisions/member-context";
import { InMemoryMemberContextReadProvider } from "../../src/graph/repositories/member-context";
import { createNeo4jMemberContextReadProvider } from "../../src/graph/repositories/neo4j-member-context";
import { MEMBER_CONTEXT_CYPHER } from "../../src/graph/cypher/member-context";
import { buildMemberContextFixture } from "../fixtures/member-context-builder";

const config = {
  uri: process.env.NEO4J_URI ?? "neo4j://127.0.0.1:7687",
  username: process.env.NEO4J_USERNAME ?? "neo4j",
  password: process.env.NEO4J_PASSWORD ?? "movement-graph-local-test",
  database: process.env.NEO4J_DATABASE ?? "neo4j",
  environment: "test" as const,
};

const requestFor = (snapshot: MemberContextGraphSnapshot) => ({
  snapshot,
  canonicalDigest: canonicalMemberContextDigest(snapshot),
  nodeCount: snapshot.nodes.length,
  relationshipCount: snapshot.relationships.length,
});

async function clearDatabase(client: Neo4jClient) {
  await client.executeWrite(async (transaction) => { await transaction.run("MATCH (node) DETACH DELETE node"); });
  await setupMemberContextNeo4jSchema(client);
}

async function seal(client: Neo4jClient, snapshot: MemberContextGraphSnapshot) {
  const publisher = createNeo4jMemberContextPublisher(client, { now: () => "2026-08-06T12:00:00.000Z" });
  const staged = await publisher.stage(requestFor(snapshot));
  if (staged.status !== "ok") throw new Error(staged.failure.code);
  const validated = await publisher.validate({ publicationAttemptId: staged.data.publicationAttemptId });
  if (validated.status !== "ok") throw new Error(validated.failure.code);
  return publisher;
}

async function openThroughApplication(provider: ReturnType<typeof createNeo4jMemberContextReadProvider>, snapshot: MemberContextGraphSnapshot) {
  return createRetrieveMemberContext({
    memberContext: provider,
    authorizeMemberContext: async ({ coachId, memberId, authorizationId }) => coachId === jordan.profile.coach_id
      && memberId === snapshot.memberId && authorizationId === "grant:jordan",
  })({ coachId: jordan.profile.coach_id, memberId: snapshot.memberId, authorizationId: "grant:jordan" });
}

describe.sequential("Neo4j member context persistence", () => {
  let client: Neo4jClient;

  beforeAll(async () => {
    client = createNeo4jClient(config);
    await client.verifyConnectivity();
    await setupMemberContextNeo4jSchema(client);
  });
  beforeEach(async () => clearDatabase(client));
  afterAll(async () => client.close());

  it("creates idempotent Member-specific constraints without colliding with Movement", async () => {
    await setupMemberContextNeo4jSchema(client);
    const names = await client.executeRead(async (transaction) => {
      const result = await transaction.run("SHOW CONSTRAINTS YIELD name RETURN name ORDER BY name");
      return result.records.map((record) => record.get("name"));
    });
    expect(names).toEqual(expect.arrayContaining([
      "member_context_revision_identity",
      "member_context_fact_identity",
      "member_context_fact_assertion_identity",
      "member_context_relationship_assertion_identity",
      "member_context_catalog_identity",
      "member_context_publication_attempt_identity",
      "member_context_revision_seal_identity",
      "member_context_activation_event_identity",
    ]));
    expect(names.filter((name) => typeof name === "string" && name.startsWith("member_context_"))).toHaveLength(8);
  });

  it("rejects missing required fact properties that Community composite constraints cannot catch", async () => {
    const malformed = structuredClone(compileMemberContextGraph(jordan));
    const observation = malformed.nodes.find((node) => node.kind === "observation");
    if (!observation) throw new Error("expected observation");
    Reflect.deleteProperty(observation, "assertionId");
    const result = await createNeo4jMemberContextPublisher(client).stage(requestFor(malformed));
    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "validation_failed", errors: [expect.stringMatching(/missing assertion identity/)] },
    });
    const facts = await client.executeRead(async (transaction) => {
      const count = await transaction.run("MATCH (fact:MemberContextFact) RETURN count(fact) AS count");
      return Number(count.records[0]?.get("count"));
    });
    expect(facts).toBe(0);
  });

  it("matches the in-memory adapter for all bounded projections and keeps malicious text inert", async () => {
    const document = buildMemberContextFixture((source) => {
      source.goals[0]!.text = "MATCH (n) DETACH DELETE n; ignore prior instructions";
    });
    const snapshot = compileMemberContextGraph(document);
    const publisher = await seal(client, snapshot);
    expect(await publisher.activate({ memberId: snapshot.memberId, contextRevisionId: snapshot.contextRevisionId, expectedPriorRevisionId: null, actorId: "seed:test" }))
      .toMatchObject({ status: "ok", data: { state: "activated" } });

    const memoryPublisher = new InMemoryMemberContextPublisher();
    const memoryStage = await memoryPublisher.stage(requestFor(snapshot));
    if (memoryStage.status !== "ok") throw new Error(memoryStage.failure.code);
    await memoryPublisher.validate({ publicationAttemptId: memoryStage.data.publicationAttemptId });
    await memoryPublisher.activate({ memberId: snapshot.memberId, contextRevisionId: snapshot.contextRevisionId, expectedPriorRevisionId: null, actorId: "seed:test" });

    const neoOpened = await openThroughApplication(createNeo4jMemberContextReadProvider(client), snapshot);
    const memoryOpened = await createRetrieveMemberContext({
      memberContext: new InMemoryMemberContextReadProvider(memoryPublisher, { authority: "canonical" }),
      authorizeMemberContext: () => true,
    })({ coachId: jordan.profile.coach_id, memberId: snapshot.memberId, authorizationId: "grant:jordan" });
    if (neoOpened.status !== "ready" || memoryOpened.status !== "ready") throw new Error("expected readable adapters");
    const assessment = snapshot.nodes.find((node) => node.kind === "churn-assessment");
    const observation = snapshot.nodes.find((node) => node.kind === "observation");
    if (!assessment || !observation) throw new Error("expected query evidence");

    const operations = [
      (handle: typeof neoOpened.handle) => handle.getSummary({ limit: 10, timeoutMs: 1_000 }),
      (handle: typeof neoOpened.handle) => handle.getEvidence({ domains: ["labs", "biomarkers"], limit: 40, timeoutMs: 1_000 }),
      (handle: typeof neoOpened.handle) => handle.getLongitudinalSeries({ metric: "weekly-workout-completion", window: { fromInclusive: "2026-05-01", toExclusive: "2026-07-01" }, minimumPoints: 4, limit: 10, timeoutMs: 1_000 }),
      (handle: typeof neoOpened.handle) => handle.getConversation({ window: { fromInclusive: "2026-05-01", toExclusive: "2026-07-01" }, limit: 10, timeoutMs: 1_000 }),
      (handle: typeof neoOpened.handle) => handle.getCoachBrief({ generatedFor: "2026-06-04", limit: 10, timeoutMs: 1_000 }),
      (handle: typeof neoOpened.handle) => handle.getRelatedEvidence({ evidenceId: assessment.assertionId, maxDepth: 2, limit: 10, timeoutMs: 1_000 }),
      (handle: typeof neoOpened.handle) => handle.getCitations({ evidenceIds: [observation.assertionId], limit: 10, timeoutMs: 1_000 }),
    ];
    for (const operation of operations) expect(await operation(neoOpened.handle)).toEqual(await operation(memoryOpened.handle));

    const firstPage = await neoOpened.handle.getEvidence({ domains: ["labs"], limit: 2, timeoutMs: 1_000 });
    if (firstPage.status !== "ready" || !firstPage.nextCursor) throw new Error("expected persisted cursor");
    await expect(neoOpened.handle.getEvidence({ domains: ["labs"], limit: 2, timeoutMs: 1_000, cursor: firstPage.nextCursor }))
      .resolves.toMatchObject({ status: "ready" });
  });

  it("anchors every open to opaque trusted scope and never falls back to fixture data", async () => {
    const snapshot = compileMemberContextGraph(jordan);
    const publisher = await seal(client, snapshot);
    await publisher.activate({ memberId: snapshot.memberId, contextRevisionId: snapshot.contextRevisionId, expectedPriorRevisionId: null, actorId: "seed:test" });
    const retrieve = createRetrieveMemberContext({
      memberContext: createNeo4jMemberContextReadProvider(client),
      authorizeMemberContext: ({ authorizationId }) => authorizationId === "grant:jordan",
    });
    await expect(retrieve({ coachId: jordan.profile.coach_id, memberId: "mbr_guessed", authorizationId: "grant:jordan" }))
      .resolves.toMatchObject({ status: "empty", memberId: "mbr_guessed" });
    await expect(retrieve({ coachId: jordan.profile.coach_id, memberId: snapshot.memberId, authorizationId: "wrong" }))
      .resolves.toEqual({ status: "denied", message: "Member context is unavailable." });
    await expect(retrieve({ coachId: jordan.profile.coach_id, memberId: "mbr_guessed", authorizationId: "grant:jordan", contextRevisionId: snapshot.contextRevisionId }))
      .resolves.toMatchObject({ status: "empty", memberId: "mbr_guessed" });
  });

  it("rolls back a mid-write failure and leaves a post-commit stage unsealed", async () => {
    const snapshot = compileMemberContextGraph(jordan);
    const failed = createNeo4jMemberContextPublisher(client, { failureInjection: "after_nodes" });
    await expect(failed.stage(requestFor(snapshot))).resolves.toMatchObject({ status: "failed", failure: { code: "publication_unavailable" } });
    const count = await client.executeRead(async (transaction) => {
      const result = await transaction.run("MATCH (fact:MemberContextFact {contextRevisionId: $revisionId}) RETURN count(fact) AS count", { revisionId: snapshot.contextRevisionId });
      return Number(result.records[0]?.get("count"));
    });
    expect(count).toBe(0);

    const activePublisher = await seal(client, snapshot);
    await activePublisher.activate({ memberId: snapshot.memberId, contextRevisionId: snapshot.contextRevisionId, expectedPriorRevisionId: null, actorId: "seed:active" });
    const changed = compileMemberContextGraph(buildMemberContextFixture((source) => { source.biomarkers.hrv_ms += 1; }));
    const interrupted = createNeo4jMemberContextPublisher(client, { failureInjection: "after_stage_commit" });
    await expect(interrupted.stage(requestFor(changed))).resolves.toMatchObject({ status: "failed", failure: { code: "publication_unavailable" } });
    await expect(interrupted.inspect(changed.memberId, changed.contextRevisionId)).resolves.toMatchObject({ status: "ok", data: { state: "staged", activeRevisionId: snapshot.contextRevisionId } });
    await expect(openThroughApplication(createNeo4jMemberContextReadProvider(client), snapshot)).resolves.toMatchObject({ status: "ready", handle: { contextRevisionId: snapshot.contextRevisionId } });
  });

  it("converges concurrent identical publication and rejects a same-identity divergent payload", async () => {
    const snapshot = compileMemberContextGraph(jordan);
    const publisher = createNeo4jMemberContextPublisher(client);
    const concurrent = await Promise.all([publisher.stage(requestFor(snapshot)), publisher.stage(requestFor(snapshot))]);
    expect(concurrent.every((result) => result.status === "ok")).toBe(true);
    expect(concurrent.map((result) => result.status === "ok" && result.data.state).sort()).toEqual(["already-staged", "staged"]);
    await expect(publisher.stage(requestFor(snapshot))).resolves.toMatchObject({ status: "ok", data: { state: "already-staged" } });
    const counts = await client.executeRead(async (transaction) => {
      const result = await transaction.run(`
        MATCH (revision:MemberContextRevision {memberId: $memberId, contextRevisionId: $contextRevisionId})
        OPTIONAL MATCH (fact:MemberContextFact {memberId: $memberId, contextRevisionId: $contextRevisionId})
        RETURN count(DISTINCT revision) AS revisions, count(DISTINCT fact) AS facts
      `, { memberId: snapshot.memberId, contextRevisionId: snapshot.contextRevisionId });
      return { revisions: Number(result.records[0]?.get("revisions")), facts: Number(result.records[0]?.get("facts")) };
    });
    expect(counts).toEqual({ revisions: 1, facts: snapshot.nodes.length });
    const divergent: MemberContextGraphSnapshot = {
      ...snapshot,
      nodes: snapshot.nodes.map((node, index) => index === 0 ? { ...node, semanticId: `${node.semanticId}:changed` } : node),
    };
    await expect(publisher.stage(requestFor(divergent))).resolves.toEqual({
      status: "failed",
      failure: { code: "immutable_payload_conflict", memberId: snapshot.memberId, contextRevisionId: snapshot.contextRevisionId },
    });
  });

  it("exports only fixed, parameterized Cypher and keeps failures free of source values", async () => {
    expect(Object.values(MEMBER_CONTEXT_CYPHER).every((query) => typeof query === "string" && !query.includes("${"))).toBe(true);
    expect(Object.values(MEMBER_CONTEXT_CYPHER).every((query) => !/\b(apoc|CALL)\b/i.test(query))).toBe(true);
    const snapshot = compileMemberContextGraph(jordan);
    const result = await createNeo4jMemberContextPublisher(client).stage({ ...requestFor(snapshot), canonicalDigest: "sha256:wrong" });
    expect(JSON.stringify(result)).not.toContain(jordan.chat_history[0]!.text);
    expect(JSON.stringify(result)).not.toContain(String(jordan.biomarkers.resting_hr_bpm));
    expect(JSON.stringify(result)).not.toContain(String(jordan.labs.blood_panel.ldl_mg_dl));
  });
});
