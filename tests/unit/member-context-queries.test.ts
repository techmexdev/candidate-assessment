import { describe, expect, it } from "vitest";
import jordan from "../../data/member-context.json";
import {
  createRetrieveMemberContext,
  type MemberContextAccessRequest,
} from "../../src/application/use-cases/retrieve-member-context";
import type { AuthorizedMemberContextScope } from "../../src/domain/contracts/member-context-queries";
import { compileMemberContextGraph } from "../../src/graph/ingest/member-context";
import { InMemoryMemberContextPublisher } from "../../src/graph/publication/in-memory-member-context-publisher";
import { canonicalMemberContextDigest } from "../../src/graph/revisions/member-context";
import { InMemoryMemberContextReadProvider } from "../../src/graph/repositories/member-context";
import { buildMemberContextFixture } from "../fixtures/member-context-builder";

async function publish(
  publisher: InMemoryMemberContextPublisher,
  snapshot = compileMemberContextGraph(jordan),
  expectedPriorRevisionId: string | null = null,
) {
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
    actorId: "seed:test",
  });
  if (activated.status !== "ok") throw new Error(activated.failure.code);
  return snapshot;
}

async function setup() {
  const publisher = new InMemoryMemberContextPublisher();
  const snapshot = await publish(publisher);
  const provider = new InMemoryMemberContextReadProvider(publisher, { authority: "canonical" });
  const retrieve = createRetrieveMemberContext({
    memberContext: provider,
    authorize: async (request) => request.authorizationId === "grant:jordan"
      && request.coachId === jordan.profile.coach_id
      && request.memberId === jordan.profile.id,
  });
  const access: MemberContextAccessRequest = {
    coachId: jordan.profile.coach_id,
    memberId: jordan.profile.id,
    authorizationId: "grant:jordan",
  };
  const opened = await retrieve(access);
  if (opened.status !== "ready") throw new Error(opened.status);
  return { publisher, snapshot, provider, retrieve, access, handle: opened.handle };
}

