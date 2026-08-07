import { describe, expect, it } from "vitest";
import jordan from "../../data/member-context.json";
import { createRetrieveMemberContext } from "../../src/application/use-cases/retrieve-member-context";
import { createRetrieveMemberConversation } from "../../src/application/use-cases/retrieve-member-conversation";
import {
  createCopilotSupportingContextReference,
  createSignedCopilotContinuation,
} from "../../src/domain/contracts/copilot";
import { compileMemberContextGraph } from "../../src/graph/ingest/member-context";
import { InMemoryMemberContextPublisher } from "../../src/graph/publication/in-memory-member-context-publisher";
import { canonicalMemberContextDigest } from "../../src/graph/revisions/member-context";
import { InMemoryMemberContextReadProvider } from "../../src/graph/repositories/member-context";
import { SYNTHETIC_MEMBER_ASSET_ALLOWLIST } from "../../src/server/member-context-assets";

async function setup() {
  const snapshot = compileMemberContextGraph(jordan);
  const publisher = new InMemoryMemberContextPublisher();
  const staged = await publisher.stage({ snapshot, canonicalDigest: canonicalMemberContextDigest(snapshot), nodeCount: snapshot.nodes.length, relationshipCount: snapshot.relationships.length });
  if (staged.status !== "ok") throw new Error("stage failed");
  const validated = await publisher.validate({ publicationAttemptId: staged.data.publicationAttemptId });
  if (validated.status !== "ok") throw new Error("validate failed");
  const activated = await publisher.activate({ memberId: snapshot.memberId, contextRevisionId: snapshot.contextRevisionId, expectedPriorRevisionId: null, actorId: "test" });
  if (activated.status !== "ok") throw new Error("activate failed");
  const provider = new InMemoryMemberContextReadProvider(publisher, { authority: "canonical" });
  const retrieveMemberContext = createRetrieveMemberContext({
    memberContext: provider,
    authorizeMemberContext: async (input) => input.authorizationId === "session:jordan" && input.memberId === jordan.profile.id,
  });
  return { snapshot, retrieveMemberContext };
}

