import { describe, expect, it } from "vitest";
import jordan from "../../data/member-context.json";
import { compileMemberContextGraph } from "../../src/graph/ingest/member-context";
import { InMemoryMemberContextPublisher } from "../../src/graph/publication/in-memory-member-context-publisher";
import { canonicalMemberContextDigest } from "../../src/graph/revisions/member-context";
import { InMemoryMemberContextGraphRepository } from "../../src/graph/repositories/member-context";
import { buildMemberContextFixture } from "../fixtures/member-context-builder";

async function publish(publisher: InMemoryMemberContextPublisher, snapshot = compileMemberContextGraph(jordan)) {
  const canonicalDigest = canonicalMemberContextDigest(snapshot);
  const staged = await publisher.stage({ snapshot, canonicalDigest, nodeCount: snapshot.nodes.length, relationshipCount: snapshot.relationships.length });
  if (staged.status !== "ok") throw new Error(staged.failure.code);
  const validated = await publisher.validate({ publicationAttemptId: staged.data.publicationAttemptId });
  if (validated.status !== "ok") throw new Error(validated.failure.code);
  return { snapshot, staged, validated };
}

describe("in-memory member context publication and repository contract", () => {
  it("stages, validates, seals, CAS activates, and retains history", async () => {
    const publisher = new InMemoryMemberContextPublisher();
    const first = await publish(publisher);
    const activated = await publisher.activate({
      memberId: first.snapshot.memberId,
      contextRevisionId: first.snapshot.contextRevisionId,
      expectedPriorRevisionId: null,
      actorId: "seed:test",
    });
    expect(activated).toMatchObject({ status: "ok", data: { state: "activated", priorRevisionId: null } });

    const repeat = await publisher.stage({
      snapshot: first.snapshot,
      canonicalDigest: canonicalMemberContextDigest(first.snapshot),
      nodeCount: first.snapshot.nodes.length,
      relationshipCount: first.snapshot.relationships.length,
    });
    expect(repeat).toMatchObject({ status: "ok", data: { state: "already-staged" } });

    const secondSnapshot = compileMemberContextGraph(buildMemberContextFixture((document) => { document.biomarkers.hrv_ms += 1; }));
    await publish(publisher, secondSnapshot);
    expect(await publisher.activate({
      memberId: secondSnapshot.memberId,
      contextRevisionId: secondSnapshot.contextRevisionId,
      expectedPriorRevisionId: "member-context:sha256:stale",
      actorId: "seed:test",
    })).toMatchObject({ status: "failed", failure: { code: "stale_revision" } });
    expect((await publisher.inspect(first.snapshot.memberId)).status).toBe("ok");

    expect(await publisher.activate({
      memberId: secondSnapshot.memberId,
      contextRevisionId: secondSnapshot.contextRevisionId,
      expectedPriorRevisionId: first.snapshot.contextRevisionId,
      actorId: "seed:test",
    })).toMatchObject({ status: "ok", data: { state: "activated", priorRevisionId: first.snapshot.contextRevisionId } });
    expect(publisher.getRevision(first.snapshot.memberId, first.snapshot.contextRevisionId)).toBe(first.snapshot);
  });

  it("rejects immutable payload conflicts and activation before sealing", async () => {
    const publisher = new InMemoryMemberContextPublisher();
    const snapshot = compileMemberContextGraph(jordan);
    const digest = canonicalMemberContextDigest(snapshot);
    await publisher.stage({ snapshot, canonicalDigest: digest, nodeCount: snapshot.nodes.length, relationshipCount: snapshot.relationships.length });

    expect(await publisher.stage({
      snapshot: { ...snapshot, nodes: snapshot.nodes.slice(1) },
      canonicalDigest: digest,
      nodeCount: snapshot.nodes.length - 1,
      relationshipCount: snapshot.relationships.length,
    })).toMatchObject({ status: "failed", failure: { code: "immutable_payload_conflict" } });
    expect(await publisher.activate({
      memberId: snapshot.memberId,
      contextRevisionId: snapshot.contextRevisionId,
      expectedPriorRevisionId: null,
      actorId: "seed:test",
    })).toMatchObject({ status: "failed", failure: { code: "not_sealed" } });
  });

  it("returns typed denial and unavailable states from trusted authorization, never COACHES evidence", async () => {
    const publisher = new InMemoryMemberContextPublisher();
    const { snapshot } = await publish(publisher);
    await publisher.activate({ memberId: snapshot.memberId, contextRevisionId: snapshot.contextRevisionId, expectedPriorRevisionId: null, actorId: "seed:test" });
    const repository = new InMemoryMemberContextGraphRepository(publisher, {
      authorize: ({ authorizationId }) => authorizationId === "grant:jordan",
    });

    expect(repository.getActive({ coachId: jordan.profile.coach_id, memberId: jordan.profile.id, authorizationId: "grant:jordan" }).status).toBe("ready");
    expect(repository.getActive({ coachId: jordan.profile.coach_id, memberId: jordan.profile.id, authorizationId: "revoked" }).status).toBe("denied");
    repository.setAvailable(false);
    expect(repository.getActive({ coachId: jordan.profile.coach_id, memberId: jordan.profile.id, authorizationId: "grant:jordan" }).status).toBe("unavailable");
  });
});
