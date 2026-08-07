import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import jordan from "../../data/member-context.json";
import { createCopilotPostHandler } from "../../src/app/api/copilot/route";
import type { CopilotModel } from "../../src/application/ports/copilot-model";
import type { CopilotAnswerPacket, CopilotContinuationClaims } from "../../src/domain/contracts/copilot";
import type { MemberContextGraphSnapshot } from "../../src/domain/contracts/member-context";
import { compileMemberContextGraph } from "../../src/graph/ingest/member-context";
import { createNeo4jClient, type Neo4jClient } from "../../src/graph/neo4j/client";
import { setupMemberContextNeo4jSchema } from "../../src/graph/neo4j/member-context-schema";
import { createNeo4jMemberContextPublisher } from "../../src/graph/publication/neo4j-member-context-publisher";
import { canonicalMemberContextDigest } from "../../src/graph/revisions/member-context";
import { createNeo4jMemberContextReadProvider } from "../../src/graph/repositories/neo4j-member-context";
import { createCopilotApplication } from "../../src/server/copilot/composition";
import { createCopilotContinuationAuthority } from "../../src/server/copilot/continuation-token";
import { buildMemberContextFixture } from "../fixtures/member-context-builder";
import { resetMemberContextTestGraph } from "./member-context-neo4j-test-support";

const config = {
  uri: process.env.NEO4J_URI ?? "neo4j://127.0.0.1:7687",
  username: process.env.NEO4J_USERNAME ?? "neo4j",
  password: process.env.NEO4J_PASSWORD ?? "movement-graph-local-test",
  database: process.env.NEO4J_DATABASE ?? "neo4j",
  environment: "test" as const,
};
const NOW = "2026-08-07T10:00:00.000Z";
const SECRET = "integration-copilot-continuation-secret-v1----";
const JORDAN_ID = jordan.profile.id;
const COACH_ID = jordan.profile.coach_id;

function publication(snapshot: MemberContextGraphSnapshot) {
  return {
    snapshot,
    canonicalDigest: canonicalMemberContextDigest(snapshot),
    nodeCount: snapshot.nodes.length,
    relationshipCount: snapshot.relationships.length,
  };
}

function requestBody(memberId = JORDAN_ID) {
  return {
    schemaVersion: "copilot-request/v1",
    requestId: "request:integration",
    memberId,
    requestedFor: "2026-07-08",
    input: { kind: "quick-prompt", promptId: "morning-brief" },
  } as const;
}

