import { describe, expect, it } from "vitest";

import {
  createCopilotSupportingContextReference,
  createSignedCopilotContinuation,
} from "../../src/domain/contracts/copilot";
import type { MemberConversationTimeline } from "../../src/application/use-cases/retrieve-member-conversation";
import {
  createInitialDashboardState,
  dashboardReducer,
  selectActiveAthleteState,
  selectCurrentVersion,
  type DashboardState,
} from "../../src/features/coach-dashboard/state";

const jordanState = () => dashboardReducer(
  createInitialDashboardState("2026-08-06"),
  { type: "select-athlete", memberId: "mbr_jordan" },
);

const athlete = (state: DashboardState) => {
  const result = selectActiveAthleteState(state);
  if (!result) throw new Error("Expected an active athlete workflow");
  return result;
};

const completeAdjustment = (state: DashboardState) => dashboardReducer(
  dashboardReducer(state, { type: "request-adjustment" }),
  { type: "complete-adjustment", actor: "Coach Sam", memberId: state.activeMemberId },
);

const supportingReference = () => createCopilotSupportingContextReference({
  schemaVersion: "copilot-supporting-context/v1",
  memberId: "mbr_jordan",
  contextRevisionId: "revision-1",
  authority: "canonical",
  answerId: "answer:context",
  anchor: { kind: "conversation", evidenceId: "message:anchor" },
  evidenceAsOf: "2026-06-04T23:59:59.999-05:00",
  memberTimezone: "America/Chicago",
  window: { fromInclusive: "2026-05-01T00:00:00.000Z", toExclusive: "2026-07-01T00:00:00.000Z" },
  continuation: createSignedCopilotContinuation({
    claims: {
      schemaVersion: "copilot-continuation-claims/v1",
      coachId: "coach:casey",
      memberId: "mbr_jordan",
      contextRevisionId: "revision-1",
      answerId: "answer:context",
      intentId: "churn-risk",
      selectedEvidenceIds: ["message:anchor"],
      issuedAt: "2026-08-07T10:00:00.000Z",
      expiresAt: "2026-08-07T10:15:00.000Z",
    },
    signature: "test-signature",
  }),
});

const conversationTimeline = (reference = supportingReference()): MemberConversationTimeline => ({
  memberId: reference.memberId,
  contextRevisionId: reference.contextRevisionId,
  authority: reference.authority,
  conversationEvidenceId: "conversation:1",
  anchorEvidenceId: reference.anchor.evidenceId,
  evidenceAsOf: reference.evidenceAsOf,
  memberTimezone: reference.memberTimezone,
  window: reference.window,
  messages: [],
});