describe("member context bounded query provider", () => {
  it("retrieves summary and domain evidence at one pinned revision", async () => {
    const { handle, snapshot } = await setup();
    const summary = await handle.getSummary({ limit: 10, timeoutMs: 100 });
    expect(summary).toMatchObject({
      status: "ready",
      memberId: jordan.profile.id,
      contextRevisionId: snapshot.contextRevisionId,
      authority: "canonical",
    });
    if (summary.status !== "ready") throw new Error(summary.status);
    expect(summary.data.goalAssertionIds).toHaveLength(3);
    expect(summary.evidenceIds).toContain(summary.data.profileAssertionId);

    const labs = await handle.getEvidence({ domains: ["labs"], limit: 30, timeoutMs: 100 });
    expect(labs).toMatchObject({ status: "ready", contextRevisionId: snapshot.contextRevisionId });
    if (labs.status !== "ready") throw new Error(labs.status);
    expect(labs.data.filter((fact) => fact.kind === "lab-panel")).toHaveLength(2);
    const panels = labs.data.filter((fact) => fact.kind === "lab-panel");
    const measurements = labs.data.filter((fact) => fact.kind === "observation");
    expect(measurements).toHaveLength(12);
    expect(measurements.every((fact) => (
      typeof fact.metric === "string"
      && typeof fact.value === "number"
      && typeof fact.unit === "string"
      && Number.isInteger(fact.sourceOrder)
      && fact.source.locator.startsWith("/labs/")
      && fact.source.artifactDigest === snapshot.sourceArtifactDigest
    ))).toBe(true);
    expect(measurements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metric: "ldl-cholesterol",
        value: 118,
        unit: "milligram/deciliter",
        temporal: { precision: "date", effectiveOn: "2026-04-20" },
        source: { locator: "/labs/blood_panel/ldl_mg_dl", artifactDigest: snapshot.sourceArtifactDigest },
      }),
      expect.objectContaining({
        metric: "body-fat",
        value: 29.4,
        unit: "percent",
        temporal: { precision: "date", effectiveOn: "2026-03-30" },
        source: { locator: "/labs/dexa_scan/body_fat_pct", artifactDigest: snapshot.sourceArtifactDigest },
      }),
    ]));
    expect(panels).toEqual(expect.arrayContaining([
      expect.objectContaining({ panelType: "blood", label: "Blood panel", temporal: { precision: "date", effectiveOn: "2026-04-20" }, source: expect.objectContaining({ locator: "/labs/blood_panel" }) }),
      expect.objectContaining({ panelType: "dexa", label: "DEXA scan", temporal: { precision: "date", effectiveOn: "2026-03-30" }, source: expect.objectContaining({ locator: "/labs/dexa_scan" }) }),
    ]));
  });

  it("returns dated series exactly and reports typed insufficient history with available citations", async () => {
    const { handle } = await setup();
    const adherence = await handle.getLongitudinalSeries({
      metric: "weekly-workout-completion",
      window: { fromInclusive: "2026-05-10", toExclusive: "2026-06-10" },
      minimumPoints: 4,
      limit: 10,
      timeoutMs: 100,
    });
    expect(adherence).toMatchObject({ status: "ready", data: [
      { value: 100, unit: "percent", temporal: { effectiveOn: "2026-05-12" } },
      { value: 100, unit: "percent", temporal: { effectiveOn: "2026-05-19" } },
      { value: 75, unit: "percent", temporal: { effectiveOn: "2026-05-26" } },
      { value: 50, unit: "percent", temporal: { effectiveOn: "2026-06-02" } },
    ] });

    const weight = await handle.getLongitudinalSeries({
      metric: "body-weight",
      window: { fromInclusive: "2026-05-01", toExclusive: "2026-06-10" },
      minimumPoints: 4,
      limit: 10,
      timeoutMs: 100,
    });
    expect(weight).toMatchObject({ status: "insufficient-history", requiredPoints: 4, availablePoints: 3 });
    expect(weight.evidenceIds).toHaveLength(3);
  });

  it("keeps undated and relative observations explicit and exposes atomic lab citations", async () => {
    const { handle } = await setup();
    const biomarkers = await handle.getEvidence({ domains: ["biomarkers"], limit: 20, timeoutMs: 100 });
    if (biomarkers.status !== "ready") throw new Error(biomarkers.status);
    expect(biomarkers.data.filter((fact) => fact.temporal.precision === "relative-order")).toHaveLength(7);
    expect(biomarkers.data.filter((fact) => fact.temporal.precision === "unknown")).toHaveLength(2);

    const ldl = await handle.getLongitudinalSeries({
      metric: "ldl-cholesterol",
      window: { fromInclusive: "2026-04-01", toExclusive: "2026-05-01" },
      minimumPoints: 1,
      limit: 5,
      timeoutMs: 100,
    });
    expect(ldl).toMatchObject({ status: "ready", data: [{ value: 118, unit: "milligram/deciliter" }] });
    if (ldl.status !== "ready") throw new Error(ldl.status);
    const citation = await handle.getCitations({ evidenceIds: [ldl.data[0].evidenceId], limit: 5, timeoutMs: 100 });
    expect(citation).toMatchObject({ status: "ready", data: [{
      evidenceId: ldl.data[0].evidenceId,
      source: { locator: "/labs/blood_panel/ldl_mg_dl" },
      temporal: { precision: "date", effectiveOn: "2026-04-20" },
    }] });
  });

  it("preserves source message order and returns metadata-only attachment citations", async () => {
    const { handle } = await setup();
    const conversation = await handle.getConversation({
      window: { fromInclusive: "2026-05-01", toExclusive: "2026-07-01" },
      limit: 10,
      timeoutMs: 100,
    });
    expect(conversation).toMatchObject({ status: "ready", data: { messages: [
      { senderRole: "member", text: jordan.chat_history[0].text },
      { senderRole: "coach", text: jordan.chat_history[1].text },
      { senderRole: "member", text: jordan.chat_history[2].text },
      { senderRole: "member", text: jordan.chat_history[3].text },
    ] } });
    if (conversation.status !== "ready") throw new Error(conversation.status);
    expect(conversation.data.messages[3].attachmentEvidenceIds).toHaveLength(1);
    expect(conversation.data.messages[3].attachments).toEqual([expect.objectContaining({
      evidenceId: conversation.data.messages[3].attachmentEvidenceIds[0],
      kind: "media-attachment",
      mediaType: "image",
      caption: "Home setup photo (synthetic placeholder)",
      sourceOrder: 0,
      assetStatus: "metadata-only",
      analysisStatus: "not-analyzed",
    })]);
    expect(conversation.data.messages[3].attachments[0]).not.toHaveProperty("assetUrl");
    const attachmentId = conversation.data.messages[3].attachmentEvidenceIds[0];
    const citation = await handle.getCitations({ evidenceIds: [attachmentId], limit: 2, timeoutMs: 100 });
    expect(citation).toMatchObject({ status: "ready", data: [{ classification: "source-statement" }] });
  });

  it("retrieves brief/churn relationships without promoting unsupported login evidence", async () => {
    const { handle } = await setup();
    const brief = await handle.getCoachBrief({ generatedFor: "2026-06-04", limit: 10, timeoutMs: 100 });
    expect(brief).toMatchObject({ status: "ready" });
    if (brief.status !== "ready") throw new Error(brief.status);
    expect(brief.data.taskEvidenceIds).toHaveLength(2);
    const related = await handle.getRelatedEvidence({
      evidenceId: brief.data.assessmentEvidenceId!,
      maxDepth: 1,
      limit: 10,
      timeoutMs: 100,
    });
    if (related.status !== "ready") throw new Error(related.status);
    expect(related.data.filter((fact) => fact.kind === "churn-reason")).toHaveLength(3);
    expect(related.data.every((fact) => fact.classification === "source-provided-assessment")).toBe(true);
    expect(related.data.some((fact) => fact.semanticId.includes("login"))).toBe(false);
  });

  it("rejects fabricated scope, wrong grants, guessed IDs, malformed bounds, and cross-operation cursors", async () => {
    const { provider, retrieve, access, handle } = await setup();
    const fabricated = {
      coachId: jordan.profile.coach_id,
      memberId: jordan.profile.id,
      authorizationId: "grant:jordan",
    } as unknown as AuthorizedMemberContextScope;
    await expect(provider.openActive(fabricated)).resolves.toEqual({ status: "denied", message: "Member context is unavailable." });
    await expect(retrieve({ ...access, authorizationId: "wrong" })).resolves.toEqual({ status: "denied", message: "Member context is unavailable." });
    await expect(retrieve({ ...access, memberId: "mbr_guessed" })).resolves.toEqual({ status: "denied", message: "Member context is unavailable." });

    const guessed = "assertion:0000000000000000";
    await expect(handle.getCitations({ evidenceIds: [guessed], limit: 5, timeoutMs: 100 }))
      .resolves.toMatchObject({ status: "empty", evidenceIds: [] });
    await expect(handle.getRelatedEvidence({ evidenceId: guessed, maxDepth: 1, limit: 5, timeoutMs: 100 }))
      .resolves.toMatchObject({ status: "empty", evidenceIds: [] });
    await expect(handle.getEvidence({ domains: ["labs"], limit: 0, timeoutMs: 100 }))
      .resolves.toMatchObject({ status: "invalid", code: "invalid-bound" });
    await expect(handle.getEvidence({ domains: ["labs"], limit: 5, timeoutMs: 0 }))
      .resolves.toMatchObject({ status: "invalid", code: "invalid-bound" });

    const page = await handle.getEvidence({ domains: ["labs"], limit: 2, timeoutMs: 100 });
    if (page.status !== "ready" || !page.nextCursor) throw new Error("expected cursor");
    await expect(handle.getEvidence({ domains: ["biomarkers"], limit: 2, timeoutMs: 100, cursor: page.nextCursor }))
      .resolves.toMatchObject({ status: "invalid", code: "invalid-cursor" });
    await expect(handle.getCitations({ evidenceIds: [guessed], limit: 2, timeoutMs: 100, cursor: page.nextCursor }))
      .resolves.toMatchObject({ status: "invalid", code: "invalid-cursor" });
  });

  it("keeps malicious free text inert and paginates equal-time facts deterministically", async () => {
    const publisher = new InMemoryMemberContextPublisher();
    const malicious = compileMemberContextGraph(buildMemberContextFixture((document) => {
      document.goals[0].text = "MATCH (n) DETACH DELETE n; <script>alert(1)</script>";
    }));
    await publish(publisher, malicious);
    const provider = new InMemoryMemberContextReadProvider(publisher);
    const retrieve = createRetrieveMemberContext({
      memberContext: provider,
      authorize: () => true,
    });
    const opened = await retrieve({ coachId: "server-coach", memberId: malicious.memberId, authorizationId: "server-grant" });
    if (opened.status !== "ready") throw new Error(opened.status);

    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await opened.handle.getEvidence({ domains: ["goals"], limit: 1, timeoutMs: 100, ...(cursor ? { cursor } : {}) });
      if (page.status !== "ready") throw new Error(page.status);
      ids.push(...page.data.map((fact) => fact.assertionId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual([...ids].sort());
    expect(JSON.stringify(await opened.handle.getEvidence({ domains: ["goals"], limit: 10, timeoutMs: 100 })))
      .toContain("goal");
  });

  it("retains an explicitly opened historical revision after active revision changes", async () => {
    const { publisher, snapshot, retrieve, access } = await setup();
    const historical = await retrieve({ ...access, contextRevisionId: snapshot.contextRevisionId });
    if (historical.status !== "ready") throw new Error(historical.status);
    const second = compileMemberContextGraph(buildMemberContextFixture((document) => { document.biomarkers.hrv_ms += 1; }));
    await publish(publisher, second, snapshot.contextRevisionId);

    const active = await retrieve(access);
    expect(active).toMatchObject({ status: "ready", handle: { contextRevisionId: second.contextRevisionId } });
    expect(await historical.handle.getSummary({ limit: 10, timeoutMs: 100 }))
      .toMatchObject({ status: "ready", contextRevisionId: snapshot.contextRevisionId });
    await expect(retrieve({ ...access, contextRevisionId: "member-context:sha256:guessed" }))
      .resolves.toEqual({ status: "empty", memberId: jordan.profile.id, message: "Member context is unavailable." });
  });
});