function httpRequest(body: unknown) {
  return new Request("https://axon.test/api/copilot", {
    method: "POST",
    headers: { origin: "https://axon.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe.sequential("Copilot canonical Neo4j grounding", () => {
  let client: Neo4jClient;
  let first: MemberContextGraphSnapshot;

  beforeAll(async () => {
    client = createNeo4jClient(config);
    await client.verifyConnectivity();
    await setupMemberContextNeo4jSchema(client);
  });

  beforeEach(async () => {
    await resetMemberContextTestGraph(client, config.uri);
    await setupMemberContextNeo4jSchema(client);
    first = compileMemberContextGraph(jordan);
    const publisher = createNeo4jMemberContextPublisher(client, { now: () => NOW });
    const staged = await publisher.stage(publication(first));
    if (staged.status !== "ok") throw new Error(staged.failure.code);
    const validated = await publisher.validate({ publicationAttemptId: staged.data.publicationAttemptId });
    if (validated.status !== "ok") throw new Error(validated.failure.code);
    const activated = await publisher.activate({
      memberId: first.memberId,
      contextRevisionId: first.contextRevisionId,
      expectedPriorRevisionId: null,
      actorId: "test:copilot",
    });
    if (activated.status !== "ok") throw new Error(activated.failure.code);
  });

  afterAll(async () => client.close());

  function harness(options: {
    readonly authorizationId?: string;
    readonly authorize?: (input: Readonly<{ coachId: string; memberId: string; authorizationId: string }>) => boolean | Promise<boolean>;
  } = {}) {
    const authorizationId = options.authorizationId ?? "grant:integration";
    const authorize = options.authorize ?? ((input) => input.coachId === COACH_ID
      && input.authorizationId === authorizationId
      && [JORDAN_ID, "mbr_02HX9AVERY", "mbr_03HX9MORGAN"].includes(input.memberId));
    const continuation = createCopilotContinuationAuthority({ secret: SECRET, now: () => NOW });
    const model: CopilotModel = {
      select: vi.fn(async () => ({ status: "failed" as const, reason: "unavailable" as const })),
    };
    const answer = createCopilotApplication({
      memberContext: createNeo4jMemberContextReadProvider(client),
      authorizeMemberContext: authorize,
      model,
      continuation,
      now: () => NOW,
    });
    const handler = createCopilotPostHandler({
      resolveSession: async () => ({
        status: "authorized",
        coachId: COACH_ID,
        authorizationId,
        entitledMemberIds: [JORDAN_ID, "mbr_02HX9AVERY", "mbr_03HX9MORGAN"],
      }),
      answer,
    });
    return { handler, model, continuation };
  }

  it("returns Jordan's canonical sealed revision with resolvable citations and no model call", async () => {
    const { handler, model } = harness();
    const response = await handler(httpRequest(requestBody()));
    const payload = await response.json() as { status: string; answer: CopilotAnswerPacket };

    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.status).toBe("ready");
    expect(payload.answer).toMatchObject({
      memberId: JORDAN_ID,
      contextRevisionId: first.contextRevisionId,
      authority: "canonical",
      intentId: "morning-brief",
    });
    expect(payload.answer.citations.length).toBeGreaterThan(0);
    expect(payload.answer.citations.every((citation) => citation.memberId === JORDAN_ID
      && citation.contextRevisionId === first.contextRevisionId
      && payload.answer.evidence.atoms.some((atom) => atom.evidenceId === citation.evidenceId))).toBe(true);
    expect(model.select).not.toHaveBeenCalled();
  });

  it("keeps the initially opened sealed revision when a newer revision activates before recipe reads", async () => {
    const second = compileMemberContextGraph(buildMemberContextFixture((source) => {
      source.biomarkers.hrv_ms += 1;
    }));
    const publisher = createNeo4jMemberContextPublisher(client, { now: () => NOW });
    const staged = await publisher.stage(publication(second));
    if (staged.status !== "ok") throw new Error(staged.failure.code);
    const validated = await publisher.validate({ publicationAttemptId: staged.data.publicationAttemptId });
    if (validated.status !== "ok") throw new Error(validated.failure.code);

    let authorizationChecks = 0;
    let activationStarted = false;
    const { handler } = harness({
      authorize: async (input) => {
        authorizationChecks += 1;
        if (authorizationChecks >= 3 && !activationStarted) {
          activationStarted = true;
          const activated = await publisher.activate({
            memberId: second.memberId,
            contextRevisionId: second.contextRevisionId,
            expectedPriorRevisionId: first.contextRevisionId,
            actorId: "test:activate-during-copilot",
          });
          if (activated.status !== "ok") throw new Error(activated.failure.code);
        }
        return input.coachId === COACH_ID && input.authorizationId === "grant:integration" && input.memberId === JORDAN_ID;
      },
    });
    const response = await handler(httpRequest(requestBody()));
    const payload = await response.json() as { answer: CopilotAnswerPacket };

    expect(payload.answer, JSON.stringify(payload)).toBeDefined();
    expect(payload.answer.contextRevisionId).toBe(first.contextRevisionId);
    expect(payload.answer.citations.every((citation) => citation.contextRevisionId === first.contextRevisionId)).toBe(true);
    const active = await publisher.inspect(JORDAN_ID);
    expect(active).toMatchObject({ status: "ok", data: { activeRevisionId: second.contextRevisionId } });
  });

  it("keeps roster-empty, guessed, wrong-grant, and foreign-evidence failures non-enumerating", async () => {
    const { handler, continuation } = harness();
    const avery = await handler(httpRequest(requestBody("mbr_02HX9AVERY")));
    const morgan = await handler(httpRequest(requestBody("mbr_03HX9MORGAN")));
    const guessed = await handler(httpRequest(requestBody("mbr_guessed")));
    const wrongGrant = harness({ authorizationId: "grant:wrong", authorize: () => false }).handler;
    const wrong = await wrongGrant(httpRequest(requestBody()));

    const claims: CopilotContinuationClaims = {
      schemaVersion: "copilot-continuation-claims/v1",
      coachId: COACH_ID,
      memberId: JORDAN_ID,
      contextRevisionId: first.contextRevisionId,
      answerId: "answer:foreign-evidence",
      intentId: "morning-brief",
      selectedEvidenceIds: ["assertion:foreign"],
      issuedAt: NOW,
      expiresAt: new Date(Date.parse(NOW) + 15 * 60 * 1_000).toISOString(),
    };
    const foreign = await handler(httpRequest({ ...requestBody(), continuation: await continuation.sign(claims) }));
    const payloads = await Promise.all([avery, morgan, guessed, wrong, foreign].map((response) => response.json()));

    expect(payloads.map((payload) => payload.status)).toEqual(["empty", "empty", "denied", "denied", "stale"]);
    for (const payload of payloads) {
      expect(JSON.stringify(payload)).not.toContain(first.contextRevisionId);
      expect(JSON.stringify(payload)).not.toContain("assertion:foreign");
      expect(JSON.stringify(payload)).not.toMatch(/activeRevisionId|requestedRevisionId|authorizationId|coachId/);
    }
  });
});