describe("coach dashboard state", () => {
  it("keeps runtime generation isolated to the active athlete and ignores stale member completion", () => {
    const requested = dashboardReducer(jordanState(), {
      type: "request-workout-generation",
      requestId: "request:1",
    });
    const avery = dashboardReducer(requested, { type: "select-athlete", memberId: "mbr_avery" });
    const stale = dashboardReducer(avery, {
      type: "complete-workout-generation",
      memberId: "mbr_jordan",
      requestId: "request:1",
      projection: {
        runId: "run:1",
        workoutVersionId: "workout:1",
        version: 1,
        title: "Generated workout",
        durationMinutes: 45,
        workoutSections: [],
        exclusions: [],
        decisions: [],
        decisionPaths: {},
      },
    });

    expect(stale).toBe(avery);
    expect(stale.athleteStates.mbr_jordan.runtimeGeneration.status).toBe("disconnected");
    expect(athlete(stale).runtimeWorkout).toBeNull();
  });

  it("deduplicates runtime completion and preserves the last valid workout across failures", () => {
    const requested = dashboardReducer(jordanState(), { type: "request-workout-generation", requestId: "request:1" });
    const projection = {
      runId: "run:1",
      workoutVersionId: "workout:1",
      version: 1,
      title: "Generated workout",
      durationMinutes: 45,
      workoutSections: [],
      exclusions: [],
      decisions: [],
      decisionPaths: {},
    };
    const completed = dashboardReducer(requested, { type: "complete-workout-generation", memberId: "mbr_jordan", requestId: "request:1", projection });
    const duplicate = dashboardReducer(completed, { type: "complete-workout-generation", memberId: "mbr_jordan", requestId: "request:1", projection });
    const failed = dashboardReducer(duplicate, { type: "update-workout-generation", memberId: "mbr_jordan", requestId: "request:1", status: "failed", message: "Generation failed. Try again." });

    expect(duplicate).toBe(completed);
    expect(athlete(failed).runtimeWorkout).toEqual(projection);
    expect(athlete(failed).runtimeGeneration).toMatchObject({ status: "failed", message: "Generation failed. Try again." });
  });
  it("starts on Today with the workspace date and no active athlete", () => {
    const state = createInitialDashboardState("2026-08-06");

    expect(state).toMatchObject({
      destination: "today",
      selectedDate: "2026-08-06",
      activeMemberId: null,
      routeStack: [],
      athleteStates: {},
    });
  });

  it("preserves the selected date across Coach and Today", () => {
    const selectedDate = dashboardReducer(createInitialDashboardState("2026-08-06"), {
      type: "select-date",
      date: "2026-08-08",
    });
    const coach = dashboardReducer(selectedDate, { type: "select-destination", destination: "coach" });
    const today = dashboardReducer(coach, { type: "select-destination", destination: "today" });

    expect(coach.destination).toBe("coach");
    expect(today.selectedDate).toBe("2026-08-08");
    expect(today.activeMemberId).toBeNull();
  });

  it("pushes and pops nested athlete routes one level at a time", () => {
    const workout = dashboardReducer(jordanState(), { type: "push-route", route: { id: "workout", focusKey: "brief-workout" } });
    const decision = dashboardReducer(workout, {
      type: "push-route",
      route: { id: "decision-path", decisionId: "split-squat", focusKey: "workout-decision-split-squat" },
    });
    const backToWorkout = dashboardReducer(decision, { type: "pop-route" });
    const backToBrief = dashboardReducer(backToWorkout, { type: "pop-route" });

    expect(decision.routeStack.map((route) => route.id)).toEqual(["brief", "workout", "decision-path"]);
    expect(backToWorkout.routeStack.map((route) => route.id)).toEqual(["brief", "workout"]);
    expect(backToBrief.routeStack.map((route) => route.id)).toEqual(["brief"]);
  });

  it("returns from the brief without erasing athlete work", () => {
    const pinned = dashboardReducer(jordanState(), { type: "toggle-pin", insightId: "sleep" });
    const today = dashboardReducer(pinned, { type: "pop-route" });

    expect(today).toMatchObject({
      destination: "today",
      selectedDate: "2026-08-06",
      activeMemberId: null,
      routeStack: [],
    });
    expect(today.athleteStates.mbr_jordan.pins).toEqual(["sleep"]);
  });

  it("uses Today as a hard reset from nested routes while retaining member state", () => {
    const nested = dashboardReducer(
      dashboardReducer(jordanState(), { type: "toggle-pin", insightId: "sleep" }),
      { type: "push-route", route: { id: "copilot", focusKey: "brief-copilot" } },
    );
    const today = dashboardReducer(nested, { type: "select-destination", destination: "today" });

    expect(today.activeMemberId).toBeNull();
    expect(today.routeStack).toEqual([]);
    expect(today.athleteStates.mbr_jordan.pins).toEqual(["sleep"]);
  });

  it("restores isolated completed workflow state for each athlete", () => {
    const adjusted = completeAdjustment(
      dashboardReducer(
        dashboardReducer(jordanState(), { type: "open-adjustment" }),
        { type: "set-draft-duration", duration: 40 },
      ),
    );
    const onToday = dashboardReducer(adjusted, { type: "select-destination", destination: "today" });
    const avery = dashboardReducer(onToday, { type: "select-athlete", memberId: "mbr_avery" });
    const jordan = dashboardReducer(
      dashboardReducer(avery, { type: "select-destination", destination: "today" }),
      { type: "select-athlete", memberId: "mbr_jordan" },
    );

    expect(athlete(avery).contentVersions).toHaveLength(1);
    expect(athlete(jordan).contentVersions).toHaveLength(2);
    expect(selectCurrentVersion(jordan).durationMinutes).toBe(40);
  });

  it("cancels pending work on athlete changes and ignores stale completions", () => {
    const pending = dashboardReducer(jordanState(), { type: "request-prompt", promptId: "sleep" });
    const avery = dashboardReducer(pending, { type: "select-athlete", memberId: "mbr_avery" });
    const stale = dashboardReducer(avery, {
      type: "complete-prompt",
      promptId: "sleep",
      memberId: "mbr_jordan",
    });

    expect(stale).toBe(avery);
    expect(stale.athleteStates.mbr_jordan.pendingPrompt).toBeNull();
    expect(athlete(stale).feed).toEqual(["brief", "adherence", "sleep", "change", "churn"]);
  });

  it("ignores a stale adjustment completion after leaving the athlete", () => {
    const pending = dashboardReducer(
      dashboardReducer(
        dashboardReducer(jordanState(), { type: "open-adjustment" }),
        { type: "set-draft-duration", duration: 40 },
      ),
      { type: "request-adjustment" },
    );
    const today = dashboardReducer(pending, { type: "select-destination", destination: "today" });
    const stale = dashboardReducer(today, {
      type: "complete-adjustment",
      actor: "Coach Sam",
      memberId: "mbr_jordan",
    });

    expect(stale).toBe(today);
    expect(stale.athleteStates.mbr_jordan.pendingAdjustment).toBe(false);
    expect(stale.athleteStates.mbr_jordan.contentVersions).toHaveLength(1);
  });

  it("publishes the current member version once and stays on Workout", () => {
    const workout = dashboardReducer(jordanState(), { type: "push-route", route: { id: "workout", focusKey: "brief-workout" } });
    const published = dashboardReducer(workout, { type: "publish-current-version", actor: "Coach Sam" });
    const repeated = dashboardReducer(published, { type: "publish-current-version", actor: "Coach Sam" });

    expect(athlete(published).publicationEvents).toEqual([
      expect.objectContaining({ workoutVersionId: "workout-v1" }),
    ]);
    expect(athlete(repeated).publicationEvents).toHaveLength(1);
    expect(published.routeStack.at(-1)?.id).toBe("workout");
  });

  it("freezes workout mutations after publication", () => {
    const published = dashboardReducer(jordanState(), { type: "publish-current-version", actor: "Coach Sam" });
    const adjustment = dashboardReducer(published, { type: "open-adjustment" });
    const override = dashboardReducer(published, { type: "open-override", decisionId: "split-squat" });

    expect(adjustment).toBe(published);
    expect(override).toBe(published);
    expect(athlete(published).contentVersions).toHaveLength(1);
  });

  it("does not start a second Copilot request while one is pending", () => {
    const pending = dashboardReducer(jordanState(), { type: "request-prompt", promptId: "sleep" });
    const duplicate = dashboardReducer(pending, { type: "request-prompt", promptId: "churn" });

    expect(duplicate).toBe(pending);
    expect(athlete(duplicate).pendingPrompt).toBe("sleep");
  });

  it("cancels nested pending work on Back and ignores its late completion", () => {
    const copilot = dashboardReducer(jordanState(), { type: "push-route", route: { id: "copilot", focusKey: "brief-copilot" } });
    const pending = dashboardReducer(copilot, { type: "request-prompt", promptId: "sleep" });
    const brief = dashboardReducer(pending, { type: "pop-route" });
    const stale = dashboardReducer(brief, { type: "complete-prompt", promptId: "sleep", memberId: "mbr_jordan" });

    expect(athlete(brief).pendingPrompt).toBeNull();
    expect(stale).toBe(brief);
  });

  it("keeps supporting context member and request scoped across Back and late completions", () => {
    const reference = supportingReference();
    const history = dashboardReducer(jordanState(), {
      type: "push-route",
      route: { id: "history", focusKey: "supporting-context-message:anchor", supportingContext: reference },
    });
    const pending = dashboardReducer(history, {
      type: "request-conversation",
      memberId: "mbr_jordan",
      requestId: "conversation:old",
      reference,
    });
    const newer = dashboardReducer(pending, {
      type: "request-conversation",
      memberId: "mbr_jordan",
      requestId: "conversation:new",
      reference,
    });
    const late = dashboardReducer(newer, {
      type: "complete-conversation",
      memberId: "mbr_jordan",
      requestId: "conversation:old",
      outcome: { status: "ready", requestId: "conversation:old", timeline: conversationTimeline(reference) },
    });

    expect(late).toBe(newer);
    expect(athlete(late).conversation).toMatchObject({ status: "loading", requestId: "conversation:new", reference });

    const avery = dashboardReducer(newer, { type: "select-athlete", memberId: "mbr_avery" });
    const foreignLate = dashboardReducer(avery, {
      type: "complete-conversation",
      memberId: "mbr_jordan",
      requestId: "conversation:new",
      outcome: { status: "ready", requestId: "conversation:new", timeline: conversationTimeline(reference) },
    });
    expect(foreignLate).toBe(avery);
  });

  it("rejects a ready timeline that changes the cited anchor or bounded window", () => {
    const reference = supportingReference();
    const pending = dashboardReducer(
      dashboardReducer(jordanState(), { type: "push-route", route: { id: "history", focusKey: "supporting-context", supportingContext: reference } }),
      { type: "request-conversation", memberId: "mbr_jordan", requestId: "conversation:1", reference },
    );
    const mismatched = dashboardReducer(pending, {
      type: "complete-conversation",
      memberId: "mbr_jordan",
      requestId: "conversation:1",
      outcome: {
        status: "ready",
        requestId: "conversation:1",
        timeline: { ...conversationTimeline(reference), anchorEvidenceId: "message:other" },
      },
    });

    expect(mismatched).toBe(pending);
  });

  it("keeps cancelled edits out of the immutable content history", () => {
    const opened = dashboardReducer(jordanState(), { type: "open-adjustment" });
    const edited = dashboardReducer(opened, { type: "set-draft-duration", duration: 40 });
    const cancelled = dashboardReducer(edited, { type: "cancel-dialog" });

    expect(cancelled.dialog).toBeNull();
    expect(athlete(cancelled).contentVersions).toHaveLength(1);
    expect(athlete(cancelled).contentVersions[0].durationMinutes).toBe(50);
  });

  it("creates one version for an adjustment and one for an override", () => {
    const adjusted = completeAdjustment(
      dashboardReducer(
        dashboardReducer(jordanState(), { type: "open-adjustment" }),
        { type: "set-draft-duration", duration: 40 },
      ),
    );
    const overridden = dashboardReducer(
      dashboardReducer(
        dashboardReducer(adjusted, { type: "open-override", decisionId: "split-squat" }),
        { type: "set-override-reason", reason: "Cleared by PT; light load only" },
      ),
      { type: "apply-override", actor: "Coach Sam", exerciseName: "Split Squat", warning: "Deep flexion" },
    );

    expect(athlete(overridden).contentVersions.map((version) => version.kind)).toEqual([
      "generated",
      "adjustment",
      "override",
    ]);
    expect(athlete(overridden).currentVersionId).toBe("workout-v3");
  });
});
