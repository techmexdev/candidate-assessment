import type { CopilotAnswerPacket, CopilotPin, CopilotQuestionInput, SignedCopilotContinuation } from "../../domain/contracts/copilot";
import type { DashboardCopilotOutcome, DashboardDecisionId, DashboardInsightId } from "./dashboard-contract";
import type { DashboardRuntimeWorkoutProjection, DashboardWorkoutRuntimeUpdate } from "./runtime-adapter";
import type { MemberConversationTimeline } from "../../application/use-cases/retrieve-member-conversation";
import { createInitialSpeechCaptureState, type SpeechCaptureState } from "./speech-input";

export type DashboardDestination = "today" | "coach";
export type DashboardDialog = "adjustment" | "override";

type AthleteRouteBase = { focusKey: string };

export type AthleteRoute =
  | (AthleteRouteBase & { id: "brief" })
  | (AthleteRouteBase & { id: "workout" })
  | (AthleteRouteBase & { id: "workout-rationale"; itemId?: string })
  | (AthleteRouteBase & { id: "copilot" })
  | (AthleteRouteBase & { id: "voice" })
  | (AthleteRouteBase & { id: "history" })
  | (AthleteRouteBase & { id: "profile" })
  | (AthleteRouteBase & { id: "insight"; detailId: string })
  | (AthleteRouteBase & { id: "decision-path"; decisionId: DashboardDecisionId })
  | (AthleteRouteBase & { id: "approve" });

export type QuickPromptId = DashboardInsightId;
export type InsightId = QuickPromptId;

export type WorkoutVersion = {
  id: string;
  number: number;
  kind: "generated" | "adjustment" | "override";
  title: string;
  actor: string;
  time: string;
  durationMinutes: number;
  intensity: "Light" | "Moderate" | "Hard";
  overrideDecisionId: DashboardDecisionId | null;
  overrideReason: string | null;
  changes: string[];
};

export type PublicationEvent = {
  id: string;
  workoutVersionId: string;
  actor: string;
  time: string;
};

export type RuntimeGenerationState = {
  status: "idle" | DashboardWorkoutRuntimeUpdate["status"];
  requestId: string | null;
  runId: string | null;
  message: string;
};

export type DashboardCopilotRequestRecord = {
  readonly requestId: string;
  readonly memberId: string;
  readonly promptLabel: string;
  readonly input: CopilotQuestionInput;
  readonly continuation?: SignedCopilotContinuation;
};

export type DashboardCopilotState = {
  readonly pending: DashboardCopilotRequestRecord | null;
  readonly lastRequest: DashboardCopilotRequestRecord | null;
  readonly outcome: DashboardCopilotOutcome | null;
  readonly answers: readonly CopilotAnswerPacket[];
  readonly lastReadyAnswer: CopilotAnswerPacket | null;
  readonly pins: readonly CopilotPin[];
};

export type DashboardConversationState = {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly timeline: MemberConversationTimeline | null;
  readonly message: string;
};

export type AthleteWorkflowState = {
  pendingPrompt: QuickPromptId | null;
  feed: QuickPromptId[];
  pins: InsightId[];
  draftDuration: number;
  draftIntensity: WorkoutVersion["intensity"];
  pendingAdjustment: boolean;
  overrideDecisionIdDraft: DashboardDecisionId | null;
  overrideReasonDraft: string;
  currentVersionId: string;
  contentVersions: WorkoutVersion[];
  publicationEvents: PublicationEvent[];
  runtimeGeneration: RuntimeGenerationState;
  runtimeWorkout: DashboardRuntimeWorkoutProjection | null;
  conversation: DashboardConversationState;
  copilot: DashboardCopilotState;
  capture: SpeechCaptureState;
};

export type DashboardState = {
  destination: DashboardDestination;
  selectedDate: string;
  todayView: { allAthletesExpanded: boolean };
  activeMemberId: string | null;
  routeStack: AthleteRoute[];
  athleteStates: Record<string, AthleteWorkflowState>;
  dialog: DashboardDialog | null;
  announcement: string;
};

