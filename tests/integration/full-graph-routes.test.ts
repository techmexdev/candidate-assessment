import { beforeAll, describe, expect, it } from "vitest";

import jordan from "../../data/member-context.json";
import { createMemberContextGraphHandler } from "../../src/app/api/member-context/graph/route";
import { createMovementGraphHandler } from "../../src/app/api/movement-graph/route";
import { createRetrieveFullGraph } from "../../src/application/use-cases/retrieve-full-graph";
import type { FullGraphReadResult } from "../../src/domain/contracts/full-graph-view";
import type { MemberContextGraphSnapshot } from "../../src/domain/contracts/member-context";
import { compileMemberContextGraph } from "../../src/graph/ingest/member-context";
import { compileDefaultMovementGraph } from "../../src/graph/ingest/movement-clinical";
import { InMemoryMemberContextPublisher } from "../../src/graph/publication/in-memory-member-context-publisher";
import { InMemoryMemberContextReadProvider } from "../../src/graph/repositories/member-context";
import { InMemoryMovementGraphReadProvider } from "../../src/graph/repositories/movement-graph";
import { canonicalMemberContextDigest } from "../../src/graph/revisions/member-context";

const COACH_ID = jordan.profile.coach_id;
const AUTHORIZATION_ID = "integration:coach-session";

function request(path: string): Request {
  return new Request(`https://axon.integration${path}`, { headers: { cookie: "coach-session=integration" } });
}

async function publish(publisher: InMemoryMemberContextPublisher, snapshot: MemberContextGraphSnapshot, expectedPriorRevisionId: string | null) {
  const staged = await publisher.stage({
    snapshot,
    canonicalDigest: canonicalMemberContextDigest(snapshot),
    nodeCount: snapshot.nodes.length,
    relationshipCount: snapshot.relationships.length,
  });
  if (staged.status !== "ok") throw new Error(staged.failure.code);
  const validated = await publisher.validate({ publicationAttemptId: staged.data.publicationAttemptId });
  if (validated.status !== "ok") throw new Error(validated.failure.code);
  const activated = await publisher.activate({
    memberId: snapshot.memberId,
    contextRevisionId: snapshot.contextRevisionId,
    expectedPriorRevisionId,
    actorId: "integration:test",
  });
  if (activated.status !== "ok") throw new Error(activated.failure.code);
}

function ready(result: FullGraphReadResult) {
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("Expected a ready full graph result");
  return result.data;
}

describe("full graph route integration", () => {
  const movementCompiled = compileDefaultMovementGraph();
  if (movementCompiled.status !== "valid") throw new Error(JSON.stringify(movementCompiled.report));
  const movementSnapshot = movementCompiled.snapshot;
  const firstMemberSnapshot = compileMemberContextGraph(jordan);
  const revisedDocument = structuredClone(jordan);
  revisedDocument.chat_history[0]!.text = `${revisedDocument.chat_history[0]!.text} Revised for integration.`;
  const secondMemberSnapshot = compileMemberContextGraph(revisedDocument);
  const publisher = new InMemoryMemberContextPublisher();
  const movement = new InMemoryMovementGraphReadProvider([movementSnapshot], { authority: "canonical" });
  const memberContext = new InMemoryMemberContextReadProvider(publisher, { authority: "canonical" });
  const retrieve = createRetrieveFullGraph({
    movement,
    memberContext,
    authorizeMemberContext: ({ coachId, memberId, authorizationId }) => (
      coachId === COACH_ID && memberId === firstMemberSnapshot.memberId && authorizationId === AUTHORIZATION_ID
    ),
  });

  beforeAll(async () => {
    await publish(publisher, firstMemberSnapshot, null);
    await publish(publisher, secondMemberSnapshot, firstMemberSnapshot.contextRevisionId);
  });

  it("keeps canonical movement and member projections complete and domain-separated", async () => {
    const movementHandler = createMovementGraphHandler({
      resolveSession: async () => ({ status: "authorized", coachId: COACH_ID, authorizationId: AUTHORIZATION_ID }),
      readMovement: retrieve.readMovement,
    });
    const memberHandler = createMemberContextGraphHandler({
      resolveSession: async () => ({ status: "authorized", coachId: COACH_ID, authorizationId: AUTHORIZATION_ID }),
      readMemberContext: retrieve.readMemberContext,
    });

    const movementData = ready(await movementHandler(request("/api/movement-graph")).then(async (response) => response.json() as Promise<FullGraphReadResult>));
    const memberData = ready(await memberHandler(request(`/api/member-context/graph?memberId=${encodeURIComponent(firstMemberSnapshot.memberId)}`)).then(async (response) => response.json() as Promise<FullGraphReadResult>));

    expect(movementData).toMatchObject({
      domain: "movement-clinical",
      revisionId: movementSnapshot.graphRevisionId,
      authority: "canonical",
      counts: { nodes: movementSnapshot.nodes.length, relationships: movementSnapshot.edges.length },
    });
    expect(memberData).toMatchObject({
      domain: "member-context",
      memberId: firstMemberSnapshot.memberId,
      revisionId: secondMemberSnapshot.contextRevisionId,
      sourceArtifactDigest: secondMemberSnapshot.sourceArtifactDigest,
      authority: "canonical",
      counts: { nodes: secondMemberSnapshot.nodes.length, relationships: secondMemberSnapshot.relationships.length },
    });
    expect(memberData.nodes.every((node) => node.kind !== "exercise")).toBe(true);
    expect(memberData.nodes).toHaveLength(memberData.counts.nodes);
    expect(memberData.relationships).toHaveLength(memberData.counts.relationships);
    const memberNodeIds = new Set(memberData.nodes.map((node) => node.id));
    expect(memberData.relationships.every((relationship) => memberNodeIds.has(relationship.fromId) && memberNodeIds.has(relationship.toId))).toBe(true);
  });

  it("rejects a cross-member read and reports a pinned member revision as stale", async () => {
    const handler = createMemberContextGraphHandler({
      resolveSession: async () => ({ status: "authorized", coachId: COACH_ID, authorizationId: AUTHORIZATION_ID }),
      readMemberContext: retrieve.readMemberContext,
    });

    const denied = await handler(request("/api/member-context/graph?memberId=member%3Aother"));
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ status: "denied", domain: "member-context", message: "Member context is unavailable." });

    const stale = await handler(request(`/api/member-context/graph?memberId=${encodeURIComponent(firstMemberSnapshot.memberId)}&contextRevisionId=${encodeURIComponent(firstMemberSnapshot.contextRevisionId)}`));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      status: "stale",
      domain: "member-context",
      requestedRevisionId: firstMemberSnapshot.contextRevisionId,
      activeRevisionId: secondMemberSnapshot.contextRevisionId,
    });
    expect(stale.headers.get("cache-control")).toContain("no-store");
  });
});