describe("revision-pinned member conversation", () => {
  it("projects exact messages and maps only allowlisted synthetic media", async () => {
    const { snapshot, retrieveMemberContext } = await setup();
    const retrieve = createRetrieveMemberConversation({ retrieveMemberContext, assetAllowlist: SYNTHETIC_MEMBER_ASSET_ALLOWLIST });
    const result = await retrieve({
      coachId: jordan.profile.coach_id,
      memberId: jordan.profile.id,
      sessionAuthorizationId: "session:jordan",
      contextRevisionId: snapshot.contextRevisionId,
      fromInclusive: "2026-05-01T00:00:00.000Z",
      toExclusive: "2026-07-01T00:00:00.000Z",
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const message = result.timeline.messages.find((item) => item.text.includes("no barbell"));
    expect(message).toBeDefined();
    expect(message?.senderRole).toBe("member");
    expect(message?.attachments[0]).toMatchObject({
      caption: "Home setup photo (synthetic placeholder)",
      asset: { status: "available", path: "/synthetic/jordan-home-equipment.svg" },
    });
    expect(JSON.stringify(result.timeline)).not.toMatch(/http|file:|sourceLocator|assetUrl/i);
    expect(result.timeline).toMatchObject({
      memberId: jordan.profile.id,
      contextRevisionId: snapshot.contextRevisionId,
      authority: "canonical",
      memberTimezone: jordan.profile.timezone,
      window: { fromInclusive: "2026-05-01T00:00:00.000Z", toExclusive: "2026-07-01T00:00:00.000Z" },
    });
  });

  it("binds a cited conversation anchor to the signed answer scope and allowlisted asset metadata", async () => {
    const { snapshot, retrieveMemberContext } = await setup();
    const retrieve = createRetrieveMemberConversation({ retrieveMemberContext, assetAllowlist: SYNTHETIC_MEMBER_ASSET_ALLOWLIST });
    const baseline = await retrieve({
      coachId: jordan.profile.coach_id,
      memberId: jordan.profile.id,
      sessionAuthorizationId: "session:jordan",
      contextRevisionId: snapshot.contextRevisionId,
      fromInclusive: "2026-05-01T00:00:00.000Z",
      toExclusive: "2026-07-01T00:00:00.000Z",
    });
    if (baseline.status !== "ready") throw new Error("Expected a baseline conversation timeline");
    const anchoredMessage = baseline.timeline.messages.find((message) => message.attachments.length > 0);
    const anchorEvidenceId = anchoredMessage?.attachments[0]?.evidenceId;
    if (!anchorEvidenceId) throw new Error("Expected a synthetic media attachment anchor");
    const answerId = "answer:context";
    const continuation = createSignedCopilotContinuation({
      claims: {
        schemaVersion: "copilot-continuation-claims/v1",
        coachId: jordan.profile.coach_id,
        memberId: jordan.profile.id,
        contextRevisionId: snapshot.contextRevisionId,
        answerId,
        intentId: "churn-risk",
        selectedEvidenceIds: [anchorEvidenceId],
        issuedAt: "2026-08-07T10:00:00.000Z",
        expiresAt: "2026-08-07T10:15:00.000Z",
      },
      signature: "test-signature",
    });
    const supportingContext = createCopilotSupportingContextReference({
      schemaVersion: "copilot-supporting-context/v1",
      memberId: jordan.profile.id,
      contextRevisionId: snapshot.contextRevisionId,
      authority: "canonical",
      answerId,
      anchor: { kind: "conversation", evidenceId: anchorEvidenceId },
      evidenceAsOf: baseline.timeline.evidenceAsOf,
      memberTimezone: baseline.timeline.memberTimezone,
      window: baseline.timeline.window,
      continuation,
    });

    const result = await retrieve({
      coachId: jordan.profile.coach_id,
      memberId: jordan.profile.id,
      sessionAuthorizationId: "session:jordan",
      contextRevisionId: snapshot.contextRevisionId,
      fromInclusive: supportingContext.window.fromInclusive,
      toExclusive: supportingContext.window.toExclusive,
      supportingContext,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.timeline).toMatchObject({
      memberId: jordan.profile.id,
      contextRevisionId: snapshot.contextRevisionId,
      authority: "canonical",
      anchorEvidenceId,
      evidenceAsOf: baseline.timeline.evidenceAsOf,
      memberTimezone: baseline.timeline.memberTimezone,
    });
    expect(result.timeline.messages.flatMap((message) => message.attachments).find((attachment) => attachment.evidenceId === anchorEvidenceId)?.asset).toEqual({
      status: "available",
      path: "/synthetic/jordan-home-equipment.svg",
    });
    expect(JSON.stringify(result.timeline)).not.toMatch(/https?:|file:|assetUrl|sourceLocator/i);

    await expect(retrieve({
      coachId: jordan.profile.coach_id,
      memberId: jordan.profile.id,
      sessionAuthorizationId: "session:jordan",
      contextRevisionId: snapshot.contextRevisionId,
      fromInclusive: "2026-05-02T00:00:00.000Z",
      toExclusive: supportingContext.window.toExclusive,
      supportingContext,
    })).resolves.toMatchObject({ status: "invalid" });
  });

  it("fails closed for a foreign member without disclosing revision state", async () => {
    const { retrieveMemberContext } = await setup();
    const retrieve = createRetrieveMemberConversation({ retrieveMemberContext, assetAllowlist: SYNTHETIC_MEMBER_ASSET_ALLOWLIST });
    await expect(retrieve({
      coachId: jordan.profile.coach_id,
      memberId: jordan.profile.id,
      sessionAuthorizationId: "session:foreign",
      fromInclusive: "2026-05-01T00:00:00.000Z",
      toExclusive: "2026-07-01T00:00:00.000Z",
    })).resolves.toMatchObject({ status: "denied" });
  });
});