export type DashboardAction =
  | { type: "reset-session" }
  | { type: "initialize-date"; date: string }
  | { type: "select-date"; date: string }
  | { type: "set-all-athletes-expanded"; expanded: boolean }
  | { type: "select-destination"; destination: DashboardDestination }
  | { type: "select-athlete"; memberId: string; focusKey?: string }
  | { type: "push-route"; route: Exclude<AthleteRoute, { id: "brief" }> }
  | { type: "pop-route"; preserveCapture?: boolean }
  | { type: "open-adjustment" }
  | { type: "open-override"; decisionId: DashboardDecisionId }
  | { type: "set-draft-duration"; duration: number }
  | { type: "set-draft-intensity"; intensity: WorkoutVersion["intensity"] }
  | { type: "set-override-reason"; reason: string }
  | { type: "cancel-dialog" }
  | { type: "request-adjustment" }
  | { type: "complete-adjustment"; actor: string; memberId?: string | null }
  | { type: "apply-override"; actor: string; exerciseName: string; warning: string }
  | { type: "publish-current-version"; actor: string }
  | { type: "request-prompt"; promptId: QuickPromptId }
  | { type: "complete-prompt"; promptId: QuickPromptId; memberId?: string | null }
  | { type: "request-copilot"; request: DashboardCopilotRequestRecord }
  | { type: "complete-copilot"; memberId: string; requestId: string; outcome: DashboardCopilotOutcome }
  | { type: "toggle-copilot-pin"; pin: CopilotPin }
  | { type: "update-speech-capture"; memberId: string; capture: SpeechCaptureState }
  | { type: "request-workout-generation"; requestId: string }
  | {
      type: "update-workout-generation";
      memberId: string;
      requestId: string;
      status: Exclude<DashboardWorkoutRuntimeUpdate["status"], "completed">;
      message: string;
      runId?: string;
    }
  | {
      type: "complete-workout-generation";
      memberId: string;
      requestId: string;
      projection: DashboardRuntimeWorkoutProjection;
    }
  | { type: "request-conversation"; memberId: string }
  | { type: "complete-conversation"; memberId: string; status: "ready" | "error"; timeline?: MemberConversationTimeline; message: string }
  | { type: "toggle-pin"; insightId: InsightId };

const generatedVersion: WorkoutVersion = {
  id: "workout-v1",
  number: 1,
  kind: "generated",
  title: "Auto daily draft",
  actor: "Axon",
  time: "6:02 AM",
  durationMinutes: 50,
  intensity: "Moderate",
  overrideDecisionId: null,
  overrideReason: null,
  changes: [
    "Built from goals, injury, equipment and recent training",
    "3 constraint decisions applied (2 safety, 1 preference)",
  ],
};

function createAthleteWorkflowState(): AthleteWorkflowState {
  return {
    pendingPrompt: null,
    feed: ["brief", "adherence", "sleep", "change", "churn"],
    pins: [],
    draftDuration: generatedVersion.durationMinutes,
    draftIntensity: generatedVersion.intensity,
    pendingAdjustment: false,
    overrideDecisionIdDraft: null,
    overrideReasonDraft: "",
    currentVersionId: generatedVersion.id,
    contentVersions: [{ ...generatedVersion, changes: [...generatedVersion.changes] }],
    publicationEvents: [],
    runtimeGeneration: { status: "idle", requestId: null, runId: null, message: "" },
    runtimeWorkout: null,
    conversation: { status: "idle", timeline: null, message: "" },
    copilot: { pending: null, lastRequest: null, outcome: null, answers: [], lastReadyAnswer: null, pins: [] },
    capture: createInitialSpeechCaptureState(),
  };
}

export function createInitialDashboardState(selectedDate = ""): DashboardState {
  return {
    destination: "today",
    selectedDate,
    todayView: { allAthletesExpanded: false },
    activeMemberId: null,
    routeStack: [],
    athleteStates: {},
    dialog: null,
    announcement: "Coach day ready.",
  };
}

export const initialDashboardState = createInitialDashboardState();

function currentVersion(workflow: AthleteWorkflowState) {
  return workflow.contentVersions.find((version) => version.id === workflow.currentVersionId)
    ?? workflow.contentVersions.at(-1)!;
}

function isPublished(workflow: AthleteWorkflowState) {
  return workflow.publicationEvents.length > 0;
}

function cancelPending(workflow: AthleteWorkflowState, options: { preserveCapture?: boolean } = {}): AthleteWorkflowState {
  const generationPending = ["submitting", "queued", "running"].includes(workflow.runtimeGeneration.status);
  const capturePending = !options.preserveCapture && (workflow.capture.status !== "idle"
    || Boolean(workflow.capture.transcript)
    || Boolean(workflow.capture.interimTranscript));
  if (!workflow.pendingPrompt && !workflow.pendingAdjustment && !generationPending && !workflow.copilot.pending && !capturePending) return workflow;
  return {
    ...workflow,
    pendingPrompt: null,
    pendingAdjustment: false,
    copilot: workflow.copilot.pending ? { ...workflow.copilot, pending: null } : workflow.copilot,
    capture: capturePending ? createInitialSpeechCaptureState() : workflow.capture,
    ...(generationPending ? {
      runtimeGeneration: {
        ...workflow.runtimeGeneration,
        status: "disconnected" as const,
        message: "Workout updates stopped after leaving this member.",
      },
    } : {}),
  };
}

