import { describe, expect, it } from "vitest";

import exercises from "../../data/exercises.json";
import averyMemberContext from "../../data/member-context-avery.json";
import memberContext from "../../data/member-context.json";
import morganMemberContext from "../../data/member-context-morgan.json";
import {
  buildCoachWorkspace,
  buildDashboardFixture,
  buildTodayProjection,
  fixtureDashboardAdapter,
  sessionDateKey,
} from "../../src/features/coach-dashboard/fixture-adapter";

describe("dashboard fixture adapter", () => {
  it("derives the flagship member summary from canonical fixture data", () => {
    const fixture = buildDashboardFixture(memberContext, exercises);

    expect(fixture.member).toMatchObject({
      name: "Jordan Rivera",
      initials: "JR",
      tier: "1:1 Coaching",
      trainingDaysPerWeek: 4,
    });
    expect(fixture.metrics).toEqual({ adherence: "50%", sleep: "6.3h", restingHeartRate: "58" });
    expect(fixture.morningBrief.celebration).toContain("pain-free squat");
    expect(fixture.history[0]).toMatchObject({ title: "Lower Body - Bands & DB", completed: true });
  });

  it("resolves all catalog-backed workout and exclusion records through one adapter", () => {
    const fixture = buildDashboardFixture(memberContext, exercises);
    const catalogNames = new Set(exercises.map((exercise) => exercise.name));
    const catalogBacked = [...fixture.workoutSections.flatMap((section) => section.items), ...fixture.exclusions]
      .filter((item) => item.catalogId);

    expect(catalogBacked.length).toBeGreaterThan(0);
    expect(catalogBacked.every((item) => catalogNames.has(item.catalogName))).toBe(true);
    expect(fixture.exclusions.find((item) => item.id === "split-squat")).toMatchObject({
      catalogName: "Dumbbell Goblet Split Squat",
      overridable: true,
    });
    expect(fixture.exclusions.every((item) => fixture.decisionPaths[item.decisionId])).toBe(true);
  });

  it("derives adapter-owned member and date copy for a different member", () => {
    const alternate = structuredClone(memberContext);
    alternate.profile.name = "Avery Chen";
    alternate.coach_brief.generated_for = "2026-07-08";
    alternate.chat_history[0].ts = "2026-07-07T18:42:00-07:00";

    const fixture = buildDashboardFixture(alternate, exercises);

    expect(fixture.member).toMatchObject({ name: "Avery Chen", initials: "AC" });
    expect(fixture.asOfDate).toEqual({ weekday: "WED", monthDay: "JUL 8" });
    expect(fixture.morningBrief.memberMessageDate).toBe("Jul 7");
  });

  it("implements the async load-state contract without enabling external draft creation", async () => {
    expect(fixtureDashboardAdapter.initialState.status).toBe("ready");
    await expect(fixtureDashboardAdapter.load()).resolves.toMatchObject({
      status: "ready",
      data: expect.objectContaining({ member: expect.objectContaining({ name: "Jordan Rivera" }) }),
    });
    expect(fixtureDashboardAdapter.capabilities.startNewDraft).toEqual({
      available: false,
      reason: "New drafts require a connected coaching service.",
    });
  });

  it("keeps fixture full graphs complete, scoped, and visibly fixture-authoritative", async () => {
    const capability = fixtureDashboardAdapter.capabilities.fullGraph;
    if (!capability || !capability.available) throw new Error("Expected fixture full graph capability");

    const movement = await capability.client.read({ domain: "movement-clinical" });
    expect(movement).toMatchObject({ status: "ready", data: { domain: "movement-clinical", authority: "fixture" } });
    if (movement.status !== "ready") throw new Error("Expected movement fixture graph");
    expect(movement.data.nodes).toHaveLength(movement.data.counts.nodes);
    expect(movement.data.relationships).toHaveLength(movement.data.counts.relationships);

    const memberIds = fixtureDashboardAdapter.initialState.status === "ready"
      ? fixtureDashboardAdapter.initialState.data.workspace.athletes.map((athlete) => athlete.id)
      : [];
    expect(memberIds).toHaveLength(3);
    for (const memberId of memberIds) {
      expect(capability.supports({ domain: "member-context", memberId })).toBe(true);
      const member = await capability.client.read({ domain: "member-context", memberId });
      expect(member).toMatchObject({ status: "ready", data: { domain: "member-context", memberId, authority: "fixture" } });
      if (member.status !== "ready") throw new Error("Expected member fixture graph");
      expect(member.data.nodes).toHaveLength(member.data.counts.nodes);
      expect(member.data.relationships).toHaveLength(member.data.counts.relationships);
      expect(member.data.nodes.find((node) => node.kind === "member")?.provenance.directAssertion).toBe("none");
      expect(member.data.nodes.find((node) => node.kind === "member-profile")?.provenance.source?.artifactDigest).toMatch(/^sha256:/);
    }
    expect(capability.supports({ domain: "member-context", memberId: "member:unknown" })).toBe(false);
  });

  it("composes the full caseload independently from upcoming sessions", () => {
    const jordan = buildDashboardFixture(memberContext, exercises);
    const noSessionMember = structuredClone(memberContext);
    noSessionMember.profile.id = "mbr_no_session";
    noSessionMember.profile.name = "Morgan Lee";
    const morgan = buildDashboardFixture(noSessionMember, exercises);

    const workspace = buildCoachWorkspace([jordan, morgan], [
      {
        id: "session-jordan-late",
        athleteId: jordan.member.id,
        startsAt: "2026-07-08T10:00:00-05:00",
        label: "Strength review",
        durationMinutes: 50,
        status: "upcoming",
      },
    ]);

    expect(workspace.athletes.map((athlete) => athlete.name)).toEqual(["Jordan Rivera", "Morgan Lee"]);
    expect(workspace.athletes.find((athlete) => athlete.name === "Morgan Lee")).toMatchObject({
      nextSessionId: null,
      nextSessionLabel: null,
      suggestedWorkoutTitle: "knee-safe strength",
    });
  });

  it("derives every athlete workout preview from the existing member projection", () => {
    const jordan = buildDashboardFixture(memberContext, exercises);
    const alternate = structuredClone(memberContext);
    alternate.profile.id = "mbr_alternate";
    alternate.injuries[0].joint = "Shoulder";
    const avery = buildDashboardFixture(alternate, exercises);

    const workspace = buildCoachWorkspace([jordan, avery], []);

    expect(workspace.athletes.map(({ suggestedWorkoutTitle }) => suggestedWorkoutTitle)).toEqual([
      "knee-safe strength",
      "Shoulder-safe strength",
    ]);
  });

  it("keeps each athlete's workout and explanation grounded in their own context", () => {
    const avery = buildDashboardFixture(averyMemberContext, exercises);
    const renderedEvidence = JSON.stringify({
      workout: avery.workoutSections,
      exclusions: avery.exclusions,
      paths: avery.decisionPaths,
      copilot: avery.copilotCards,
    });

    expect(avery.workoutTitle).toBe("shoulder-safe strength");
    expect(renderedEvidence).toContain("shoulder");
    expect(renderedEvidence).not.toContain("Jordan");
    expect(renderedEvidence).not.toContain("patellofemoral");
  });

  it("does not expose another athlete's identity through Morgan's brief", () => {
    const ready = fixtureDashboardAdapter.initialState;
    if (ready.status !== "ready") throw new Error("Expected the fixture adapter to be ready");
    const morgan = ready.data.workspace.memberViews.mbr_03HX9MORGAN;
    const renderedContext = JSON.stringify(morgan);

    expect(morgan.member.name).toBe("Morgan Lee");
    expect(renderedContext).not.toContain("Avery");
    expect(renderedContext).not.toContain("Jordan");
    expect(morganMemberContext.biomarkers).not.toEqual(averyMemberContext.biomarkers);
    expect(morganMemberContext.adherence).not.toEqual(averyMemberContext.adherence);
    expect(morganMemberContext.equipment_available).not.toEqual(averyMemberContext.equipment_available);
    expect(morganMemberContext.labs).not.toEqual(averyMemberContext.labs);
  });

  it("deduplicates the selected-day athlete row while preserving every agenda session", () => {
    const jordan = buildDashboardFixture(memberContext, exercises);
    const workspace = buildCoachWorkspace([jordan], [
      {
        id: "session-first",
        athleteId: jordan.member.id,
        startsAt: "2026-07-08T08:30:00-05:00",
        label: "Morning review",
        durationMinutes: 45,
        status: "upcoming",
      },
      {
        id: "session-second",
        athleteId: jordan.member.id,
        startsAt: "2026-07-08T14:00:00-05:00",
        label: "Technique follow-up",
        durationMinutes: 20,
        status: "upcoming",
      },
    ]);

    const projection = buildTodayProjection(workspace, "2026-07-08");

    expect(projection.scheduledAthletes.map((item) => item.athlete.id)).toEqual([jordan.member.id]);
    expect(projection.scheduledAthletes[0].firstSession.id).toBe("session-first");
    expect(projection.sessions.map((session) => session.id)).toEqual(["session-first", "session-second"]);
  });

  it("groups source instants by the coach-local calendar date", () => {
    expect(sessionDateKey("2026-07-08T00:30:00+02:00", "America/Chicago")).toBe("2026-07-07");
    expect(sessionDateKey("2026-07-08T00:30:00-05:00", "America/Chicago")).toBe("2026-07-08");
  });

  it("sorts session records chronologically and preserves their athlete links", () => {
    const jordan = buildDashboardFixture(memberContext, exercises);
    const sessions = [
      {
        id: "session-later",
        athleteId: jordan.member.id,
        startsAt: "2026-07-08T11:00:00-05:00",
        label: "Later review",
        durationMinutes: 30,
        status: "upcoming" as const,
      },
      {
        id: "session-earlier",
        athleteId: jordan.member.id,
        startsAt: "2026-07-08T08:30:00-05:00",
        label: "Earlier review",
        durationMinutes: 45,
        status: "upcoming" as const,
      },
    ];

    const workspace = buildCoachWorkspace([jordan], sessions);

    expect(workspace.sessions.map((session) => session.id)).toEqual(["session-earlier", "session-later"]);
    expect(workspace.athletes[0]).toMatchObject({
      nextSessionId: "session-earlier",
      nextSessionLabel: "Jul 8 · Earlier review",
    });
  });

  it("sorts sessions by their instant when source offsets differ", () => {
    const jordan = buildDashboardFixture(memberContext, exercises);
    const workspace = buildCoachWorkspace([jordan], [
      {
        id: "session-later-instant",
        athleteId: jordan.member.id,
        startsAt: "2026-07-08T09:00:00-07:00",
        label: "Later instant",
        durationMinutes: 30,
        status: "upcoming",
      },
      {
        id: "session-earlier-instant",
        athleteId: jordan.member.id,
        startsAt: "2026-07-08T08:30:00-05:00",
        label: "Earlier instant",
        durationMinutes: 30,
        status: "upcoming",
      },
    ]);

    expect(workspace.sessions.map((session) => session.id)).toEqual([
      "session-earlier-instant",
      "session-later-instant",
    ]);
  });

  it("keeps the caseload available when the agenda is empty", () => {
    const jordan = buildDashboardFixture(memberContext, exercises);
    const workspace = buildCoachWorkspace([jordan], []);

    expect(workspace.sessions).toEqual([]);
    expect(workspace.athletes).toHaveLength(1);
    expect(workspace.athletes[0].nextSessionId).toBeNull();
  });

  it("rejects sessions that cannot be linked to a workspace athlete", () => {
    const jordan = buildDashboardFixture(memberContext, exercises);

    expect(() => buildCoachWorkspace([jordan], [{
      id: "session-orphaned",
      athleteId: "mbr_unknown",
      startsAt: "2026-07-08T08:30:00-05:00",
      label: "Unknown athlete review",
      durationMinutes: 30,
      status: "upcoming",
    }])).toThrow("Session session-orphaned references unknown athlete mbr_unknown.");
  });

  it("keeps the ready adapter and member projection compatible with the existing workflow", () => {
    expect(fixtureDashboardAdapter.initialState).toMatchObject({
      status: "ready",
      data: {
        member: { name: "Jordan Rivera" },
        workspace: {
          athletes: expect.arrayContaining([
            expect.objectContaining({ name: "Jordan Rivera" }),
            expect.objectContaining({ name: "Avery Chen" }),
            expect.objectContaining({ nextSessionId: null }),
          ]),
        },
      },
    });
    expect(fixtureDashboardAdapter.capabilities.startNewDraft.available).toBe(false);
  });
});
