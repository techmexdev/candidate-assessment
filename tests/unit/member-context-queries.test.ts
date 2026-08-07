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

async function setup(snapshot = compileMemberContextGraph(jordan)) {
  const publisher = new InMemoryMemberContextPublisher();
  await publish(publisher, snapshot);
  const provider = new InMemoryMemberContextReadProvider(publisher, { authority: "canonical" });
  const retrieve = createRetrieveMemberContext({
    memberContext: provider,
    authorizeMemberContext: async (request) => request.authorizationId === "grant:jordan"
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
  it("returns complete workout constraint source truth at one pinned revision", async () => {
    const { handle, snapshot } = await setup();
    const result = await handle.getWorkoutConstraints({ limit: 10, timeoutMs: 100 });

    expect(result).toMatchObject({
      status: "ready",
      memberId: jordan.profile.id,
      contextRevisionId: snapshot.contextRevisionId,
      authority: "canonical",
      data: {
        equipment: [
          { originalLabel: "Dumbbell", available: true, domainReference: { state: "reviewed", stableConceptId: "equipment:dumbbell" } },
          { originalLabel: "Flat Bench", available: true, domainReference: { state: "reviewed", stableConceptId: "equipment:flat-bench" } },
          { originalLabel: "Kettlebell", available: true, domainReference: { state: "reviewed", stableConceptId: "equipment:kettlebell" } },
          { originalLabel: "Resistance Band - Loop", available: true, domainReference: { state: "reviewed", stableConceptId: "equipment:resistance-band-loop" } },
          { originalLabel: "Yoga Mat", available: true, domainReference: { state: "reviewed", stableConceptId: "equipment:yoga-mat" } },
        ],
        injuries: [expect.objectContaining({
          region: "left knee",
          joint: "knee",
          status: "recovering",
          severity: "mild",
          domainReferences: expect.arrayContaining([
            expect.objectContaining({ state: "reviewed", stableConceptId: "joint:knee" }),
            expect.objectContaining({ state: "reviewed", stableConceptId: "condition:patellofemoral-pain-syndrome" }),
          ]),
        })],
        preferences: [expect.objectContaining({
          dislikes: ["Deadlift", "Burpees"],
          domainReferences: [
            { state: "unresolved", originalText: "Deadlift", reason: "not-reviewed" },
            { state: "unresolved", originalText: "Burpees", reason: "not-reviewed" },
          ],
        })],
      },
    });
    if (result.status !== "ready") throw new Error(result.status);
    expect(result.evidenceIds).toEqual([
      ...result.data.equipment.map((fact) => fact.assertionId),
      ...result.data.injuries.map((fact) => fact.assertionId),
      ...result.data.preferences.map((fact) => fact.assertionId),
    ]);
    expect(result.data.equipment.every((fact) => fact.source.artifactDigest === snapshot.sourceArtifactDigest)).toBe(true);
  });

  it("fails closed on incomplete bounds without returning raw workout constraint values", async () => {
    const { handle } = await setup();
    const result = await handle.getWorkoutConstraints({ limit: 1, timeoutMs: 100 });

    expect(result).toMatchObject({ status: "invalid", code: "invalid-bound", evidenceIds: [] });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(jordan.injuries[0]!.notes);
    expect(serialized).not.toContain(jordan.preferences.notes);
    expect(serialized).not.toContain(jordan.preferences.dislikes[0]!);
  });

  it("preserves unresolved equipment and raw injury applicability without manufacturing authority", async () => {
    const snapshot = compileMemberContextGraph(buildMemberContextFixture((document) => {
      document.equipment_available.push("Mystery Rig");
    }));
    const { handle } = await setup(snapshot);
    const result = await handle.getWorkoutConstraints({ limit: 20, timeoutMs: 100 });

    if (result.status !== "ready") throw new Error(result.status);
    expect(result.data.equipment).toContainEqual(expect.objectContaining({
      originalLabel: "Mystery Rig",
      available: true,
      domainReference: { state: "unresolved", originalText: "Mystery Rig", reason: "not-reviewed" },
    }));
    const unresolved = result.data.equipment.find((fact) => fact.originalLabel === "Mystery Rig")?.domainReference;
    expect(unresolved).not.toHaveProperty("stableConceptId");
    expect(result.data.injuries[0]).toMatchObject({ status: "recovering", severity: "mild" });
    expect(result.data.injuries[0]).not.toHaveProperty("clinicalEffect");
    expect(result.data.injuries[0]).not.toHaveProperty("applicableRuleId");
  });

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

    const oneFactSummary = await handle.getSummary({ limit: 1, timeoutMs: 100 });
    expect(oneFactSummary).toMatchObject({
      status: "ready",
      data: {
        profileAssertionId: summary.data.profileAssertionId,
        goalAssertionIds: [],
        riskAssessmentAssertionId: null,
      },
      evidenceIds: [summary.data.profileAssertionId],
    });

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

  it("exposes only bounded Copilot source values with their original provenance", async () => {
    const { handle, snapshot } = await setup();
    const result = await handle.getEvidence({
      domains: ["profile", "goals", "preferences", "workouts", "coach-brief", "churn"],
      limit: 30,
      timeoutMs: 100,
    });
    if (result.status !== "ready") throw new Error(result.status);

    expect(result.authoritativeEvidenceAnchor?.temporal).toEqual({
      precision: "date",
      effectiveOn: jordan.coach_brief.generated_for,
    });
    expect(snapshot.nodes.some((node) => "assertionId" in node
      && node.assertionId === result.authoritativeEvidenceAnchor?.evidenceId
      && node.temporal.precision === "date"
      && node.temporal.effectiveOn === jordan.coach_brief.generated_for)).toBe(true);

    expect(result.data.find((fact) => fact.kind === "member-profile")).toEqual(expect.objectContaining({
      timezone: jordan.profile.timezone,
      source: expect.objectContaining({ artifactDigest: snapshot.sourceArtifactDigest }),
    }));
    expect(result.data.filter((fact) => fact.kind === "goal")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        text: jordan.goals[0].text,
        priority: jordan.goals[0].priority,
        targetDate: jordan.goals[0].target_date,
      }),
    ]));
    expect(result.data.find((fact) => fact.kind === "preference")).toEqual(expect.objectContaining({
      preferredSessionMinutes: jordan.preferences.preferred_session_minutes,
      trainingDaysPerWeek: jordan.preferences.training_days_per_week,
      preferredDays: jordan.preferences.preferred_days,
      dislikes: jordan.preferences.dislikes,
      notes: jordan.preferences.notes,
    }));
    expect(result.data.filter((fact) => fact.kind === "workout-session")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: jordan.workout_history[0].title,
        planned: jordan.workout_history[0].planned,
        completed: jordan.workout_history[0].completed,
        durationMinutes: jordan.workout_history[0].duration_min,
        rpe: jordan.workout_history[0].rpe,
      }),
    ]));
    expect(result.data.find((fact) => fact.kind === "coach-brief")).toEqual(expect.objectContaining({
      generatedFor: jordan.coach_brief.generated_for,
    }));
    expect(result.data.filter((fact) => fact.kind === "coach-task")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskType: jordan.coach_brief.morning_tasks[0].type,
        text: jordan.coach_brief.morning_tasks[0].text,
        sourceOrder: 0,
      }),
    ]));
    expect(result.data.find((fact) => fact.kind === "churn-assessment")).toEqual(expect.objectContaining({
      level: jordan.coach_brief.churn_risk.level,
    }));
    expect(result.data.filter((fact) => fact.kind === "churn-reason")).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: jordan.coach_brief.churn_risk.reasons[0], basisStatus: "supported" }),
      expect.objectContaining({ text: jordan.coach_brief.churn_risk.reasons[2], basisStatus: "unsupported-source" }),
    ]));

    const profile = result.data.find((fact) => fact.kind === "member-profile");
    expect(profile).not.toHaveProperty("name");
    expect(profile).not.toHaveProperty("weightKg");
    expect(result.evidenceIds).toEqual(result.data.map((fact) => fact.evidenceId));
  });

  it("reserves bounded evidence capacity for every requested kind independent of query order", async () => {
    const { handle } = await setup();
    const forward = await handle.getEvidence({
      domains: ["workouts", "preferences"],
      evidenceKinds: ["workout-session", "preference"],
      limit: 2,
      timeoutMs: 100,
    });
    const reversed = await handle.getEvidence({
      domains: ["preferences", "workouts"],
      evidenceKinds: ["preference", "workout-session"],
      limit: 2,
      timeoutMs: 100,
    });

    if (forward.status !== "ready" || reversed.status !== "ready") throw new Error("expected bounded evidence");
    expect(forward.data).toHaveLength(2);
    expect(new Set(forward.data.map((fact) => fact.kind))).toEqual(new Set(["workout-session", "preference"]));
    expect(forward.data.map((fact) => fact.evidenceId)).toEqual(reversed.data.map((fact) => fact.evidenceId));
    expect(forward.nextCursor).toBeDefined();
    expect(forward.nextCursor).toBe(reversed.nextCursor);
    const next = await handle.getEvidence({
      domains: ["preferences", "workouts"],
      evidenceKinds: ["preference", "workout-session"],
      limit: 2,
      timeoutMs: 100,
      cursor: forward.nextCursor,
    });
    if (next.status !== "ready") throw new Error("expected stable cursor");
    expect(next.data).toHaveLength(2);
    expect(next.data.every((fact) => ["workout-session", "preference"].includes(fact.kind))).toBe(true);
    const firstPageIds = new Set(forward.data.map((fact) => fact.evidenceId));
    expect(next.data.every((fact) => !firstPageIds.has(fact.evidenceId))).toBe(true);
    await expect(handle.getEvidence({
      domains: ["workouts", "preferences"],
      evidenceKinds: ["workout-session", "preference"],
      limit: 1,
      timeoutMs: 100,
    })).resolves.toMatchObject({ status: "invalid", code: "invalid-bound", evidenceIds: [] });
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

  it("retrieves relative-order sleep as an explicit bounded sequence without invented dates", async () => {
    const { handle } = await setup();
    if (!handle.getRelativeOrderSequence) throw new Error("relative sequence operation is unavailable");
    const sleep = await handle.getRelativeOrderSequence({
      metric: "sleep-hours",
      minimumPoints: 7,
      limit: 7,
      timeoutMs: 100,
    });
    expect(sleep).toMatchObject({ status: "ready", data: [
      { value: 6.1, unit: "hour", temporal: { precision: "relative-order", sourceOrder: 0 } },
      { value: 5.4, unit: "hour", temporal: { precision: "relative-order", sourceOrder: 1 } },
      { value: 7.2, unit: "hour", temporal: { precision: "relative-order", sourceOrder: 2 } },
      { value: 6.0, unit: "hour", temporal: { precision: "relative-order", sourceOrder: 3 } },
      { value: 5.1, unit: "hour", temporal: { precision: "relative-order", sourceOrder: 4 } },
      { value: 7.8, unit: "hour", temporal: { precision: "relative-order", sourceOrder: 5 } },
      { value: 6.3, unit: "hour", temporal: { precision: "relative-order", sourceOrder: 6 } },
    ] });
    if (sleep.status !== "ready") throw new Error(sleep.status);
    expect(sleep.data.every((point) => point.temporal.precision === "relative-order")).toBe(true);
    await expect(handle.getRelativeOrderSequence({
      metric: "sleep-hours",
      minimumPoints: 8,
      limit: 7,
      timeoutMs: 100,
    })).resolves.toMatchObject({ status: "invalid", code: "invalid-bound" });
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

  it("returns messages in exact timestamp chronology and metadata-only attachment citations", async () => {
    const { handle } = await setup();
    const conversation = await handle.getConversation({
      window: { fromInclusive: "2026-05-01", toExclusive: "2026-07-01" },
      limit: 10,
      timeoutMs: 100,
    });
    expect(conversation).toMatchObject({ status: "ready", data: { messages: [
      { senderRole: "member", text: jordan.chat_history[3].text, temporal: { effectiveAt: jordan.chat_history[3].ts } },
      { senderRole: "member", text: jordan.chat_history[2].text, temporal: { effectiveAt: jordan.chat_history[2].ts } },
      { senderRole: "member", text: jordan.chat_history[0].text, temporal: { effectiveAt: jordan.chat_history[0].ts } },
      { senderRole: "coach", text: jordan.chat_history[1].text, temporal: { effectiveAt: jordan.chat_history[1].ts } },
    ] } });
    if (conversation.status !== "ready") throw new Error(conversation.status);
    expect(conversation.data.messages[0].attachmentEvidenceIds).toHaveLength(1);
    expect(conversation.data.messages[0].attachments).toEqual([expect.objectContaining({
      evidenceId: conversation.data.messages[0].attachmentEvidenceIds[0],
      kind: "media-attachment",
      mediaType: "image",
      caption: "Home setup photo (synthetic placeholder)",
      sourceOrder: 0,
      assetStatus: "metadata-only",
      analysisStatus: "not-analyzed",
    })]);
    expect(conversation.data.messages[0].attachments[0]).not.toHaveProperty("assetUrl");
    const attachmentId = conversation.data.messages[0].attachmentEvidenceIds[0];
    const citation = await handle.getCitations({ evidenceIds: [attachmentId], limit: 2, timeoutMs: 100 });
    expect(citation).toMatchObject({ status: "ready", data: [{ classification: "source-statement" }] });
  });

  it("retrieves brief/churn relationships without promoting unsupported login evidence", async () => {
    const { handle } = await setup();
    const brief = await handle.getCoachBrief({ generatedFor: "2026-06-04", limit: 10, timeoutMs: 100 });
    expect(brief).toMatchObject({ status: "ready" });
    if (brief.status !== "ready") throw new Error(brief.status);
    expect(brief.data.taskEvidenceIds).toHaveLength(2);
    expect(brief.data).toMatchObject({
      brief: { generatedFor: jordan.coach_brief.generated_for },
      tasks: jordan.coach_brief.morning_tasks.map((task, sourceOrder) => ({
        taskType: task.type,
        text: task.text,
        sourceOrder,
      })),
      assessment: { level: jordan.coach_brief.churn_risk.level },
    });
    const oneFactBrief = await handle.getCoachBrief({ generatedFor: "2026-06-04", limit: 1, timeoutMs: 100 });
    expect(oneFactBrief).toMatchObject({
      status: "ready",
      data: {
        briefEvidenceId: brief.data.briefEvidenceId,
        taskEvidenceIds: [],
        assessmentEvidenceId: null,
      },
      evidenceIds: [brief.data.briefEvidenceId],
    });
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
      authorizeMemberContext: () => true,
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
      .resolves.toEqual({
        status: "stale",
        requestedRevisionId: "member-context:sha256:guessed",
        activeRevisionId: second.contextRevisionId,
      });

    const unsealed = compileMemberContextGraph(buildMemberContextFixture((document) => { document.biomarkers.hrv_ms += 2; }));
    const staged = await publisher.stage({
      snapshot: unsealed,
      canonicalDigest: canonicalMemberContextDigest(unsealed),
      nodeCount: unsealed.nodes.length,
      relationshipCount: unsealed.relationships.length,
    });
    if (staged.status !== "ok") throw new Error(staged.failure.code);
    await expect(retrieve({ ...access, contextRevisionId: unsealed.contextRevisionId }))
      .resolves.toEqual({
        status: "stale",
        requestedRevisionId: unsealed.contextRevisionId,
        activeRevisionId: second.contextRevisionId,
      });
  });
});