function updateAthlete(
  state: DashboardState,
  memberId: string,
  update: (workflow: AthleteWorkflowState) => AthleteWorkflowState,
): DashboardState {
  const existing = state.athleteStates[memberId];
  if (!existing) return state;
  const next = update(existing);
  if (next === existing) return state;
  return { ...state, athleteStates: { ...state.athleteStates, [memberId]: next } };
}

function updateActiveAthlete(
  state: DashboardState,
  update: (workflow: AthleteWorkflowState) => AthleteWorkflowState,
): DashboardState {
  return state.activeMemberId ? updateAthlete(state, state.activeMemberId, update) : state;
}

function leaveActiveRoute(state: DashboardState): DashboardState {
  const cancelled = state.activeMemberId
    ? updateAthlete(state, state.activeMemberId, cancelPending)
    : state;
  return { ...cancelled, activeMemberId: null, routeStack: [], dialog: null };
}

function addVersion(
  workflow: AthleteWorkflowState,
  kind: "adjustment" | "override",
  changes: string[],
  updates: Partial<WorkoutVersion>,
  actor: string,
): AthleteWorkflowState {
  const previous = currentVersion(workflow);
  const number = workflow.contentVersions.length + 1;
  const version: WorkoutVersion = {
    ...previous,
    ...updates,
    id: `workout-v${number}`,
    number,
    kind,
    title: kind === "adjustment" ? "Coach adjustment" : "Safety override",
    actor,
    time: kind === "adjustment" ? "7:41 AM" : "7:48 AM",
    changes,
  };

  return {
    ...workflow,
    pendingAdjustment: false,
    overrideDecisionIdDraft: null,
    overrideReasonDraft: "",
    currentVersionId: version.id,
    contentVersions: [...workflow.contentVersions, version],
  };
}

export function dashboardReducer(state: DashboardState, action: DashboardAction): DashboardState {
  switch (action.type) {
    case "reset-session":
      return createInitialDashboardState();
    case "initialize-date":
      return state.selectedDate ? state : { ...state, selectedDate: action.date };
    case "select-date":
      return { ...state, selectedDate: action.date, announcement: `${action.date} selected.` };
    case "set-all-athletes-expanded":
      return state.todayView.allAthletesExpanded === action.expanded
        ? state
        : { ...state, todayView: { allAthletesExpanded: action.expanded } };
    case "select-destination": {
      const left = leaveActiveRoute(state);
      return {
        ...left,
        destination: action.destination,
        todayView: action.destination === "today" ? { allAthletesExpanded: false } : left.todayView,
        announcement: action.destination === "today" ? "Today opened." : "Coach opened.",
      };
    }
    case "select-athlete": {
      const left = leaveActiveRoute(state);
      const workflow = left.athleteStates[action.memberId] ?? createAthleteWorkflowState();
      return {
        ...left,
        destination: "today",
        activeMemberId: action.memberId,
        routeStack: [{ id: "brief", focusKey: action.focusKey ?? `today-row-athlete-${action.memberId}` }],
        athleteStates: { ...left.athleteStates, [action.memberId]: workflow },
        announcement: "Athlete morning brief opened.",
      };
    }
    case "push-route":
      return state.destination === "today" && state.activeMemberId
        ? { ...state, routeStack: [...state.routeStack, action.route], announcement: `${action.route.id} opened.` }
        : state;
    case "pop-route":
      if (!state.activeMemberId || state.routeStack.length === 0) return state;
      if (state.routeStack.length === 1) {
        return { ...leaveActiveRoute(state), destination: "today", announcement: "Today restored." };
      }
      {
        const cancelled = updateActiveAthlete(state, (workflow) => cancelPending(workflow, { preserveCapture: action.preserveCapture }));
        return {
          ...cancelled,
          routeStack: state.routeStack.slice(0, -1),
          dialog: null,
          announcement: `${state.routeStack.at(-2)?.id ?? "brief"} restored.`,
        };
      }
    case "open-adjustment": {
      const workflow = selectActiveAthleteState(state);
      if (!workflow || isPublished(workflow)) return state;
      const version = currentVersion(workflow);
      const updated = updateActiveAthlete(state, (current) => ({
        ...current,
        pendingAdjustment: false,
        draftDuration: version.durationMinutes,
        draftIntensity: version.intensity,
      }));
      return { ...updated, dialog: "adjustment" };
    }
    case "open-override": {
      const workflow = selectActiveAthleteState(state);
      if (!workflow || isPublished(workflow)) return state;
      const updated = updateActiveAthlete(state, (current) => ({
        ...current,
        overrideDecisionIdDraft: action.decisionId,
        overrideReasonDraft: "",
      }));
      return { ...updated, dialog: "override" };
    }
    case "set-draft-duration":
      if (state.dialog !== "adjustment") return state;
      return updateActiveAthlete(state, (workflow) => isPublished(workflow)
        ? workflow
        : { ...workflow, draftDuration: action.duration });
    case "set-draft-intensity":
      if (state.dialog !== "adjustment") return state;
      return updateActiveAthlete(state, (workflow) => isPublished(workflow)
        ? workflow
        : { ...workflow, draftIntensity: action.intensity });
    case "set-override-reason":
      if (state.dialog !== "override") return state;
      return updateActiveAthlete(state, (workflow) => isPublished(workflow)
        ? workflow
        : { ...workflow, overrideReasonDraft: action.reason });
    case "cancel-dialog": {
      const workflow = selectActiveAthleteState(state);
      if (workflow?.pendingAdjustment) return state;
      const updated = updateActiveAthlete(state, (current) => ({
        ...current,
        overrideDecisionIdDraft: null,
        overrideReasonDraft: "",
      }));
      return { ...updated, dialog: null };
    }
    case "request-adjustment": {
      const workflow = selectActiveAthleteState(state);
      if (state.dialog !== "adjustment" || !workflow || workflow.pendingAdjustment || isPublished(workflow)) return state;
      const updated = updateActiveAthlete(state, (current) => ({ ...current, pendingAdjustment: true }));
      return { ...updated, announcement: "Applying adjustment…" };
    }
    case "complete-adjustment": {
      const memberId = action.memberId ?? state.activeMemberId;
      const workflow = memberId ? state.athleteStates[memberId] : null;
      if (
        !memberId || memberId !== state.activeMemberId || state.dialog !== "adjustment" ||
        !workflow?.pendingAdjustment || isPublished(workflow)
      ) return state;
      const dropBench = workflow.draftDuration <= 40;
      const updated = updateAthlete(state, memberId, (current) => addVersion(
        current,
        "adjustment",
        [
          `Duration ${current.draftDuration} min · intensity ${current.draftIntensity}`,
          ...(dropBench ? ["DB Neutral-Grip Bench Press removed (time budget)"] : []),
          "Rest guidance re-sized to window",
        ],
        { durationMinutes: current.draftDuration, intensity: current.draftIntensity },
        action.actor,
      ));
      return {
        ...updated,
        dialog: null,
        announcement: `Adjustment saved as version ${updated.athleteStates[memberId].contentVersions.length}.`,
      };
    }
    case "apply-override": {
      const workflow = selectActiveAthleteState(state);
      const reason = workflow?.overrideReasonDraft.trim() ?? "";
      if (
        state.dialog !== "override" || !workflow?.overrideDecisionIdDraft ||
        isPublished(workflow) || reason.length < 4
      ) return state;
      const updated = updateActiveAthlete(state, (current) => addVersion(
        current,
        "override",
        [
          `${action.exerciseName} added`,
          `${action.warning} · warning retained on version`,
          `Reason: “${reason}”`,
        ],
        { overrideDecisionId: current.overrideDecisionIdDraft, overrideReason: reason },
        action.actor,
      ));
      return {
        ...updated,
        dialog: null,
        announcement: `Override saved as version ${selectActiveAthleteState(updated)?.contentVersions.length}.`,
      };
    }
    case "publish-current-version": {
      const workflow = selectActiveAthleteState(state);
      if (!workflow || isPublished(workflow)) return state;
      const event: PublicationEvent = {
        id: "publication-1",
        workoutVersionId: workflow.currentVersionId,
        actor: action.actor,
        time: "7:52 AM",
      };
      const updated = updateActiveAthlete(state, (current) => ({ ...current, publicationEvents: [event] }));
      const brief = state.routeStack[0] ?? { id: "brief" as const, focusKey: `today-athlete-${state.activeMemberId}` };
      const workoutIndex = state.routeStack.findIndex((route) => route.id === "workout");
      const routeStack = workoutIndex >= 0
        ? state.routeStack.slice(0, workoutIndex + 1)
        : [brief, { id: "workout" as const, focusKey: "brief-workout" }];
      return {
        ...updated,
        routeStack,
        dialog: null,
        announcement: `Version ${currentVersion(workflow).number} recorded locally. No external delivery occurred.`,
      };
    }
    case "request-prompt": {
      const workflow = selectActiveAthleteState(state);
      if (!workflow || workflow.pendingPrompt) return state;
      const updated = updateActiveAthlete(state, (current) => ({
        ...current,
        pendingPrompt: action.promptId,
        feed: [...current.feed.filter((id) => id !== action.promptId), action.promptId],
      }));
      return { ...updated, announcement: `Retrieving ${action.promptId} member context…` };
    }
    case "complete-prompt": {
      const memberId = action.memberId ?? state.activeMemberId;
      if (!memberId || memberId !== state.activeMemberId) return state;
      const workflow = state.athleteStates[memberId];
      if (workflow?.pendingPrompt !== action.promptId) return state;
      const updated = updateAthlete(state, memberId, (current) => ({ ...current, pendingPrompt: null }));
      return {
        ...updated,
        announcement: `${action.promptId[0].toUpperCase()}${action.promptId.slice(1)} member context ready.`,
      };
    }
    case "request-copilot": {
      const workflow = selectActiveAthleteState(state);
      if (!workflow || workflow.copilot.pending || action.request.memberId !== state.activeMemberId) return state;
      const updated = updateActiveAthlete(state, (current) => ({
        ...current,
        copilot: { ...current.copilot, pending: action.request, lastRequest: action.request },
      }));
      return { ...updated, announcement: `Retrieving ${action.request.promptLabel} member context…` };
    }
    case "complete-copilot": {
      if (action.memberId !== state.activeMemberId) return state;
      const workflow = state.athleteStates[action.memberId];
      if (!workflow || workflow.copilot.pending?.requestId !== action.requestId) return state;
      const ready = action.outcome.status === "ready" ? action.outcome.answer : null;
      const keepLastReady = ready
        ? ready
        : action.outcome.controls.keepLastReadyAnswer
          ? workflow.copilot.lastReadyAnswer
          : null;
      const updated = updateAthlete(state, action.memberId, (current) => ({
        ...current,
        copilot: {
          ...current.copilot,
          pending: null,
          outcome: action.outcome,
          lastReadyAnswer: keepLastReady,
          answers: ready ? [...current.copilot.answers, ready] : current.copilot.answers,
        },
      }));
      const message = action.outcome.status === "ready"
        ? `${workflow.copilot.pending.promptLabel} member context ready.`
        : action.outcome.status === "cancelled"
          ? "Copilot request cancelled."
          : "message" in action.outcome
            ? action.outcome.message
            : "Copilot request finished.";
      return { ...updated, announcement: message };
    }
    case "toggle-copilot-pin": {
      const workflow = selectActiveAthleteState(state);
      if (!workflow || action.pin.memberId !== state.activeMemberId) return state;
      const removing = workflow.copilot.pins.some((pin) => pin.pinId === action.pin.pinId);
      const updated = updateActiveAthlete(state, (current) => ({
        ...current,
        copilot: {
          ...current.copilot,
          pins: removing
            ? current.copilot.pins.filter((pin) => pin.pinId !== action.pin.pinId)
            : [...current.copilot.pins, action.pin],
        },
      }));
      return { ...updated, announcement: removing ? "Copilot pin removed from Today." : "Copilot answer pinned to Today." };
    }
    case "update-speech-capture": {
      if (action.memberId !== state.activeMemberId) return state;
      const workflow = state.athleteStates[action.memberId];
      if (!workflow) return state;
      const currentCaptureId = workflow.capture.scope?.captureId;
      const nextCaptureId = action.capture.scope?.captureId;
      const activeCapture = workflow.capture.status !== "idle" && workflow.capture.status !== "cancelled";
      if (activeCapture && currentCaptureId && nextCaptureId && currentCaptureId !== nextCaptureId) return state;
      const updated = updateAthlete(state, action.memberId, (current) => ({ ...current, capture: action.capture }));
      const message = action.capture.status === "listening"
        ? "Voice input listening."
        : action.capture.status === "reviewing"
          ? "Voice input ready to review."
          : action.capture.status === "submitting"
            ? "Submitting voice question."
            : action.capture.message;
      return message ? { ...updated, announcement: message } : updated;
    }
    case "request-workout-generation": {
      const workflow = selectActiveAthleteState(state);
      if (!workflow || ["submitting", "queued", "running"].includes(workflow.runtimeGeneration.status)) return state;
      const updated = updateActiveAthlete(state, (current) => ({
        ...current,
        runtimeGeneration: {
          status: "submitting",
          requestId: action.requestId,
          runId: null,
          message: "Submitting workout request…",
        },
      }));
      return { ...updated, announcement: "Submitting workout request…" };
    }
    case "update-workout-generation": {
      if (action.memberId !== state.activeMemberId) return state;
      const workflow = state.athleteStates[action.memberId];
      if (!workflow || workflow.runtimeGeneration.requestId !== action.requestId) return state;
      const updated = updateAthlete(state, action.memberId, (current) => ({
        ...current,
        runtimeGeneration: {
          status: action.status,
          requestId: action.requestId,
          runId: action.runId ?? current.runtimeGeneration.runId,
          message: action.message,
        },
      }));
      return { ...updated, announcement: action.message };
    }
    case "complete-workout-generation": {
      if (action.memberId !== state.activeMemberId) return state;
      const workflow = state.athleteStates[action.memberId];
      if (!workflow || workflow.runtimeGeneration.requestId !== action.requestId) return state;
      if (workflow.runtimeWorkout?.workoutVersionId === action.projection.workoutVersionId) return state;
      const version: WorkoutVersion = {
        id: action.projection.workoutVersionId,
        number: action.projection.version,
        kind: "generated",
        title: action.projection.title,
        actor: "Axon runtime",
        time: "Now",
        durationMinutes: action.projection.durationMinutes,
        intensity: "Moderate",
        overrideDecisionId: null,
        overrideReason: null,
        changes: [
          "Canonical runtime draft loaded",
          `${action.projection.decisions.length} stored decisions projected`,
        ],
      };
      const updated = updateAthlete(state, action.memberId, (current) => ({
        ...current,
        runtimeWorkout: action.projection,
        runtimeGeneration: {
          status: "completed",
          requestId: action.requestId,
          runId: action.projection.runId,
          message: "Generated workout and decision trace ready.",
        },
        currentVersionId: version.id,
        contentVersions: current.contentVersions.some((item) => item.id === version.id)
          ? current.contentVersions
          : [...current.contentVersions, version],
      }));
      return { ...updated, announcement: "Generated workout and decision trace ready." };
    }
    case "request-conversation": {
      if (action.memberId !== state.activeMemberId) return state;
      const updated = updateAthlete(state, action.memberId, (current) => ({
        ...current,
        conversation: { ...current.conversation, status: "loading", message: "Loading revision-pinned conversation…" },
      }));
      return { ...updated, announcement: "Loading conversation history…" };
    }
    case "complete-conversation": {
      if (action.memberId !== state.activeMemberId) return state;
      const updated = updateAthlete(state, action.memberId, (current) => ({
        ...current,
        conversation: {
          status: action.status,
          timeline: action.timeline ?? current.conversation.timeline,
          message: action.message,
        },
      }));
      return { ...updated, announcement: action.message };
    }
    case "toggle-pin": {
      const workflow = selectActiveAthleteState(state);
      if (!workflow) return state;
      const removing = workflow.pins.includes(action.insightId);
      const updated = updateActiveAthlete(state, (current) => ({
        ...current,
        pins: removing
          ? current.pins.filter((id) => id !== action.insightId)
          : [...current.pins, action.insightId],
      }));
      return {
        ...updated,
        announcement: removing
          ? `${action.insightId} removed from Today.`
          : `${action.insightId} pinned to Today.`,
      };
    }
  }
}

export function selectActiveAthleteState(state: DashboardState) {
  return state.activeMemberId ? state.athleteStates[state.activeMemberId] ?? null : null;
}

export function selectCurrentVersion(state: DashboardState) {
  const workflow = selectActiveAthleteState(state);
  return workflow ? currentVersion(workflow) : generatedVersion;
}

export function selectIsPublished(state: DashboardState) {
  const workflow = selectActiveAthleteState(state);
  return workflow ? isPublished(workflow) : false;
}

export function selectCurrentRoute(state: DashboardState) {
  return state.routeStack.at(-1) ?? null;
}
