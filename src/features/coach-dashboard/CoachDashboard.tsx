"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";

import { SignalKicker } from "@/ui/axon/components/agentic/SignalKicker";
import { VersionTimeline } from "@/ui/axon/components/data/VersionTimeline";
import { calculateCalendarWindow } from "../../domain/policies/copilot-projections";
import { createCopilotPin, createCopilotSupportingContextReference, type CopilotAnswerPacket, type CopilotQuestionInput, type CopilotSupportingContextReference, type SignedCopilotContinuation } from "../../domain/contracts/copilot";
import type { FullGraphProjection, FullGraphReadResult } from "../../domain/contracts/full-graph-view";
import type {
  CoachDashboardMemberViewModel,
  CoachDashboardWorkspace,
  DashboardAdapter,
  DashboardDecisionId,
} from "./dashboard-contract";
import { buildTodayProjection, sessionDateKey } from "./synthetic-dashboard-base";
import { sortWorkoutHistoryChronologically } from "./history-order";
import {
  dashboardReducer,
  initialDashboardState,
  selectActiveAthleteState,
  selectCurrentRoute,
  selectCurrentVersion,
  selectIsPublished,
  type AthleteRoute,
  type AthleteWorkflowState,
  type DashboardAction,
  type DashboardDestination,
  type DashboardState,
  type QuickPromptId,
  type WorkoutVersion,
} from "./state";
import {
  buildCopilotAnswerViewModel,
  buildCopilotWorkbenchViewModel,
  type CopilotAnswerViewModel,
  type CopilotPresentationGroup,
} from "./copilot-view-model";
import styles from "./dashboard.module.css";
import { FullGraphExplorer, type GraphInspectionOutcome, type GraphInspectionRequest } from "./FullGraphExplorer";

const destinations: { id: DashboardDestination; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "coach", label: "Coach" },
];

type NestedScreen = Exclude<AthleteRoute, { id: "brief" | "decision-path" }>["id"];

const prompts: { id: QuickPromptId; label: string }[] = [
  { id: "brief", label: "Morning brief" },
  { id: "adherence", label: "Adherence" },
  { id: "sleep", label: "Sleep" },
  { id: "change", label: "What changed since last week?" },
  { id: "churn", label: "Churn risk" },
];

const DashboardViewModelContext = createContext<CoachDashboardMemberViewModel | null>(null);

function graphResultMatchesRequest(
  result: FullGraphReadResult,
  expected: { readonly domain: FullGraphProjection["domain"]; readonly memberId?: string; readonly revisionId?: string },
): boolean {
  if (result.status !== "ready") return result.domain === expected.domain;
  return result.data.domain === expected.domain
    && result.data.memberId === expected.memberId
    && (!expected.revisionId || result.data.revisionId === expected.revisionId);
}

function graphTopologyMatches(left: FullGraphProjection, right: FullGraphProjection): boolean {
  if (left.domain !== right.domain
    || left.memberId !== right.memberId
    || left.revisionId !== right.revisionId
    || left.sourceArtifactDigest !== right.sourceArtifactDigest
    || left.counts.nodes !== right.counts.nodes
    || left.counts.relationships !== right.counts.relationships) return false;
  const leftNodes = [...left.nodes].map((node) => node.id).sort();
  const rightNodes = [...right.nodes].map((node) => node.id).sort();
  if (leftNodes.length !== rightNodes.length || leftNodes.some((id, index) => id !== rightNodes[index])) return false;
  const relationshipKey = (relationship: FullGraphProjection["relationships"][number]) => `${relationship.id}\u0000${relationship.fromId}\u0000${relationship.toId}`;
  const leftRelationships = [...left.relationships].map(relationshipKey).sort();
  const rightRelationships = [...right.relationships].map(relationshipKey).sort();
  return leftRelationships.length === rightRelationships.length
    && leftRelationships.every((key, index) => key === rightRelationships[index]);
}

function useDashboardViewModel() {
  const viewModel = useContext(DashboardViewModelContext);
  if (!viewModel) throw new Error("Coach dashboard view model is unavailable.");
  return viewModel;
}

export function CoachDashboard({ adapter }: { adapter: DashboardAdapter }) {
  const [state, dispatch] = useReducer(dashboardReducer, initialDashboardState);
  const [loadState, setLoadState] = useState(adapter.initialState);
  const [sessionState, setSessionState] = useState<"checking-session" | "signed-out" | "signing-in" | "authenticated" | "expired" | "unavailable">(
    adapter.capabilities.session?.available ? "checking-session" : "authenticated",
  );
  const [adapterAnnouncement, setAdapterAnnouncement] = useState("");
  const [isDesktop, setIsDesktop] = useState(false);
  const [movementGraph, setMovementGraph] = useState<FullGraphReadResult | null>(null);
  const [movementGraphExpanded, setMovementGraphExpanded] = useState(false);
  const [movementGraphLoading, setMovementGraphLoading] = useState(false);
  const [memberContextGraph, setMemberContextGraph] = useState<FullGraphReadResult | null>(null);
  const [memberContextGraphMemberId, setMemberContextGraphMemberId] = useState<string | null>(null);
  const [memberContextGraphExpanded, setMemberContextGraphExpanded] = useState(false);
  const [memberContextGraphLoading, setMemberContextGraphLoading] = useState(false);
  const loadRequest = useRef(0);
  const adjustmentTimer = useRef<number | null>(null);
  const copilotAbort = useRef<AbortController | null>(null);
  const copilotRequest = useRef(0);
  const generationAbort = useRef<AbortController | null>(null);
  const conversationAbort = useRef<AbortController | null>(null);
  const conversationRequest = useRef(0);
  const fullGraphAbort = useRef<AbortController | null>(null);
  const fullGraphRequest = useRef(0);
  const memberGraphAbort = useRef<AbortController | null>(null);
  const memberGraphRequest = useRef(0);
  const generationInput = useRef(new Map<string, { prompt: string; durationMinutes: number; idempotencyKey: string }>());
  const generationRequest = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const returnFocusKey = useRef<string | null>(null);
  const focusFrame = useRef<number | null>(null);
  const sessionAbort = useRef<AbortController | null>(null);
  const suppressRouteFocusRestore = useRef(false);
  const dialogWasOpen = useRef(false);
  const previousRoutes = useRef<AthleteRoute[]>([]);
  const activeWorkflow = selectActiveAthleteState(state);
  const currentVersion = selectCurrentVersion(state);
  const published = selectIsPublished(state);
  const dialogOpen = Boolean(state.dialog);
  const currentRoute = selectCurrentRoute(state);
  const workspace = loadState.status === "ready" ? loadState.data.workspace : null;
  const activeMember = workspace && state.activeMemberId ? workspace.memberViews[state.activeMemberId] ?? null : null;
  const projectedMember = useMemo(() => {
    const projection = activeWorkflow?.runtimeWorkout;
    if (!activeMember || !projection) return activeMember;
    return {
      ...activeMember,
      workoutTitle: projection.title,
      workoutSections: projection.workoutSections,
      exclusions: projection.exclusions,
      decisionPaths: projection.decisionPaths,
    };
  }, [activeMember, activeWorkflow?.runtimeWorkout]);

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    try {
      const next = await adapter.load();
      if (request !== loadRequest.current) return;
      setLoadState(next);
      setAdapterAnnouncement(
        next.status === "ready"
          ? "Dashboard data ready."
          : next.status === "empty" || next.status === "error"
            ? next.message
            : "Loading dashboard data.",
      );
    } catch {
      if (request !== loadRequest.current) return;
      setLoadState({ status: "error", message: "Dashboard data could not be loaded.", retryable: true });
      setAdapterAnnouncement("Dashboard data could not be loaded.");
    }
  }, [adapter]);

  const clearMovementGraph = useCallback(() => {
    fullGraphAbort.current?.abort();
    fullGraphAbort.current = null;
    fullGraphRequest.current += 1;
    setMovementGraph(null);
    setMovementGraphExpanded(false);
    setMovementGraphLoading(false);
  }, []);

  const clearMemberContextGraph = useCallback(() => {
    memberGraphAbort.current?.abort();
    memberGraphAbort.current = null;
    memberGraphRequest.current += 1;
    setMemberContextGraph(null);
    setMemberContextGraphMemberId(null);
    setMemberContextGraphExpanded(false);
    setMemberContextGraphLoading(false);
  }, []);

  const readMovementGraph = useCallback(async (revisionId?: string, inspection?: Pick<GraphInspectionRequest, "entityId" | "entityKind">): Promise<GraphInspectionOutcome | undefined> => {
    const capability = adapter.capabilities.fullGraph;
    if (!capability?.available || !capability.supports({ domain: "movement-clinical" })) return inspection ? "failed" : undefined;
    fullGraphAbort.current?.abort();
    const controller = new AbortController();
    const requestId = ++fullGraphRequest.current;
    fullGraphAbort.current = controller;
    if (!inspection) setMovementGraph(null);
    if (!inspection) setMovementGraphLoading(true);
    try {
      const request = {
        domain: "movement-clinical",
        ...(revisionId ? { revisionId } : {}),
        ...(inspection ? { entityId: inspection.entityId, entityKind: inspection.entityKind } : {}),
        signal: controller.signal,
      } as const;
      const result = !inspection && capability.client.readProgressively
        ? await capability.client.readProgressively(request, (progress) => {
            if (!controller.signal.aborted
              && requestId === fullGraphRequest.current
              && graphResultMatchesRequest(progress, request)) setMovementGraph(progress);
          })
        : await capability.client.read(request);
      if (controller.signal.aborted
        || requestId !== fullGraphRequest.current
        || !graphResultMatchesRequest(result, request)) return inspection ? "failed" : undefined;
      if (inspection) {
        const refreshed = movementGraph?.status === "ready"
          && result.status === "ready"
          && graphTopologyMatches(movementGraph.data, result.data);
        if (refreshed) setMovementGraph(result);
        return refreshed ? "refreshed" : result.status === "ready" ? "unchanged" : "failed";
      } else {
        setMovementGraph(result);
      }
    } catch {
      if (!inspection && !controller.signal.aborted && requestId === fullGraphRequest.current) {
        setMovementGraph({ status: "unavailable", domain: "movement-clinical", message: "Movement graph is unavailable." });
      }
      return inspection ? "failed" : undefined;
    } finally {
      if (fullGraphAbort.current === controller) {
        fullGraphAbort.current = null;
        if (!inspection) setMovementGraphLoading(false);
      }
    }
  }, [adapter, movementGraph]);

  const expandMovementGraph = useCallback(() => {
    setMovementGraphExpanded(true);
    void readMovementGraph();
  }, [readMovementGraph]);

  const collapseMovementGraph = useCallback(() => {
    clearMovementGraph();
  }, [clearMovementGraph]);

  const readMemberContextGraph = useCallback(async (memberId: string, revisionId?: string, inspection?: Pick<GraphInspectionRequest, "entityId" | "entityKind">): Promise<GraphInspectionOutcome | undefined> => {
    const capability = adapter.capabilities.fullGraph;
    const request = { domain: "member-context" as const, memberId };
    if (!capability?.available || !capability.supports(request)) {
      if (inspection) return "failed";
      setMemberContextGraphMemberId(memberId);
      setMemberContextGraph({ status: "unavailable", domain: "member-context", message: "Member context graph is unavailable for this member." });
      setMemberContextGraphLoading(false);
      return;
    }
    memberGraphAbort.current?.abort();
    const controller = new AbortController();
    const requestId = ++memberGraphRequest.current;
    memberGraphAbort.current = controller;
    setMemberContextGraphMemberId(memberId);
    if (!inspection) setMemberContextGraph(null);
    if (!inspection) setMemberContextGraphLoading(true);
    try {
      const graphRequest = {
        ...request,
        ...(revisionId ? { revisionId } : {}),
        ...(inspection ? { entityId: inspection.entityId, entityKind: inspection.entityKind } : {}),
        signal: controller.signal,
      } as const;
      const result = !inspection && capability.client.readProgressively
        ? await capability.client.readProgressively(graphRequest, (progress) => {
            if (!controller.signal.aborted
              && requestId === memberGraphRequest.current
              && state.activeMemberId === memberId
              && graphResultMatchesRequest(progress, graphRequest)) {
              setMemberContextGraph(progress);
            }
          })
        : await capability.client.read(graphRequest);
      if (controller.signal.aborted
        || requestId !== memberGraphRequest.current
        || state.activeMemberId !== memberId
        || !graphResultMatchesRequest(result, graphRequest)) return inspection ? "failed" : undefined;
      if (inspection) {
        const refreshed = memberContextGraph?.status === "ready"
          && result.status === "ready"
          && graphTopologyMatches(memberContextGraph.data, result.data);
        if (refreshed) setMemberContextGraph(result);
        return refreshed ? "refreshed" : result.status === "ready" ? "unchanged" : "failed";
      } else {
        setMemberContextGraph(result);
      }
    } catch {
      if (!inspection && !controller.signal.aborted && requestId === memberGraphRequest.current && state.activeMemberId === memberId) {
        setMemberContextGraph({ status: "unavailable", domain: "member-context", message: "Member context is unavailable." });
      }
      return inspection ? "failed" : undefined;
    } finally {
      if (memberGraphAbort.current === controller) {
        memberGraphAbort.current = null;
        if (!inspection) setMemberContextGraphLoading(false);
      }
    }
  }, [adapter, memberContextGraph, state.activeMemberId]);

  const expandMemberContextGraph = useCallback(() => {
    const memberId = state.activeMemberId;
    if (!memberId) return;
    setMemberContextGraphExpanded(true);
    void readMemberContextGraph(memberId);
  }, [readMemberContextGraph, state.activeMemberId]);

  const collapseMemberContextGraph = useCallback(() => {
    clearMemberContextGraph();
  }, [clearMemberContextGraph]);

  const inspectMovementGraph = useCallback(async (input: GraphInspectionRequest): Promise<GraphInspectionOutcome> => {
    return await readMovementGraph(input.revisionId, input) ?? "failed";
  }, [readMovementGraph]);
  const inspectMemberContextGraph = useCallback((input: GraphInspectionRequest) => {
    return state.activeMemberId
      ? readMemberContextGraph(state.activeMemberId, input.revisionId, input).then((outcome) => outcome ?? "failed")
      : Promise.resolve<GraphInspectionOutcome>("failed");
  }, [readMemberContextGraph, state.activeMemberId]);

  const checkSession = useCallback(async () => {
    const capability = adapter.capabilities.session;
    if (!capability?.available) {
      setSessionState("authenticated");
      return;
    }
    sessionAbort.current?.abort();
    const controller = new AbortController();
    sessionAbort.current = controller;
    setSessionState("checking-session");
    try {
      const session = await capability.client.current({ signal: controller.signal });
      if (controller.signal.aborted) return;
      setSessionState(session ? "authenticated" : "signed-out");
    } catch {
      if (!controller.signal.aborted) setSessionState("unavailable");
    } finally {
      if (sessionAbort.current === controller) sessionAbort.current = null;
    }
  }, [adapter]);

  const signIn = useCallback(async () => {
    const capability = adapter.capabilities.session;
    if (!capability?.available) {
      setSessionState("authenticated");
      return;
    }
    setSessionState("signing-in");
    try {
      const session = await capability.client.signIn();
      if (!session) throw new Error("Session unavailable");
      clearMovementGraph();
      clearMemberContextGraph();
      dispatch({ type: "reset-session" });
      setLoadState({ status: "loading" });
      setSessionState("authenticated");
    } catch {
      setSessionState("unavailable");
    }
  }, [adapter, clearMemberContextGraph, clearMovementGraph]);

  function captureReturnFocus(fallback: string): string;
  function captureReturnFocus(fallback?: null): string | null;
  function captureReturnFocus(fallback: string | null = null) {
    if (!(document.activeElement instanceof HTMLElement)) return fallback;
    returnFocus.current = document.activeElement;
    const focusKey = document.activeElement.closest<HTMLElement>("[data-focus-key]")?.dataset.focusKey ?? fallback;
    returnFocusKey.current = focusKey;
    return focusKey;
  }

  const openScreen = (screen: NestedScreen, detailId?: string) => {
    clearMovementGraph();
    clearMemberContextGraph();
    const focusKey = captureReturnFocus(`${screen}-trigger`);
    if (screen === "insight") {
      dispatch({ type: "push-route", route: { id: "insight", detailId: detailId ?? "adherence", focusKey } });
      return;
    }
    dispatch({ type: "push-route", route: { id: screen, focusKey } });
  };

  const openSupportingContext = (answer: CopilotAnswerPacket, evidenceId: string) => {
    const atom = answer.evidence.atoms.find((candidate) => candidate.evidenceId === evidenceId);
    if (!atom || (atom.evidenceKind !== "message" && atom.evidenceKind !== "media-attachment")) return;
    let reference: CopilotSupportingContextReference;
    try {
      reference = createCopilotSupportingContextReference({
        schemaVersion: "copilot-supporting-context/v1",
        memberId: answer.memberId,
        contextRevisionId: answer.contextRevisionId,
        authority: answer.authority,
        answerId: answer.answerId,
        anchor: { kind: "conversation", evidenceId },
        evidenceAsOf: answer.evidenceAsOf,
        memberTimezone: answer.memberTimezone,
        window: calculateCalendarWindow({ evidenceAsOf: answer.evidenceAsOf, timezone: answer.memberTimezone, lookbackDays: 60 }),
        continuation: answer.continuation,
      });
    } catch {
      return;
    }
    clearMovementGraph();
    clearMemberContextGraph();
    const focusKey = captureReturnFocus(`supporting-context-${evidenceId}`);
    dispatch({ type: "push-route", route: { id: "history", focusKey, supportingContext: reference } });
  };

  const openDecisionPath = (decisionId: DashboardDecisionId) => {
    clearMovementGraph();
    clearMemberContextGraph();
    const focusKey = captureReturnFocus(`decision-${decisionId}`);
    dispatch({ type: "push-route", route: { id: "decision-path", decisionId, focusKey } });
  };

  const openDialog = (action: DashboardAction) => {
    captureReturnFocus();
    dispatch(action);
  };

  const clearOperationTimers = () => {
    if (adjustmentTimer.current !== null) window.clearTimeout(adjustmentTimer.current);
    adjustmentTimer.current = null;
  };

  const signOut = async () => {
    const capability = adapter.capabilities.session;
    sessionAbort.current?.abort();
    generationAbort.current?.abort();
    copilotAbort.current?.abort();
    conversationAbort.current?.abort();
    clearMovementGraph();
    clearMemberContextGraph();
    clearOperationTimers();
    try { await capability?.client.signOut(); } catch { /* local state still clears */ }
    dispatch({ type: "reset-session" });
    setLoadState(adapter.initialState);
    setSessionState("signed-out");
  };

  const stopCopilot = () => {
    copilotAbort.current?.abort();
    copilotAbort.current = null;
  };

  const stopGeneration = () => {
    generationAbort.current?.abort();
    generationAbort.current = null;
  };

  const stopConversation = () => {
    conversationAbort.current?.abort();
    conversationAbort.current = null;
  };

  const selectAthlete = (memberId: string) => {
    clearOperationTimers();
    stopCopilot();
    stopGeneration();
    stopConversation();
    clearMemberContextGraph();
    dispatch({ type: "select-athlete", memberId, focusKey: captureReturnFocus(`today-row-athlete-${memberId}`) });
  };

  const selectDestination = (destination: DashboardDestination) => {
    clearOperationTimers();
    stopCopilot();
    stopGeneration();
    stopConversation();
    clearMovementGraph();
    clearMemberContextGraph();
    suppressRouteFocusRestore.current = true;
    dispatch({ type: "select-destination", destination });
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-destination-heading="${destination}"]`)?.focus();
    });
  };

  const popRoute = () => {
    clearOperationTimers();
    stopCopilot();
    stopConversation();
    clearMovementGraph();
    clearMemberContextGraph();
    dispatch({ type: "pop-route" });
  };

  const requestAdjustment = () => {
    if (adjustmentTimer.current !== null || activeWorkflow?.pendingAdjustment) return;
    const memberId = state.activeMemberId;
    dispatch({ type: "request-adjustment" });
    adjustmentTimer.current = window.setTimeout(() => {
      const actor = loadState.status === "ready" ? loadState.data.coach.name : "Coach";
      dispatch({ type: "complete-adjustment", actor, memberId });
      adjustmentTimer.current = null;
    }, 500);
  };

  const submitCopilot = useCallback((input: CopilotQuestionInput, promptLabel: string, options: {
    continuation?: SignedCopilotContinuation;
  } = {}) => {
    const capability = adapter.capabilities.copilot;
    const memberId = state.activeMemberId;
    const workflow = memberId ? state.athleteStates[memberId] : null;
    if (!capability?.available || !memberId || !workflow || copilotAbort.current || workflow.copilot.pending || !capability.supportsMember(memberId)) return;
    const requestId = `copilot:${memberId}:${Date.now()}:${++copilotRequest.current}`;
    const controller = new AbortController();
    copilotAbort.current = controller;
    const request = { requestId, memberId, promptLabel, input, ...(options.continuation ? { continuation: options.continuation } : {}) };
    dispatch({ type: "request-copilot", request });
    void capability.client.request({
      ...request,
      requestedFor: state.selectedDate,
      signal: controller.signal,
    }).then((outcome) => {
      dispatch({ type: "complete-copilot", memberId, requestId, outcome });
    }).finally(() => {
      if (copilotAbort.current === controller) copilotAbort.current = null;
    });
  }, [adapter, state.activeMemberId, state.athleteStates, state.selectedDate]);

  const ask = (promptId: QuickPromptId) => {
    const prompt = prompts.find((item) => item.id === promptId);
    const apiPrompt = ({ brief: "morning-brief", adherence: "adherence", sleep: "sleep", change: "changes-since-last-week", churn: "churn-risk" } as const)[promptId];
    submitCopilot(
      { kind: "quick-prompt", promptId: apiPrompt },
      prompt?.label ?? promptId,
      activeWorkflow?.copilot.lastReadyAnswer ? { continuation: activeWorkflow.copilot.lastReadyAnswer.continuation } : {},
    );
  };

  const generateWorkout = (prompt: string, durationMinutes: number) => {
    const capability = adapter.capabilities.workoutGeneration;
    const memberId = state.activeMemberId;
    if (!capability?.available || !memberId) return;
    stopGeneration();
    const previous = generationInput.current.get(memberId);
    const sameRequest = previous?.prompt === prompt && previous.durationMinutes === durationMinutes;
    const idempotencyKey = sameRequest
      ? previous.idempotencyKey
      : `dashboard:${memberId}:${Date.now()}:${generationRequest.current + 1}`;
    generationInput.current.set(memberId, { prompt, durationMinutes, idempotencyKey });
    const requestId = `dashboard-request:${++generationRequest.current}`;
    const controller = new AbortController();
    generationAbort.current = controller;
    dispatch({ type: "request-workout-generation", requestId });
    void capability.runtime.generate(
      { memberId, prompt, durationMinutes, idempotencyKey, signal: controller.signal },
      (update) => {
        if (update.status === "completed") {
          dispatch({ type: "complete-workout-generation", memberId, requestId, projection: update.projection });
          return;
        }
        dispatch({
          type: "update-workout-generation",
          memberId,
          requestId,
          status: update.status,
          message: update.message,
          ...("runId" in update && update.runId ? { runId: update.runId } : {}),
        });
      },
    ).finally(() => {
      if (generationAbort.current === controller) generationAbort.current = null;
    });
  };

  const retryWorkoutGeneration = () => {
    const memberId = state.activeMemberId;
    const input = memberId ? generationInput.current.get(memberId) : undefined;
    if (input) generateWorkout(input.prompt, input.durationMinutes);
  };

  useEffect(() => () => {
    if (adjustmentTimer.current !== null) window.clearTimeout(adjustmentTimer.current);
    if (focusFrame.current !== null) window.cancelAnimationFrame(focusFrame.current);
    generationAbort.current?.abort();
    copilotAbort.current?.abort();
    conversationAbort.current?.abort();
    fullGraphAbort.current?.abort();
    memberGraphAbort.current?.abort();
  }, []);

  useEffect(() => {
    const capability = adapter.capabilities.copilot;
    if (!capability?.available || currentRoute?.id !== "brief" || !state.activeMemberId || !activeWorkflow) return;
    if (!capability.supportsMember(state.activeMemberId) || activeWorkflow.copilot.pending || activeWorkflow.copilot.answers.length > 0 || activeWorkflow.copilot.outcome) return;
    submitCopilot({ kind: "quick-prompt", promptId: "morning-brief" }, "Morning brief");
  }, [activeWorkflow, adapter.capabilities.copilot, currentRoute?.id, state.activeMemberId, submitCopilot]);

  useEffect(() => {
    if (sessionState !== "authenticated") return;
    let active = true;
    queueMicrotask(() => {
      if (active) void load();
    });
    return () => {
      active = false;
      loadRequest.current += 1;
    };
  }, [load, sessionState]);

  useEffect(() => {
    queueMicrotask(() => void checkSession());
    return () => sessionAbort.current?.abort();
  }, [checkSession]);

  useEffect(() => {
    if (workspace) dispatch({ type: "initialize-date", date: workspace.coachDayDate });
  }, [workspace]);

  useEffect(() => {
    const capability = adapter.capabilities.conversation;
    const memberId = state.activeMemberId;
    const workflow = memberId ? state.athleteStates[memberId] : null;
    const supportingContext = currentRoute?.id === "history" ? currentRoute.supportingContext : undefined;
    const sameReference = workflow?.conversation.reference?.answerId === supportingContext?.answerId
      && workflow?.conversation.reference?.anchor.evidenceId === supportingContext?.anchor.evidenceId
      && workflow?.conversation.reference?.contextRevisionId === supportingContext?.contextRevisionId;
    if (!capability?.available || !memberId || currentRoute?.id !== "history" || !workflow
      || (workflow.conversation.status === "loading" && sameReference)
      || (workflow.conversation.status === "ready" && sameReference)) return;
    const controller = new AbortController();
    conversationAbort.current = controller;
    const requestId = `conversation:${memberId}:${Date.now()}:${++conversationRequest.current}`;
    const selectedTimestamp = Date.parse(`${state.selectedDate || new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const window = supportingContext?.window ?? {
      fromInclusive: new Date((Number.isFinite(selectedTimestamp) ? selectedTimestamp : Date.now()) - 60 * 24 * 60 * 60 * 1_000).toISOString(),
      toExclusive: new Date((Number.isFinite(selectedTimestamp) ? selectedTimestamp : Date.now()) + 24 * 60 * 60 * 1_000).toISOString(),
    };
    dispatch({ type: "request-conversation", memberId, requestId, ...(supportingContext ? { reference: supportingContext } : {}) });
    void capability.client.load({
      requestId,
      memberId,
      window,
      ...(supportingContext?.contextRevisionId ? { contextRevisionId: supportingContext.contextRevisionId } : {}),
      ...(supportingContext ? { supportingContext } : {}),
      signal: controller.signal,
    })
      .then((outcome) => dispatch({ type: "complete-conversation", memberId, requestId, outcome }))
      .finally(() => {
        if (conversationAbort.current === controller) conversationAbort.current = null;
      });
  }, [adapter, currentRoute, state.activeMemberId, state.athleteStates, state.selectedDate]);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    const previous = previousRoutes.current;
    if (state.routeStack.length < previous.length && suppressRouteFocusRestore.current) {
      suppressRouteFocusRestore.current = false;
    } else if (state.routeStack.length < previous.length) {
      const focusKey = previous.at(-1)?.focusKey;
      if (focusKey) {
        if (focusFrame.current !== null) window.cancelAnimationFrame(focusFrame.current);
        focusFrame.current = window.requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
          focusFrame.current = null;
        });
      }
    }
    previousRoutes.current = state.routeStack;
  }, [state.routeStack]);

  useLayoutEffect(() => {
    if (dialogOpen && !dialogWasOpen.current && document.activeElement instanceof HTMLElement) {
      returnFocus.current ??= document.activeElement;
      returnFocusKey.current ??= document.activeElement.closest<HTMLElement>("[data-focus-key]")?.dataset.focusKey ?? null;
    }
    if (!dialogOpen && dialogWasOpen.current) {
      if (focusFrame.current !== null) window.cancelAnimationFrame(focusFrame.current);
      focusFrame.current = window.requestAnimationFrame(() => {
        const original = returnFocus.current;
        const key = returnFocusKey.current;
        const equivalent = key
          ? document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`)
          : null;
        (original?.isConnected ? original : equivalent)?.focus();
        focusFrame.current = null;
        returnFocus.current = null;
        returnFocusKey.current = null;
      });
    }
    dialogWasOpen.current = dialogOpen;
  }, [dialogOpen]);

  if (sessionState !== "authenticated") {
    return <SessionGate status={sessionState} onSignIn={signIn} onRetry={checkSession} />;
  }

  if (loadState.status !== "ready") {
    return (
      <main className={styles.desk}>
        <div className={`${styles.app} ${styles.loadPanel}`} data-testid="coach-dashboard">
          <div className={styles.micro}>COACH DASHBOARD</div>
          <h1 className={styles.heroTitle}>
            {loadState.status === "loading" ? "Loading member context…" : loadState.message}
          </h1>
          {loadState.status === "error" && loadState.retryable && (
            <button className={styles.secondaryButton} type="button" onClick={() => {
              setLoadState({ status: "loading" });
              setAdapterAnnouncement("Loading dashboard data.");
              void load();
            }}>Try again</button>
          )}
          <div className={styles.srOnly} role="status" aria-live="polite">{adapterAnnouncement}</div>
        </div>
      </main>
    );
  }

  const dashboardContent = state.destination === "coach"
    ? <CoachScreen
      workspace={loadState.data.workspace}
      fullGraph={movementGraph}
      fullGraphExpanded={movementGraphExpanded}
      fullGraphLoading={movementGraphLoading}
      fullGraphUnavailableReason={adapter.capabilities.fullGraph?.available === false ? adapter.capabilities.fullGraph.reason : undefined}
      onExpandFullGraph={expandMovementGraph}
      onCollapseFullGraph={collapseMovementGraph}
      onRetryFullGraph={() => { void readMovementGraph(); }}
      onInspectFullGraph={inspectMovementGraph}
    />
    : activeMember && activeWorkflow && currentRoute
      ? (
        <AthleteRouteScreen
          route={currentRoute}
          workflow={activeWorkflow}
          selectedDate={state.selectedDate}
          dispatch={dispatch}
          onBack={popRoute}
          currentVersion={currentVersion}
          published={published}
          ask={ask}
          submitCopilot={submitCopilot}
          openScreen={openScreen}
          openSupportingContext={openSupportingContext}
          openDecisionPath={openDecisionPath}
          openDialog={openDialog}
          workoutGenerationAvailable={adapter.capabilities.workoutGeneration?.available === true}
          generateWorkout={generateWorkout}
          retryWorkoutGeneration={retryWorkoutGeneration}
          conversationAvailable={adapter.capabilities.conversation?.available === true}
          copilotAvailable={adapter.capabilities.copilot?.available === true && adapter.capabilities.copilot.supportsMember(state.activeMemberId!)}
          movementGraph={movementGraph}
          movementGraphExpanded={movementGraphExpanded}
          movementGraphLoading={movementGraphLoading}
          movementGraphUnavailableReason={adapter.capabilities.fullGraph?.available === false ? adapter.capabilities.fullGraph.reason : undefined}
          onExpandMovementGraph={expandMovementGraph}
          onCollapseMovementGraph={collapseMovementGraph}
          onRetryMovementGraph={() => { void readMovementGraph(); }}
          onInspectMovementGraph={inspectMovementGraph}
          memberContextGraph={memberContextGraphMemberId === state.activeMemberId ? memberContextGraph : null}
          memberContextGraphExpanded={memberContextGraphExpanded}
          memberContextGraphLoading={memberContextGraphLoading}
          memberContextGraphUnavailableReason={adapter.capabilities.fullGraph?.available === false ? adapter.capabilities.fullGraph.reason : undefined}
          onExpandMemberContextGraph={expandMemberContextGraph}
          onCollapseMemberContextGraph={collapseMemberContextGraph}
          onRetryMemberContextGraph={() => {
            if (state.activeMemberId) void readMemberContextGraph(state.activeMemberId);
          }}
          onInspectMemberContextGraph={inspectMemberContextGraph}
        />
      )
      : <CoachDayWorkspace workspace={loadState.data.workspace} state={state} dispatch={dispatch} onSelectAthlete={selectAthlete} />;

  return (
    <DashboardViewModelContext.Provider value={projectedMember}>
      <main className={styles.desk}>
        <div className={styles.app} data-testid="coach-dashboard">
          {isDesktop ? (
            <div className={styles.desktopLayout} data-testid="desktop-dashboard">
              <div className={styles.desktopNavRow}>
                <DashboardNavigation state={state} onSelect={selectDestination} disabled={dialogOpen} />
                <div className={styles.desktopNavMeta}>AXON COACH WORKSPACE · SYNTHETIC DEMO <button className={styles.inlineButton} type="button" onClick={() => void signOut}>Sign out</button></div>
              </div>
              <div className={styles.desktopMain}>
                <section className={styles.desktopContent} aria-label="Coach dashboard content">{dashboardContent}</section>
              </div>
            </div>
          ) : (
            <div className={styles.mobileLayout}>
              {dashboardContent}
              <DashboardNavigation state={state} onSelect={selectDestination} variant="mobile" disabled={dialogOpen} />
            </div>
          )}
          <div className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
            {state.announcement} {adapterAnnouncement}
          </div>
          {state.dialog && activeWorkflow && <DashboardDialog state={state} workflow={activeWorkflow} dispatch={dispatch} onRequestAdjustment={requestAdjustment} />}
        </div>
      </main>
    </DashboardViewModelContext.Provider>
  );
}

function SessionGate({
  status,
  onSignIn,
  onRetry,
}: {
  status: "checking-session" | "signed-out" | "signing-in" | "authenticated" | "expired" | "unavailable";
  onSignIn: () => void;
  onRetry: () => void;
}) {
  const checking = status === "checking-session" || status === "signing-in";
  const unavailable = status === "unavailable";
  return (
    <main className={styles.desk}>
      <section className={`${styles.app} ${styles.loadPanel}`} data-testid="coach-session-gate" aria-labelledby="coach-session-title">
        <div className={styles.micro}>AXON COACH WORKSPACE · MOCK AUTH</div>
        <h1 id="coach-session-title" className={styles.heroTitle}>
          {checking ? "Checking coach session…" : unavailable ? "Coach session is unavailable" : status === "expired" ? "Your session expired" : "Sign in to continue"}
        </h1>
        <p className={styles.bodyCopy}>
          {checking ? "Your browser session is being verified." : unavailable ? "The demo session service did not respond. Try again when it is available." : "Use the explicit demo coach session to open the synthetic workspace."}
        </p>
        {checking ? <div className={styles.srOnly} role="status" aria-live="polite">Checking session.</div> : unavailable ? (
          <button className={styles.secondaryButton} type="button" onClick={onRetry}>Retry session check</button>
        ) : (
          <button className={styles.primaryButton} type="button" onClick={() => void onSignIn()} autoFocus>
            Continue as demo coach
          </button>
        )}
      </section>
    </main>
  );
}

const coachDateFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});
const coachWeekdayFormatter = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
const coachMonthDayFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const sessionTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function formatCoachDate(value: string) {
  return coachDateFormatter.format(new Date(`${value}T00:00:00Z`));
}

function formatMemberDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return {
    weekday: coachWeekdayFormatter.format(date).toUpperCase(),
    monthDay: coachMonthDayFormatter.format(date).toUpperCase(),
  };
}

function formatSessionTime(value: string, timeZone: string) {
  let formatter = sessionTimeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
    });
    sessionTimeFormatters.set(timeZone, formatter);
  }
  return formatter.format(new Date(value));
}

function weekAround(value: string) {
  const anchor = new Date(`${value}T00:00:00Z`);
  const day = anchor.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(anchor);
    date.setUTCDate(anchor.getUTCDate() + mondayOffset + index);
    return date.toISOString().slice(0, 10);
  });
}

function CoachDayWorkspace({ workspace, state, dispatch, onSelectAthlete }: {
  workspace: CoachDashboardWorkspace;
  state: DashboardState;
  dispatch: React.Dispatch<DashboardAction>;
  onSelectAthlete: (memberId: string) => void;
}) {
  const selectedDate = state.selectedDate || workspace.coachDayDate;
  const projection = useMemo(
    () => buildTodayProjection(workspace, selectedDate),
    [selectedDate, workspace],
  );
  const week = useMemo(() => weekAround(selectedDate), [selectedDate]);
  const sessionCountByDate = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of workspace.sessions) {
      const date = sessionDateKey(session.startsAt, workspace.timezone);
      counts.set(date, (counts.get(date) ?? 0) + 1);
    }
    return counts;
  }, [workspace.sessions, workspace.timezone]);
  const scheduledAthleteIds = useMemo(
    () => new Set(projection.scheduledAthletes.map(({ athlete }) => athlete.id)),
    [projection.scheduledAthletes],
  );

  return (
    <section className={styles.coachDay} data-testid="coach-day-workspace" aria-label="Today overview">
      <header className={styles.coachDayHeader}>
        <div>
          <div className={styles.micro}>TODAY · COACH DAY OVERVIEW</div>
          <h1 className={styles.coachDayTitle} data-destination-heading="today" tabIndex={-1}>Good morning, {workspace.coach.name}</h1>
          <p className={styles.coachDayIntro}>Choose a day, then open an athlete’s morning brief.</p>
        </div>
        <div className={styles.coachDayHeaderMark} aria-hidden="true">AXON / 01</div>
      </header>

      <section className={styles.weekStrip} data-testid="today-calendar" aria-labelledby="coach-day-week-title">
        <div className={styles.weekStripHeader}>
          <div>
            <div className={styles.micro}>CALENDAR</div>
            <h2 id="coach-day-week-title" className={styles.coachDaySectionTitle}>{formatCoachDate(selectedDate)}</h2>
          </div>
          <span className={styles.weekStripNote}>Read-only calendar</span>
        </div>
        <div className={styles.weekDays} role="group" aria-label="Choose a day to view sessions">
          {week.map((day) => {
            const daySessionCount = sessionCountByDate.get(day) ?? 0;
            const active = day === selectedDate;
            return (
              <button
                className={`${styles.weekDay} ${active ? styles.weekDayActive : ""}`}
                data-testid={`week-day-${day}`}
                key={day}
                type="button"
                aria-pressed={active}
                aria-label={`Show sessions for ${formatCoachDate(day)}${daySessionCount ? `, ${daySessionCount} scheduled` : ", no sessions scheduled"}`}
                onClick={() => dispatch({ type: "select-date", date: day })}
              >
                <span>{coachWeekdayFormatter.format(new Date(`${day}T00:00:00Z`))}</span>
                <strong>{Number(day.slice(8, 10))}</strong>
                <i className={daySessionCount ? styles.weekDayDot : ""} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </section>

      <section className={styles.rosterPanel} data-testid="today-athlete-row" aria-labelledby="today-athletes-title">
        <div className={styles.coachDaySectionHeader}>
          <div><div className={styles.micro}>TODAY’S ATHLETES</div><h2 id="today-athletes-title" className={styles.coachDaySectionTitle}>Today’s roster</h2></div>
          <span className={styles.coachDayCount}>{projection.scheduledAthletes.length} scheduled</span>
        </div>
        {projection.scheduledAthletes.length ? (
          <div className={`${styles.rosterList} ${styles.todayAthleteList}`} data-testid="today-athletes-list">
            {projection.scheduledAthletes.map(({ athlete, firstSession }) => (
              <button className={`${styles.athleteCard} ${styles.todayAthleteCard}`} data-focus-key={`today-row-athlete-${athlete.id}`} data-testid={`today-athlete-card-${athlete.id}`} key={athlete.id} type="button" onClick={() => onSelectAthlete(athlete.id)} aria-label={`Open ${athlete.name} morning brief`}>
                <span className={styles.athleteAvatar} aria-hidden="true">{athlete.initials}</span>
                <span className={styles.athleteCardBody}><strong>{athlete.name}</strong><span>{athlete.suggestedWorkoutTitle} · {formatSessionTime(firstSession.startsAt, workspace.timezone)} · {firstSession.durationMinutes} min</span></span>
                <span className={styles.sessionArrow} aria-hidden="true">→</span>
              </button>
            ))}
          </div>
        ) : <div className={styles.rosterEmpty} data-testid="athletes-empty"><strong>No athletes scheduled</strong><span>The full roster is listed below.</span></div>}
        <div className={styles.allAthletesHeader}>
          <div><div className={styles.micro}>ALL ATHLETES</div><h2 className={styles.coachDaySectionTitle}>Full roster</h2></div>
          <span className={styles.coachDayCount}>{workspace.athletes.length} total</span>
        </div>
        <div id="all-athletes-list" className={styles.rosterList}>
          {workspace.athletes.filter((athlete) => !scheduledAthleteIds.has(athlete.id)).map((athlete) => <button className={styles.athleteCard} data-focus-key={`today-all-athlete-${athlete.id}`} data-testid={`athlete-card-${athlete.id}`} key={athlete.id} type="button" onClick={() => onSelectAthlete(athlete.id)} aria-label={`Open ${athlete.name} morning brief`}>
            <span className={styles.athleteAvatar} aria-hidden="true">{athlete.initials}</span>
            <span className={styles.athleteCardBody}><strong>{athlete.name}</strong><span>{athlete.suggestedWorkoutTitle}</span></span>
            <span className={styles.athleteAdherence}>{athlete.adherence}<small>adherence</small></span>
          </button>)}
        </div>
      </section>

    </section>
  );
}

function CoachScreen({
  workspace,
  fullGraph,
  fullGraphExpanded,
  fullGraphLoading,
  fullGraphUnavailableReason,
  onExpandFullGraph,
  onCollapseFullGraph,
  onRetryFullGraph,
  onInspectFullGraph,
}: {
  workspace: CoachDashboardWorkspace;
  fullGraph: FullGraphReadResult | null;
  fullGraphExpanded: boolean;
  fullGraphLoading: boolean;
  fullGraphUnavailableReason?: string;
  onExpandFullGraph: () => void;
  onCollapseFullGraph: () => void;
  onRetryFullGraph: () => void;
  onInspectFullGraph: (input: GraphInspectionRequest) => Promise<GraphInspectionOutcome>;
}) {
  return <section className={`${styles.coachDay} ${styles.stack}`} aria-label="Coach">
    <div><div className={styles.micro}>COACH · READ-ONLY WORKSPACE</div><h1 className={styles.coachDayTitle} data-destination-heading="coach" tabIndex={-1}>{workspace.coach.name}</h1><p className={styles.coachDayIntro}>Workspace identity and regional settings.</p></div>
    <div className={styles.card}><div className={styles.micro}>COACH IDENTITY</div><div className={styles.bodyStrong}>{workspace.coach.name}</div></div>
    <div className={styles.card}><div className={styles.micro}>WORKSPACE TIMEZONE</div><div className={styles.bodyStrong}>{workspace.timezone}</div><div className={styles.bodyCopy}>Used to group sessions into coach-local calendar days.</div></div>
    <FullGraphExplorer
      domain="movement-clinical"
      focusedLanes={[
        { name: "FOCUS", text: "Exercises, anatomy, movement demands, and clinical rules stay in the coach’s focused explanation.", source: "MOVEMENT KNOWLEDGE GRAPH · FOCUSED VIEW" },
        { name: "DETAIL", text: "Expand when you want to inspect every node, relationship, revision, and source assertion.", source: "READ ONLY · SOURCE / PROVENANCE DETAILS" },
      ]}
      fullGraph={fullGraph}
      expanded={fullGraphExpanded}
      loading={fullGraphLoading}
      unavailableReason={fullGraphUnavailableReason}
      onExpand={onExpandFullGraph}
      onCollapse={onCollapseFullGraph}
      onRetry={onRetryFullGraph}
      onInspect={onInspectFullGraph}
    />
    <div className={styles.subtle}>These settings are read-only in this dashboard.</div>
  </section>;
}

function AthleteRouteScreen({ route, workflow, selectedDate, dispatch, onBack, currentVersion, published, ask, submitCopilot, openScreen, openSupportingContext, openDecisionPath, openDialog, workoutGenerationAvailable, generateWorkout, retryWorkoutGeneration, copilotAvailable, conversationAvailable, movementGraph, movementGraphExpanded, movementGraphLoading, movementGraphUnavailableReason, onExpandMovementGraph, onCollapseMovementGraph, onRetryMovementGraph, onInspectMovementGraph, memberContextGraph, memberContextGraphExpanded, memberContextGraphLoading, memberContextGraphUnavailableReason, onExpandMemberContextGraph, onCollapseMemberContextGraph, onRetryMemberContextGraph, onInspectMemberContextGraph }: {
  route: AthleteRoute;
  workflow: AthleteWorkflowState;
  selectedDate: string;
  dispatch: React.Dispatch<DashboardAction>;
  onBack: () => void;
  currentVersion: WorkoutVersion;
  published: boolean;
  ask: (id: QuickPromptId) => void;
  submitCopilot: (input: CopilotQuestionInput, promptLabel: string, options?: { continuation?: SignedCopilotContinuation }) => void;
  openScreen: (screen: NestedScreen, detailId?: string) => void;
  openSupportingContext: (answer: CopilotAnswerPacket, evidenceId: string) => void;
  openDecisionPath: (decisionId: DashboardDecisionId) => void;
  openDialog: (action: DashboardAction) => void;
  workoutGenerationAvailable: boolean;
  generateWorkout: (prompt: string, durationMinutes: number) => void;
  retryWorkoutGeneration: () => void;
  copilotAvailable: boolean;
  conversationAvailable: boolean;
  movementGraph: FullGraphReadResult | null;
  movementGraphExpanded: boolean;
  movementGraphLoading: boolean;
  movementGraphUnavailableReason?: string;
  onExpandMovementGraph: () => void;
  onCollapseMovementGraph: () => void;
  onRetryMovementGraph: () => void;
  onInspectMovementGraph: (input: GraphInspectionRequest) => Promise<GraphInspectionOutcome>;
  memberContextGraph: FullGraphReadResult | null;
  memberContextGraphExpanded: boolean;
  memberContextGraphLoading: boolean;
  memberContextGraphUnavailableReason?: string;
  onExpandMemberContextGraph: () => void;
  onCollapseMemberContextGraph: () => void;
  onRetryMemberContextGraph: () => void;
  onInspectMemberContextGraph: (input: GraphInspectionRequest) => Promise<GraphInspectionOutcome>;
}) {
  if (route.id === "brief") return <><MemberHeader selectedDate={selectedDate} onBack={onBack} /><TodayScreen selectedDate={selectedDate} state={workflow} currentVersion={currentVersion} published={published} ask={ask} openScreen={openScreen} copilotAvailable={copilotAvailable} /></>;
  if (route.id === "workout") return <WorkoutScreen workflow={workflow} currentVersion={currentVersion} published={published} openScreen={openScreen} openDecisionPath={openDecisionPath} openDialog={openDialog} onBack={onBack} workoutGenerationAvailable={workoutGenerationAvailable} generateWorkout={generateWorkout} retryWorkoutGeneration={retryWorkoutGeneration} />;
  if (route.id === "copilot") return <><ScreenHeader title="Copilot" kicker="MEMBER CONTEXT · ROUTE-BACKED" onBack={onBack} /><CopilotScreen state={workflow} dispatch={dispatch} ask={ask} submit={submitCopilot} openSupportingContext={openSupportingContext} selectedDate={selectedDate} copilotAvailable={copilotAvailable} /></>;
  if (route.id === "history") return <><ScreenHeader title="History" kicker="PROFILE · MEMBER ACTIVITY" onBack={onBack} /><HistoryScreen state={workflow} conversationAvailable={conversationAvailable} supportingContext={route.supportingContext ?? null} /></>;
  if (route.id === "profile") return <ProfileScreen onBack={onBack} onOpenDecisionPath={openDecisionPath} onOpenHistory={() => openScreen("history")} memberContextGraph={memberContextGraph} memberContextGraphExpanded={memberContextGraphExpanded} memberContextGraphLoading={memberContextGraphLoading} memberContextGraphUnavailableReason={memberContextGraphUnavailableReason} onExpandMemberContextGraph={onExpandMemberContextGraph} onCollapseMemberContextGraph={onCollapseMemberContextGraph} onRetryMemberContextGraph={onRetryMemberContextGraph} onInspectMemberContextGraph={onInspectMemberContextGraph} />;
  if (route.id === "decision-path") return <DecisionPathScreen
    decisionId={route.decisionId}
    state={workflow}
    onBack={onBack}
    movementGraph={movementGraph}
    movementGraphExpanded={movementGraphExpanded}
    movementGraphLoading={movementGraphLoading}
    movementGraphUnavailableReason={movementGraphUnavailableReason}
    onExpandMovementGraph={onExpandMovementGraph}
    onCollapseMovementGraph={onCollapseMovementGraph}
    onRetryMovementGraph={onRetryMovementGraph}
    onInspectMovementGraph={onInspectMovementGraph}
  />;
  if (route.id === "insight") return <InsightScreen detailId={route.detailId} state={workflow} onBack={onBack} />;
  if (route.id === "approve") return <ApproveScreen currentVersion={currentVersion} published={published} dispatch={dispatch} onBack={onBack} />;
  if (route.id === "workout-rationale") return <WorkoutRationaleScreen onBack={onBack} openDecisionPath={openDecisionPath} />;
  return null;
}

function DashboardNavigation({ state, onSelect, variant = "desktop", disabled = false }: {
  state: DashboardState;
  onSelect: (destination: DashboardDestination) => void;
  variant?: "mobile" | "desktop";
  disabled?: boolean;
}) {
  const navRef = useRef<HTMLElement>(null);
  const [pill, setPill] = useState({ left: 0, width: 0, ready: false });
  const activeDestination = state.destination;

  useLayoutEffect(() => {
    if (variant === "mobile") return;
    const nav = navRef.current;
    if (!nav) return;

    const syncPill = () => {
      const active = nav.querySelector<HTMLElement>('[aria-current="page"]');
      if (!active) return;
      const left = active.offsetLeft;
      const width = active.offsetWidth;
      setPill((previous) => previous.ready && previous.left === left && previous.width === width
        ? previous
        : { left, width, ready: true });
    };

    syncPill();
    const observer = new ResizeObserver(syncPill);
    observer.observe(nav);
    window.addEventListener("resize", syncPill);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncPill);
    };
  }, [activeDestination, variant]);

  return (
    <nav ref={navRef} className={`${styles.tabs} ${variant === "mobile" ? styles.mobileTabs : ""}`} aria-label="Dashboard sections">
      {variant === "desktop" && (
        <div
          className={`${styles.tabPill} ${pill.ready ? styles.tabPillReady : ""}`}
          style={{ transform: `translateX(${pill.left}px)`, width: pill.width }}
          aria-hidden="true"
        />
      )}
      {destinations.map((destination) => (
        <button
          key={destination.id}
          className={`${styles.tab} ${activeDestination === destination.id ? styles.tabActive : ""}`}
          type="button"
          disabled={disabled}
          aria-current={activeDestination === destination.id ? "page" : undefined}
          onClick={() => onSelect(destination.id)}
        >
          {destination.label}
        </button>
      ))}
    </nav>
  );
}

function MemberHeader({ selectedDate, onBack }: { selectedDate: string; onBack: () => void }) {
  const displayDate = formatMemberDate(selectedDate);
  return (
    <header className={styles.memberHeader}>
      <button className={styles.backButton} type="button" onClick={onBack} aria-label="Go back">←</button>
      <div className={styles.date} data-testid="member-brief-date">{displayDate.weekday}<br />{displayDate.monthDay}</div>
    </header>
  );
}

function MemberSummary() {
  const fixture = useDashboardViewModel();
  return (
    <article className={styles.memberSummary} data-testid="member-brief-summary" aria-label={`${fixture.member.name} member information`}>
      <span className={styles.avatar} aria-hidden="true">{fixture.member.initials}</span>
      <span className={styles.memberSummaryCopy}>
        <strong className={styles.memberName}>{fixture.member.name}</strong>
        <span className={styles.micro}>{fixture.member.tier} · {fixture.member.trainingDaysPerWeek} days/wk</span>
      </span>
    </article>
  );
}

function TodayScreen({
  selectedDate,
  state,
  currentVersion,
  published,
  ask,
  openScreen,
  copilotAvailable,
}: {
  selectedDate: string;
  state: AthleteWorkflowState;
  currentVersion: WorkoutVersion;
  published: boolean;
  ask: (id: QuickPromptId) => void;
  openScreen: (screen: NestedScreen, detailId?: string) => void;
  copilotAvailable: boolean;
}) {
  const fixture = useDashboardViewModel();
  const briefAnswer = state.copilot.answers.findLast((answer) => answer.intentId === "morning-brief") ?? null;
  const briefPending = state.copilot.pending?.input.kind === "quick-prompt" && state.copilot.pending.input.promptId === "morning-brief";
  const lastRequestWasMorningBrief = state.copilot.lastRequest?.input.kind === "quick-prompt" && state.copilot.lastRequest.input.promptId === "morning-brief";
  const briefOutcome = lastRequestWasMorningBrief ? state.copilot.outcome : null;
  return (
    <section className={`${styles.scroll} ${styles.stack} ${styles.todayScreen}`} aria-label="Today">
      <MemberSummary />
      <button className={styles.heroCard} type="button" data-focus-key="brief-workout" onClick={() => openScreen("workout")} style={{ textAlign: "left", cursor: "pointer" }}>
        <div className={styles.micro}>{published ? "PUBLISHED ✓" : `DRAFT FOR ${formatCoachDate(selectedDate).toUpperCase()} · READY`}</div>
        <h1 className={styles.heroTitle}>{published ? "Local publication recorded" : `${currentVersion.durationMinutes}-min ${fixture.workoutTitle}`}</h1>
        <div className={styles.subtle}>{published ? `Exact approved v${currentVersion.number} · history retained` : `3 constraint decisions · warm-up to cool-down sized to ${currentVersion.durationMinutes} min`}</div>
        <span className={styles.heroAction}>{published ? "View published workout →" : "Review & approve →"}</span>
      </button>

      <div className={styles.sectionLabel}>MORNING BRIEF TOOLS</div>
      <div className={styles.rosterList}>
        <button className={styles.athleteCard} type="button" data-focus-key="brief-copilot" onClick={() => openScreen("copilot")}>
          <span className={styles.athleteAvatar} aria-hidden="true">AI</span><span className={styles.athleteCardBody}><strong>Copilot context</strong><span>{copilotAvailable ? briefAnswer ? "Graph-grounded context ready" : "Loading graph-grounded context" : "Member context unavailable"}</span></span><span className={styles.sessionArrow} aria-hidden="true">→</span>
        </button>
        <button className={styles.athleteCard} type="button" data-focus-key="brief-profile" onClick={() => openScreen("profile")}>
          <span className={styles.athleteAvatar} aria-hidden="true">{fixture.member.initials}</span><span className={styles.athleteCardBody}><strong>Athlete profile</strong><span>Injury, goals, preferences, and equipment</span></span><span className={styles.sessionArrow} aria-hidden="true">→</span>
        </button>
        <button className={styles.athleteCard} type="button" data-focus-key="brief-history" onClick={() => openScreen("history")}>
          <span className={styles.athleteAvatar} aria-hidden="true">↻</span><span className={styles.athleteCardBody}><strong>History</strong><span>Workout versions, publications, and sessions</span></span><span className={styles.sessionArrow} aria-hidden="true">→</span>
        </button>
      </div>

      {state.copilot.pins.map((pin) => <article key={pin.pinId} className={styles.card} data-answer-id={pin.answerId}>
        <div className={styles.micro}>PINNED · COPILOT · {pin.contextRevisionId}</div>
        {pin.renderedSnapshot.section.clauses.map((clause) => <div className={styles.bodyStrong} key={clause.clauseId}>{clause.text}</div>)}
      </article>)}

      <div className={styles.sectionLabel}>MORNING BRIEF</div>
      {!copilotAvailable ? <CopilotUnavailable memberName={fixture.member.name} /> : briefPending && !briefAnswer ? <div className={styles.card}><SignalKicker working>Loading morning brief…</SignalKicker><div className={styles.bodyCopy}>Retrieving one revision-pinned answer packet.</div></div> : briefAnswer ? <>
        <CopilotAnswerCard answer={briefAnswer} presentation="workbench" />
        {briefPending && <div className={styles.capabilityNote} role="status" aria-live="polite"><SignalKicker working>Updating morning brief…</SignalKicker><span>Showing the previous revision-pinned brief until the update is ready.</span></div>}
        {briefOutcome && briefOutcome.status !== "ready" && briefOutcome.status !== "cancelled" && <CopilotOutcomeNotice outcome={briefOutcome} />}
        {briefOutcome?.controls.retry && <button className={styles.secondaryButton} type="button" disabled={Boolean(state.copilot.pending)} onClick={() => ask("brief")}>Retry morning brief</button>}
      </> : briefOutcome && briefOutcome.status !== "ready" ? <>
        <CopilotOutcomeNotice outcome={briefOutcome} />
        {briefOutcome.controls.retry && <button className={styles.secondaryButton} type="button" disabled={Boolean(state.copilot.pending)} onClick={() => ask("brief")}>Retry morning brief</button>}
      </> : <div className={styles.card}><div className={styles.bodyStrong}>Morning brief not loaded.</div><div className={styles.bodyCopy}>Open Copilot to retry the graph-backed brief.</div></div>}
      {copilotAvailable && <button className={styles.secondaryButton} type="button" data-focus-key="brief-copilot-churn" disabled={state.copilot.pending !== null} onClick={() => { openScreen("copilot"); ask("churn"); }}>Ask Copilot about risk →</button>}
      <div className={styles.metrics}>
        {[['adherence', fixture.metrics.adherence, 'ADHERENCE WK'], ['sleep', fixture.metrics.sleep, 'SLEEP AVG 7D'], ['heart', fixture.metrics.restingHeartRate, 'RESTING HR']].map(([id, value, label]) => (
          <div className={styles.metric} key={id}><strong>{value}</strong><div className={styles.micro}>{label}</div></div>
        ))}
      </div>
    </section>
  );
}

function WorkoutScreen({ workflow, currentVersion, published, openScreen, openDecisionPath, openDialog, onBack, workoutGenerationAvailable, generateWorkout, retryWorkoutGeneration }: {
  workflow: AthleteWorkflowState;
  currentVersion: WorkoutVersion;
  published: boolean;
  openScreen: (screen: NestedScreen, detailId?: string) => void;
  openDecisionPath: (decisionId: DashboardDecisionId) => void;
  openDialog: (action: DashboardAction) => void;
  onBack?: () => void;
  workoutGenerationAvailable: boolean;
  generateWorkout: (prompt: string, durationMinutes: number) => void;
  retryWorkoutGeneration: () => void;
}) {
  const fixture = useDashboardViewModel();
  const [generationPrompt, setGenerationPrompt] = useState("");
  const [generationDuration, setGenerationDuration] = useState(currentVersion.durationMinutes);
  const generationPromptRef = useRef<HTMLTextAreaElement>(null);
  const runtimeBusy = ["submitting", "queued", "running"].includes(workflow.runtimeGeneration.status);
  const sections = fixture.workoutSections.map((section) => ({
    ...section,
    items: section.items.filter((item) => !(item.id === "bench-press" && currentVersion.durationMinutes <= 40)),
  }));
  const overriddenExclusion = currentVersion.overrideDecisionId
    ? fixture.exclusions.find((item) => item.decisionId === currentVersion.overrideDecisionId)
    : null;
  if (overriddenExclusion) {
    sections[1] = {
      ...sections[1],
      items: [...sections[1].items, {
        ...overriddenExclusion,
        name: overriddenExclusion.catalogName,
        why: `Included by ${fixture.coach.name}. Warning retained. Reason: “${currentVersion.overrideReason}”`,
        provenance: `PROV-O · OVERRIDE · ${fixture.coach.name.toUpperCase()}`,
      }],
    };
  }

  return (
    <section className={`${styles.scroll} ${styles.stack}`} aria-label="Workout">
      {onBack && <ScreenHeader title={fixture.workoutTitle} kicker={published ? "PUBLISHED WORKOUT" : "TODAY’S WORKOUT"} onBack={onBack} />}
      <div className={styles.workoutTopline}>
        <div><div className={styles.micro}>{published ? "PUBLISHED WORKOUT" : "TODAY’S WORKOUT"}</div><h1 className={styles.heroTitle}>{currentVersion.durationMinutes}-min {fixture.workoutTitle}</h1></div>
        <span className={styles.versionPill}>v{currentVersion.number}</span>
      </div>
      <div className={styles.subtle}>{sections.reduce((count, section) => count + section.items.length, 0)} exercises · {currentVersion.intensity} intensity · source-backed</div>
      {workoutGenerationAvailable && (
        <form className={styles.runtimeForm} aria-label="Generate workout" onSubmit={(event) => {
          event.preventDefault();
          const prompt = generationPrompt.trim();
          if (prompt) generateWorkout(prompt, generationDuration);
        }}>
          <label className={styles.runtimeField}>
            <span className={styles.bodyStrong}>Workout request</span>
            <textarea ref={generationPromptRef} className={styles.textarea} value={generationPrompt} disabled={runtimeBusy} onChange={(event) => setGenerationPrompt(event.target.value)} placeholder="Describe today’s workout…" required />
          </label>
          <label className={styles.runtimeField}>
            <span className={styles.bodyStrong}>Duration · {generationDuration} min</span>
            <input className={styles.range} aria-label="Generated workout duration" type="range" min="30" max="60" step="5" value={generationDuration} disabled={runtimeBusy} onChange={(event) => setGenerationDuration(Number(event.target.value))} />
          </label>
          <button className={styles.primaryButton} type="submit" disabled={runtimeBusy || !generationPrompt.trim()} aria-busy={runtimeBusy}>{runtimeBusy ? "Generating…" : "Generate workout"}</button>
        </form>
      )}
      {workflow.runtimeGeneration.status !== "idle" && (
        <div className={styles.runtimeStatus} data-runtime-status={workflow.runtimeGeneration.status}>
          <div className={styles.micro}>WORKOUT RUNTIME · {workflow.runtimeGeneration.status.replaceAll("-", " ").toUpperCase()}</div>
          <div className={styles.bodyStrong}>{workflow.runtimeGeneration.message}</div>
          {["awaiting-clarification", "no-safe-result", "failed", "canceled", "disconnected"].includes(workflow.runtimeGeneration.status) && (
            <button className={styles.secondaryButton} type="button" onClick={() => {
              if (workflow.runtimeGeneration.status === "awaiting-clarification" || workflow.runtimeGeneration.status === "no-safe-result") {
                generationPromptRef.current?.focus();
              } else {
                retryWorkoutGeneration();
              }
            }}>
              {workflow.runtimeGeneration.status === "awaiting-clarification" ? "Clarify request" : workflow.runtimeGeneration.status === "no-safe-result" ? "Revise request" : workflow.runtimeGeneration.status === "disconnected" ? "Reconnect" : "Try again"}
            </button>
          )}
        </div>
      )}
      <button className={styles.secondaryButton} type="button" data-focus-key="workout-rationale" onClick={() => openScreen("workout-rationale")}>Why this workout?</button>

      {sections.map((section) => (
        <div className={styles.workoutGroup} key={section.title}>
          <div className={styles.sectionLabel}>{section.title}</div>
          {section.items.map((item) => (
            <details className={styles.exercise} key={item.id}>
              <summary><span className={styles.exerciseName}>{item.name}</span><span className={styles.exerciseDose}>{item.dose}{item.rest ? ` · ${item.rest}` : ""}</span></summary>
              <div className={styles.exerciseDetail}>
                <div className={styles.bodyCopy}>{item.why}</div>
                <div className={styles.source}>{item.provenance}</div>
                {item.decisionId && <button className={styles.pillButton} type="button" data-focus-key={`decision-${item.decisionId}`} onClick={() => openDecisionPath(item.decisionId!)} style={{ marginTop: 10 }}>Decision path →</button>}
              </div>
            </details>
          ))}
        </div>
      ))}

      <div className={styles.sectionLabel}>EXCLUSIONS</div>
      <div className={styles.card}>
        {fixture.exclusions.filter((item) => item.decisionId !== currentVersion.overrideDecisionId).map((item) => (
          <div className={styles.exclusion} key={item.id}>
            <div className={styles.bodyStrong}>{item.catalogName}</div>
            <div className={styles.bodyCopy}>{item.reason}</div>
            <div className={styles.exclusionActions}>
              <button className={styles.pillButton} type="button" data-focus-key={`decision-${item.decisionId}`} onClick={() => openDecisionPath(item.decisionId)}>Decision path →</button>
              {item.overridable && !published && <button className={styles.pillButton} type="button" data-focus-key={`override-${item.decisionId}`} onClick={() => openDialog({ type: "open-override", decisionId: item.decisionId })}>Override</button>}
            </div>
          </div>
        ))}
      </div>

      {published ? (
        <div className={styles.publishedBanner}>✓ Local publication recorded for exact v{currentVersion.number} · no external delivery</div>
      ) : (
        <div className={styles.actionRow}>
          <button className={styles.secondaryButton} type="button" data-focus-key="adjust-workout" onClick={() => openDialog({ type: "open-adjustment" })}>Adjust</button>
          <button className={styles.primaryButton} type="button" data-focus-key="approve-workout" onClick={() => openScreen("approve")}>Approve & record locally</button>
        </div>
      )}
    </section>
  );
}

function CopilotScreen({ state, dispatch, ask, submit, openSupportingContext, selectedDate, copilotAvailable }: {
  state: AthleteWorkflowState;
  dispatch: React.Dispatch<DashboardAction>;
  ask: (id: QuickPromptId) => void;
  submit: (input: CopilotQuestionInput, promptLabel: string, options?: { continuation?: SignedCopilotContinuation }) => void;
  openSupportingContext: (answer: CopilotAnswerPacket, evidenceId: string) => void;
  selectedDate: string;
  copilotAvailable: boolean;
}) {
  const fixture = useDashboardViewModel();
  const [draftQuestion, setDraftQuestion] = useState("");
  const pending = state.copilot.pending;
  const continuation = state.copilot.lastReadyAnswer?.continuation;
  const lastRequest = state.copilot.lastRequest;
  const question = draftQuestion;
  const workbenchAnswers = state.copilot.answers.length > 0
    ? state.copilot.answers
    : state.copilot.lastReadyAnswer
      ? [state.copilot.lastReadyAnswer]
      : [];
  const workbench = buildCopilotWorkbenchViewModel(workbenchAnswers);
  const briefAnswer = state.copilot.answers.findLast((answer) => answer.intentId === "morning-brief") ?? state.copilot.lastReadyAnswer;
  const primaryFreshness = workbench.primary?.freshness ?? briefAnswer?.briefFreshness;
  const submitTypedQuestion = (event?: React.FormEvent) => {
    event?.preventDefault();
    const value = question.trim();
    if (!value || pending) return;
    submit({ kind: "free-text", question: value }, value, continuation ? { continuation } : {});
    setDraftQuestion("");
  };
  const retry = () => lastRequest && submit(lastRequest.input, lastRequest.promptLabel, lastRequest.continuation ? { continuation: lastRequest.continuation } : {});
  const refresh = () => lastRequest && submit(lastRequest.input, `${lastRequest.promptLabel} refresh`);
  const taskAction = (task: NonNullable<typeof briefAnswer>["tasks"][number]) => {
    const input: CopilotQuestionInput = task.actionId === "review-churn-risk"
      ? { kind: "quick-prompt", promptId: "churn-risk" }
      : { kind: "quick-prompt", promptId: "morning-brief" };
    submit(input, task.text, continuation ? { continuation } : {});
  };
  const freshness = primaryFreshness
    ? `${primaryFreshness.status === "latest-recorded" ? "Latest recorded" : "Requested date"} · ${formatCoachDate(primaryFreshness.generatedFor)}`
    : "Awaiting fresh context";
  const renderWorkbenchAnswer = (viewModel: CopilotAnswerViewModel) => {
    const answer = viewModel.answer;
    const section = viewModel.primarySections[0] ?? answer.sections.find((candidate) => candidate.clauses.length > 0);
    const pinId = `${answer.answerId}:${section?.sectionId ?? "answer"}`;
    const pinned = state.copilot.pins.some((pin) => pin.pinId === pinId);
    return <CopilotAnswerCard
      answer={answer}
      key={answer.answerId}
      presentation="workbench"
      viewModel={viewModel}
      onOpenContext={openSupportingContext}
      actions={section ? <button className={styles.textButton} type="button" onClick={() => dispatch({ type: "toggle-copilot-pin", pin: createCopilotPin({ pinId, answer, sectionId: section.sectionId, createdAt: new Date().toISOString() }) })}>{pinned ? "PINNED ✓" : "PIN TO TODAY"}</button> : null}
    />;
  };
  return (
    <section className={`${styles.scroll} ${styles.stack}`} aria-label="Copilot">
      <div>
        <div className={styles.micro}>COPILOT · MORNING WORKBENCH</div>
        <h1 className={styles.heroTitle}>{fixture.member.name}&apos;s morning workbench</h1>
        <div className={styles.subtle}>{formatCoachDate(selectedDate)} · {freshness} · {fixture.member.tier}</div>
      </div>
      {briefAnswer && briefAnswer.tasks.length > 0 && <details className={styles.copilotDisclosure} data-testid="copilot-disclosure-morning-tasks">
        <summary><span>Morning tasks</span><span className={styles.copilotDisclosureMeta}>{briefAnswer.tasks.length} {briefAnswer.tasks.length === 1 ? "task" : "tasks"}</span></summary>
        <section className={`${styles.taskStack} ${styles.copilotDisclosureContent}`} aria-label="Morning tasks">
          {briefAnswer.tasks.map((task) => <article className={styles.taskCard} data-task-id={task.taskId} key={task.taskId}>
            <div className={styles.taskCardTop}><span className={styles.signalKicker}>{task.taskType === "celebrate" ? "CELEBRATE" : "REVIEW RISK"}</span><span className={styles.micro}>TASK {task.sourceOrder + 1}</span></div>
            <div className={styles.bodyStrong}>{task.text}</div>
            <div className={styles.taskCardBottom}><span className={styles.source}>GROUNDED · {task.actionId}</span><button className={styles.textButton} type="button" disabled={Boolean(pending)} onClick={() => taskAction(task)}>Open grounded context →</button></div>
          </article>)}
        </section>
      </details>}
      <div className={styles.promptRow} aria-label="Copilot quick prompts">
        {prompts.map((prompt) => <button className={styles.pillButton} disabled={!copilotAvailable || Boolean(pending)} type="button" key={prompt.id} onClick={() => ask(prompt.id)}>{prompt.label}</button>)}
      </div>
      {!copilotAvailable && <CopilotUnavailable memberName={fixture.member.name} />}
      {pending && <div className={styles.card} aria-busy="true"><SignalKicker data-testid="copilot-motion-signal" working>Retrieving {pending.promptLabel}…</SignalKicker></div>}
      {workbench.primary && renderWorkbenchAnswer(workbench.primary)}
      {workbench.previous.length > 0 && <details className={styles.copilotDisclosure} data-testid="copilot-disclosure-previous-results">
        <summary><span>Previous results</span><span className={styles.copilotDisclosureMeta}>{workbench.previous.length} {workbench.previous.length === 1 ? "result" : "results"}</span></summary>
        <div className={styles.copilotDisclosureContent}>{workbench.previous.map(renderWorkbenchAnswer)}</div>
      </details>}
      {state.copilot.outcome && state.copilot.outcome.status !== "ready" && state.copilot.outcome.status !== "cancelled" && <CopilotOutcomeNotice outcome={state.copilot.outcome} />}
      {state.copilot.outcome?.controls.retry && <button className={styles.secondaryButton} type="button" disabled={Boolean(pending)} onClick={retry}>Retry</button>}
      {state.copilot.outcome?.controls.refresh && <button className={styles.secondaryButton} type="button" disabled={Boolean(pending)} onClick={refresh}>Refresh active revision</button>}
      {copilotAvailable && <form className={styles.copilotComposer} onSubmit={submitTypedQuestion}>
        <div className={styles.composerTopline}><span className={styles.micro}>ASK COPILOT</span><span className={styles.subtle}>Type a question about this athlete</span></div>
        <label className={styles.srOnly} htmlFor="copilot-question">Ask about {fixture.member.name}</label>
        <textarea id="copilot-question" className={styles.textarea} value={question} disabled={Boolean(pending)} maxLength={500} onChange={(event) => setDraftQuestion(event.target.value)} placeholder={`Ask about ${fixture.member.name}…`} />
        <div className={styles.composerActions}><span className={styles.subtle}>{Array.from(question).length}/500 characters</span><button className={styles.primaryButton} type="submit" disabled={Boolean(pending) || !question.trim() || Array.from(question).length > 500}>Ask Copilot</button></div>
      </form>}
    </section>
  );
}

function CopilotUnavailable({ memberName }: { memberName: string }) {
  return <div className={styles.capabilityNote} role="status"><strong>Member context unavailable</strong><span>Graph-backed Copilot is not available for {memberName}. Roster and workout information remain visible.</span></div>;
}

function CopilotOutcomeNotice({ outcome }: { outcome: NonNullable<AthleteWorkflowState["copilot"]["outcome"]> }) {
  const labels = {
    empty: "No supported evidence",
    "insufficient-history": "Insufficient history",
    stale: "Saved revision unavailable",
    "continuation-expired": "Continuation expired",
    denied: "Member context unavailable",
    invalid: "Question not accepted",
    unavailable: "Graph unavailable",
    "model-error": "Copilot model unavailable",
    unsupported: "Question unsupported",
    cancelled: "Request cancelled",
    ready: "Answer ready",
  } as const;
  const message = "message" in outcome ? outcome.message : "The request was cancelled.";
  return <div className={styles.capabilityNote} role="status" data-copilot-status={outcome.status}><strong>{labels[outcome.status]}</strong><span>{message}</span></div>;
}

function CopilotAnswerCard({ answer, compact = false, actions = null, onOpenContext, presentation = "full", viewModel }: {
  answer: NonNullable<AthleteWorkflowState["copilot"]["lastReadyAnswer"]>;
  compact?: boolean;
  actions?: React.ReactNode;
  onOpenContext?: (answer: CopilotAnswerPacket, evidenceId: string) => void;
  presentation?: "full" | "workbench";
  viewModel?: CopilotAnswerViewModel;
}) {
  if (presentation === "workbench") {
    return <CopilotWorkbenchAnswerCard answer={answer} viewModel={viewModel ?? buildCopilotAnswerViewModel(answer)} actions={actions} onOpenContext={onOpenContext} />;
  }
  const freshness = answer.briefFreshness
    ? `${answer.briefFreshness.status === "latest-recorded" ? "Latest recorded" : "Requested date"} · ${formatCoachDate(answer.briefFreshness.generatedFor)}`
    : `Evidence as of ${new Date(answer.evidenceAsOf).toLocaleString("en-US", { timeZone: answer.memberTimezone })}`;
  return <article className={styles.copilotCard} data-answer-id={answer.answerId} data-revision-id={answer.contextRevisionId}>
    <div className={styles.cardTop}><span className={styles.signalKicker}>{answer.intentId.replaceAll("-", " ").toUpperCase()} · {freshness}</span>{actions}</div>
    {answer.sections.map((section) => <section className={styles.answerSection} key={section.sectionId} aria-label={section.sectionId.replaceAll("-", " ")}><div className={styles.dataLabel}>{section.sectionId.replaceAll("-", " ").toUpperCase()}</div>{section.clauses.map((clause) => <p className={section.sectionId === "answer" ? styles.copilotTitle : styles.bodyCopy} key={clause.clauseId}>{clause.text}</p>)}</section>)}
    {answer.churn && <CopilotChurnAssessment answer={answer} />}
    {!compact && answer.chart && <PacketChart chart={answer.chart} />}
    <div className={styles.sources}>{answer.citations.map((citation) => {
      const atom = answer.evidence.atoms.find((candidate) => candidate.evidenceId === citation.evidenceId);
      const supporting = atom?.evidenceKind === "message" || atom?.evidenceKind === "media-attachment";
      return supporting && onOpenContext
        ? <button className={styles.sourceButton} data-focus-key={`supporting-context-${citation.evidenceId}`} type="button" key={citation.citationId} onClick={() => onOpenContext(answer, citation.evidenceId)}>{citation.label} · {citation.temporal.precision}{"effectiveOn" in citation.temporal ? ` · ${citation.temporal.effectiveOn}` : ""} · Inspect context →</button>
        : <span className={styles.sourceChip} key={citation.citationId}>{citation.label} · {citation.temporal.precision}{"effectiveOn" in citation.temporal ? ` · ${citation.temporal.effectiveOn}` : ""}</span>;
    })}</div>
    <div className={styles.micro}>REVISION · {answer.contextRevisionId}</div>
  </article>;
}

const copilotSectionLabels: Readonly<Record<string, string>> = {
  answer: "Analysis",
  limitation: "Limitation",
  "next-action": "Next action",
  "recent-facts": "Recent facts",
  trend: "Trend",
  "stable-context": "Stable context",
  "morning-brief": "Morning brief",
};

function readableCopilotLabel(value: string): string {
  return value
    .replaceAll("-", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function CopilotPresentationSection({ section, primary = false }: { section: CopilotAnswerViewModel["primarySections"][number]; primary?: boolean }) {
  const label = section.sectionId === "answer" && primary
    ? "Decision"
    : copilotSectionLabels[section.sectionId] ?? readableCopilotLabel(section.sectionId);
  return <section className={section.sectionId === "next-action" ? styles.copilotNextAction : styles.answerSection} data-copilot-section={section.sectionId} aria-label={label}>
    <div className={styles.dataLabel}>{label}</div>
    {section.clauses.map((clause) => <p className={primary && section.sectionId === "answer" ? styles.copilotTitle : styles.bodyCopy} key={clause.clauseId}>{clause.text}</p>)}
  </section>;
}

function CopilotWorkbenchAnswerCard({ answer, viewModel, actions, onOpenContext }: {
  answer: CopilotAnswerPacket;
  viewModel: CopilotAnswerViewModel;
  actions: React.ReactNode;
  onOpenContext?: (answer: CopilotAnswerPacket, evidenceId: string) => void;
}) {
  const freshness = answer.briefFreshness
    ? `${answer.briefFreshness.status === "latest-recorded" ? "Latest recorded" : "Requested date"} · ${formatCoachDate(answer.briefFreshness.generatedFor)}`
    : `Evidence as of ${new Date(answer.evidenceAsOf).toLocaleString("en-US", { timeZone: answer.memberTimezone })}`;
  const riskLabel = viewModel.headlineRisk ? readableCopilotLabel(viewModel.headlineRisk) : null;
  const resolvedDecisionEvidenceLabels = viewModel.decisionSupport
    ? [...new Set(viewModel.decisionSupport.evidenceIds.map((evidenceId) => answer.citations.find((citation) => citation.evidenceId === evidenceId)?.label ?? "Packet evidence"))]
    : [];
  const decisionEvidenceLabels = resolvedDecisionEvidenceLabels.length > 0 ? resolvedDecisionEvidenceLabels : ["Packet evidence"];
  const decisionSupportClass = viewModel.decisionSupport?.label === "Priority"
    ? `${styles.copilotDecisionSupport} ${styles.copilotDecisionAction}`
    : `${styles.copilotDecisionSupport} ${styles.copilotDecisionSignal}`;
  return <article className={`${styles.copilotCard} ${styles.copilotWorkbenchCard}`} data-answer-id={answer.answerId} data-revision-id={answer.contextRevisionId} data-copilot-presentation="workbench">
    <div className={styles.cardTop}>
      <div className={styles.copilotPrimaryMeta}>
        <span className={styles.signalKicker}>{readableCopilotLabel(answer.intentId)}</span>
        <span className={styles.copilotFreshness}>{freshness}</span>
      </div>
      {actions}
    </div>
    <div className={styles.copilotPrimaryContent}>
      {riskLabel && <div className={styles.copilotRiskHeadline}><span className={styles.dataLabel}>Risk signal</span><strong>{riskLabel}</strong></div>}
      {viewModel.primarySections.map((section) => <CopilotPresentationSection key={section.sectionId} section={section} primary />)}
      {viewModel.decisionSupport && <section className={decisionSupportClass} aria-label={viewModel.decisionSupport.label}>
        <span className={styles.dataLabel}>{viewModel.decisionSupport.label}</span>
        <p className={styles.bodyStrong}>{viewModel.decisionSupport.text}</p>
        {viewModel.decisionSupport.meta && <span className={styles.micro}>{viewModel.decisionSupport.meta}</span>}
        <span className={styles.source}>EVIDENCE · {decisionEvidenceLabels.join(" · ")}</span>
      </section>}
      {viewModel.nextAction && <CopilotPresentationSection section={viewModel.nextAction} />}
    </div>
    {viewModel.groups.map((group) => <CopilotDisclosure key={group.id} group={group} answer={answer} onOpenContext={onOpenContext} />)}
  </article>;
}

function CopilotDisclosure({ group, answer, onOpenContext }: { group: CopilotPresentationGroup; answer: CopilotAnswerPacket; onOpenContext?: (answer: CopilotAnswerPacket, evidenceId: string) => void }) {
  return <details className={styles.copilotDisclosure} data-testid={`copilot-disclosure-${group.id}`}>
    <summary><span>{group.label}</span><span className={styles.copilotDisclosureMeta}>{group.countLabel}</span></summary>
    <div className={styles.copilotDisclosureContent}>
      {group.sections.map((section) => <CopilotPresentationSection key={section.sectionId} section={section} />)}
      {group.id === "trend" && group.chart && <PacketChart chart={group.chart} />}
      {group.id === "risk" && group.churn && <CopilotChurnAssessment answer={answer} />}
      {group.id === "sources" && <CopilotSources answer={answer} citations={group.citations} includeRevision onOpenContext={onOpenContext} />}
    </div>
  </details>;
}

function CopilotSources({ answer, citations, includeRevision = false, onOpenContext }: {
  answer: CopilotAnswerPacket;
  citations: CopilotAnswerPacket["citations"];
  includeRevision?: boolean;
  onOpenContext?: (answer: CopilotAnswerPacket, evidenceId: string) => void;
}) {
  return <>
    <div className={styles.sources}>{citations.map((citation) => {
      const atom = answer.evidence.atoms.find((candidate) => candidate.evidenceId === citation.evidenceId);
      const supporting = atom?.evidenceKind === "message" || atom?.evidenceKind === "media-attachment";
      return supporting && onOpenContext
        ? <button className={styles.sourceButton} data-focus-key={`supporting-context-${citation.evidenceId}`} type="button" key={citation.citationId} onClick={() => onOpenContext(answer, citation.evidenceId)}>{citation.label} · {citation.temporal.precision}{"effectiveOn" in citation.temporal ? ` · ${citation.temporal.effectiveOn}` : ""} · Inspect context →</button>
        : <span className={styles.sourceChip} key={citation.citationId}>{citation.label} · {citation.temporal.precision}{"effectiveOn" in citation.temporal ? ` · ${citation.temporal.effectiveOn}` : ""}</span>;
    })}</div>
    {includeRevision && <div className={styles.micro}>REVISION · {answer.contextRevisionId} · EVIDENCE AS OF · {answer.evidenceAsOf}</div>}
  </>;
}

function CopilotChurnAssessment({ answer }: { answer: NonNullable<AthleteWorkflowState["copilot"]["lastReadyAnswer"]> }) {
  const churn = answer.churn!;
  const evidenceReferences = (evidenceIds: readonly string[]) => {
    const labels = evidenceIds.map((evidenceId) => {
      const citation = answer.citations.find((candidate) => candidate.evidenceId === evidenceId);
      if (citation) return citation.label;
      const atom = answer.evidence.atoms.find((candidate) => candidate.evidenceId === evidenceId);
      return atom ? `${atom.evidenceKind} · ${evidenceId}` : evidenceId;
    });
    return labels.length > 0 ? `Evidence · ${[...new Set(labels)].join(" · ")}` : "No evidence references in this packet";
  };

  return <div className={styles.churnAssessment}>
    <section className={styles.churnBlock} aria-label="Deterministic derived churn">
      <div className={styles.dataLabel}>DETERMINISTIC DERIVED CHURN</div>
      <div className={styles.bodyStrong}>Level · {churn.derived.level}</div>
      <div className={styles.micro}>METHOD · {churn.derived.methodVersion}</div>
      <div className={styles.bodyCopy}>Supported reasons from the deterministic packet result:</div>
      {churn.derived.reasons.length > 0 ? <ul className={styles.churnList}>
        {churn.derived.reasons.map((reason, index) => <li key={`${reason.code}:${index}`}><span className={styles.bodyStrong}>{reason.code}</span><span className={styles.micro}>{evidenceReferences(reason.evidenceIds)}</span></li>)}
      </ul> : <p className={styles.bodyCopy}>No supported derived reasons in this packet.</p>}
    </section>

    <section className={styles.churnBlock} aria-label="Source-provided churn assessment">
      <div className={styles.dataLabel}>SOURCE-PROVIDED CHURN ASSESSMENT</div>
      {churn.source ? <>
        <div className={styles.bodyStrong}>Level · {churn.source.level}</div>
        {churn.source.reasons.length > 0 ? <ul className={styles.churnList}>
          {churn.source.reasons.map((reason, index) => <li key={`${reason.text}:${index}`}><span className={styles.bodyStrong}>{reason.text}</span><span className={styles.micro}>{reason.basisStatus === "supported" ? "SUPPORTED SOURCE REASON" : "UNSUPPORTED SOURCE REASON"} · {evidenceReferences(reason.evidenceIds)}</span></li>)}
        </ul> : <p className={styles.bodyCopy}>No source-provided reasons in this packet.</p>}
      </> : <p className={styles.bodyCopy}>No source-provided churn assessment in this packet.</p>}
    </section>

    {churn.derived.excludedSourceReasons.length > 0 && <section className={`${styles.churnBlock} ${styles.churnExcluded}`} aria-label="Excluded unsupported-source churn reasons">
      <div className={styles.dataLabel}>EXCLUDED SOURCE REASONS · NOT DERIVED FACTS</div>
      <p className={styles.bodyCopy}>The packet marks these reasons as unsupported-source, so they were not used in the derived assessment.</p>
      <ul className={styles.churnList}>
        {churn.derived.excludedSourceReasons.map((reason, index) => <li key={`${reason.code}:${index}`}><span className={styles.bodyStrong}>{reason.code}</span><span className={styles.micro}>UNSUPPORTED SOURCE · {evidenceReferences(reason.evidenceIds)}</span></li>)}
      </ul>
    </section>}
  </div>;
}

function PacketChart({ chart }: { chart: NonNullable<NonNullable<AthleteWorkflowState["copilot"]["lastReadyAnswer"]>["chart"]> }) {
  const max = Math.max(1, ...chart.points.map((point) => Math.abs(point.value)));
  return <div className={styles.chartWrap}><div className={styles.barChart} role="img" aria-label={chart.textSummary}>{chart.points.map((point) => <div aria-hidden="true" className={styles.barColumn} key={point.pointId}><div className={styles.barFill} data-chart-value={point.value} style={{ height: point.value === 0 ? "0%" : `${Math.max(8, (Math.abs(point.value) / max) * 100)}%` }} /><div className={styles.barLabel}>{point.label}<br />{point.value} {chart.unit}</div></div>)}</div><p className={styles.chartSummary}>{chart.textSummary}</p></div>;
}

function HistoryScreen({ state, conversationAvailable, supportingContext }: { state: AthleteWorkflowState; conversationAvailable: boolean; supportingContext: CopilotSupportingContextReference | null }) {
  const fixture = useDashboardViewModel();
  const workoutHistory = sortWorkoutHistoryChronologically(fixture.history);
  return (
    <section className={`${styles.scroll} ${styles.stack}`} aria-label="History">
      <div><div className={styles.micro}>VERSION HISTORY</div><h1 className={styles.heroTitle}>Today’s workout trail</h1><div className={styles.subtle}>Content versions are immutable. Publication is recorded separately.</div></div>
      {supportingContext && <div className={styles.card} data-testid="supporting-context-summary"><div className={styles.micro}>SUPPORTING CONTEXT · REVISION-PINNED</div><div className={styles.bodyStrong}>Conversation evidence for this Copilot answer</div><div className={styles.bodyCopy}>Anchor · {supportingContext.anchor.evidenceId}</div><div className={styles.micro}>EVIDENCE AS OF · {supportingContext.evidenceAsOf} · TIMEZONE · {supportingContext.memberTimezone}</div><div className={styles.micro}>WINDOW · {supportingContext.window.fromInclusive} → {supportingContext.window.toExclusive}</div><div className={styles.subtle}>This context is read-only and remains bound to the answer’s member and revision.</div></div>}
      <div className={styles.timelineWrap}>
        <VersionTimeline versions={[...state.contentVersions].reverse().map((version) => ({
          title: `v${version.number} · ${version.title}`,
          meta: `${version.actor.toUpperCase()} · ${version.time}`,
          changes: version.changes,
          signal: version.kind === "generated",
          filled: version.kind !== "generated",
        }))} />
      </div>
      {state.publicationEvents.map((event) => <div className={styles.publicationCard} key={event.id}><div className={styles.micro}>LOCAL PUBLICATION EVENT · {event.time}</div><div className={styles.bodyStrong}>Exact {event.workoutVersionId.replace("workout-", "")} recorded for the fixture demo</div><div className={styles.bodyCopy}>Approved by {event.actor}. No external delivery or new content version occurred.</div></div>)}
      <div className={styles.sectionLabel}>RECENT SESSIONS</div>
      {workoutHistory.map((workout, index) => <div className={styles.card} key={`${workout.date}:${workout.title}:${index}`}><div className={styles.workoutTopline}><div className={styles.bodyStrong}>{workout.title}</div><span className={styles.statusPill}>{workout.completed ? "COMPLETED" : "MISSED"}</span></div><div className={styles.bodyCopy}>{workout.date} · {workout.completed ? `${workout.duration_min} min · RPE ${workout.rpe}` : "planned session"}</div></div>)}
      <div className={styles.sectionLabel}>CONVERSATION</div>
      {!conversationAvailable && <div className={styles.card}><div className={styles.bodyStrong}>Conversation history unavailable</div><div className={styles.bodyCopy}>The connected member-context service is not configured.</div></div>}
      {conversationAvailable && state.conversation.status === "loading" && <div className={styles.card} aria-busy="true"><div className={styles.bodyStrong}>Loading revision-pinned conversation…</div></div>}
      {conversationAvailable && ["empty", "denied", "unavailable", "invalid", "stale", "cancelled"].includes(state.conversation.status) && <div className={styles.card} role="status" data-conversation-status={state.conversation.status}><div className={styles.bodyStrong}>{state.conversation.status === "empty" ? "No conversation in this window" : state.conversation.status === "stale" ? "Supporting context is stale" : state.conversation.status === "cancelled" ? "Conversation loading cancelled" : "Conversation history unavailable"}</div><div className={styles.bodyCopy}>{state.conversation.message}</div></div>}
      {conversationAvailable && state.conversation.status === "ready" && state.conversation.timeline && <ConversationTimeline timeline={state.conversation.timeline} />}
    </section>
  );
}

function ConversationTimeline({ timeline }: { timeline: NonNullable<AthleteWorkflowState["conversation"]["timeline"]> }) {
  return <div className={styles.timelineWrap} aria-label="Conversation timeline">
    <div className={styles.subtle}>Evidence as of {timeline.evidenceAsOf} · {timeline.memberTimezone} · {timeline.messages.length} message{timeline.messages.length === 1 ? "" : "s"}</div>
    {timeline.messages.map((message) => <article className={styles.card} data-context-anchor={timeline.anchorEvidenceId === message.evidenceId ? "true" : undefined} key={message.evidenceId}>
      <div className={styles.workoutTopline}><span className={styles.statusPill}>{message.senderRole === "member" ? "MEMBER" : "COACH"}</span><span className={styles.micro}>{message.temporal.precision === "exact-timestamp" ? message.temporal.effectiveAt : message.evidenceId}</span></div>
      <div className={styles.bodyCopy}>{message.text}</div>
      {message.attachments.map((attachment) => <div className={styles.card} data-context-anchor={timeline.anchorEvidenceId === attachment.evidenceId ? "true" : undefined} key={attachment.evidenceId}>
        {attachment.asset.status === "available" && attachment.asset.path
          ? <img src={attachment.asset.path} alt={attachment.caption} style={{ width: "100%", borderRadius: 12, display: "block" }} />
          : <div className={styles.capabilityNote}><strong>Synthetic image unavailable</strong><span>{attachment.caption}</span></div>}
        <div className={styles.micro}>SYNTHETIC ASSET · NOT ANALYZED · {attachment.caption}</div>
      </div>)}
      <div className={styles.source}>REVISION · {timeline.contextRevisionId} · SOURCE · {message.evidenceId}{timeline.anchorEvidenceId === message.evidenceId ? " · SELECTED SUPPORTING EVIDENCE" : ""}</div>
    </article>)}
  </div>;
}

function ScreenHeader({ title, kicker, onBack }: { title: string; kicker: string; onBack: () => void }) {
  return <header className={styles.screenHeader}><button className={styles.backButton} type="button" onClick={onBack} aria-label="Go back">←</button><div><h1 className={styles.screenTitle}>{title}</h1><div className={styles.micro}>{kicker}</div></div></header>;
}

function ProfileScreen({ onBack, onOpenDecisionPath, onOpenHistory, memberContextGraph, memberContextGraphExpanded, memberContextGraphLoading, memberContextGraphUnavailableReason, onExpandMemberContextGraph, onCollapseMemberContextGraph, onRetryMemberContextGraph, onInspectMemberContextGraph }: {
  onBack: () => void;
  onOpenDecisionPath: (decisionId: DashboardDecisionId) => void;
  onOpenHistory: () => void;
  memberContextGraph: FullGraphReadResult | null;
  memberContextGraphExpanded: boolean;
  memberContextGraphLoading: boolean;
  memberContextGraphUnavailableReason?: string;
  onExpandMemberContextGraph: () => void;
  onCollapseMemberContextGraph: () => void;
  onRetryMemberContextGraph: () => void;
  onInspectMemberContextGraph: (input: GraphInspectionRequest) => Promise<GraphInspectionOutcome>;
}) {
  const fixture = useDashboardViewModel();
  const workoutHistory = sortWorkoutHistoryChronologically(fixture.history);
  const injuryDecision = fixture.exclusions.find((item) => item.overridable);
  return <><ScreenHeader title={fixture.member.name} kicker="ATHLETE PROFILE" onBack={onBack} /><section className={`${styles.scroll} ${styles.stack}`} aria-label="Profile">
    <div className={`${styles.card} ${styles.profileHero}`}><span className={styles.avatar}>{fixture.member.initials}</span><div><div className={styles.heroTitle}>{fixture.member.name}</div><div className={styles.micro}>{fixture.member.age} · {fixture.member.height} CM · {fixture.member.weight} KG</div><div className={styles.micro}>{fixture.member.tier} · SINCE {fixture.member.memberSince.slice(0, 7)}</div></div></div>
    <button className={`${styles.card} ${styles.profileHistoryLink}`} type="button" data-focus-key="profile-history" aria-label="History" onClick={onOpenHistory}><span><span className={styles.micro}>MEMBER ACTIVITY</span><span className={styles.bodyStrong}>History</span><span className={styles.bodyCopy}>Workout versions, publication events, and recent sessions</span></span><span className={styles.profileHistoryArrow} aria-hidden="true">→</span></button>
    <div className={styles.sectionLabel}>STATUS</div>
    <div className={styles.card}><div className={styles.workoutTopline}><div className={styles.bodyStrong}>{fixture.profile.injury.displayName} — {fixture.profile.injury.region}</div><span className={styles.statusPill}>{fixture.profile.injury.status}</span></div><div className={styles.bodyCopy}>{fixture.profile.injury.severity} · since {fixture.profile.injury.sinceLabel}. {fixture.profile.injury.notes}</div><div className={styles.source}>{fixture.profile.injury.sourceLabel}</div>{injuryDecision && <button className={styles.secondaryButton} type="button" data-focus-key={`decision-${injuryDecision.decisionId}`} style={{ marginTop: 10 }} onClick={() => onOpenDecisionPath(injuryDecision.decisionId)}>What this changes today →</button>}</div>
    <div className={styles.sectionLabel}>GOALS</div>
    <div className={styles.card}>{fixture.profile.goals.map((goal) => <div className={styles.goalRow} key={goal.id}><span className={styles.micro}>P{goal.priority}</span><span>{goal.text}</span></div>)}</div>
    <div className={styles.sectionLabel}>PREFERENCES</div>
    <div className={styles.card}><div className={styles.bodyCopy}>{fixture.profile.preferences.preferred_session_minutes}-min sessions · {fixture.profile.preferences.training_days_per_week} days/wk · {fixture.profile.preferences.preferred_days.join(" ")}</div><div className={styles.bodyCopy}>{fixture.profile.preferences.notes}</div><div className={styles.chips}>{fixture.profile.preferences.dislikes.map((item) => <span className={styles.sourceChip} key={item}>NEVER · {item}</span>)}</div></div>
    <div className={styles.sectionLabel}>EQUIPMENT</div>
    <div className={styles.chips}>{fixture.profile.equipment.map((item) => <span className={styles.sourceChip} key={item}>{item}</span>)}</div>
    <FullGraphExplorer
      domain="member-context"
      focusedLanes={[
        { name: "MEMBER", text: `${fixture.member.name} · identity, goals, preferences, equipment, and activity.`, source: "MEMBER CONTEXT · FOCUSED PROFILE" },
        { name: "DETAIL", text: "Expand when you want to inspect this member’s complete revision-pinned context and provenance.", source: "READ ONLY · SELECTED MEMBER ONLY" },
      ]}
      fullGraph={memberContextGraph}
      expanded={memberContextGraphExpanded}
      loading={memberContextGraphLoading}
      unavailableReason={memberContextGraphUnavailableReason}
      onExpand={onExpandMemberContextGraph}
      onCollapse={onCollapseMemberContextGraph}
      onRetry={onRetryMemberContextGraph}
      onInspect={onInspectMemberContextGraph}
    />
    <div className={styles.sectionLabel}>RECENT WORKOUT HISTORY</div>
    <div className={styles.profileHistory}>
      {workoutHistory.map((workout, index) => (
        <article className={styles.card} key={`${workout.date}:${workout.title}:${index}`}>
          <div className={styles.workoutTopline}>
            <div className={styles.bodyStrong}>{workout.title}</div>
            <span className={styles.statusPill}>{workout.completed ? "COMPLETED" : "MISSED"}</span>
          </div>
          <div className={styles.bodyCopy}>{workout.date} · {workout.completed ? `${workout.duration_min} min · RPE ${workout.rpe}` : "planned session"}</div>
          {workout.exercises.length > 0 && <div className={styles.micro}>{workout.exercises.join(" · ")}</div>}
        </article>
      ))}
    </div>
  </section></>;
}

function DecisionPathScreen({ decisionId, state, onBack, movementGraph, movementGraphExpanded, movementGraphLoading, movementGraphUnavailableReason, onExpandMovementGraph, onCollapseMovementGraph, onRetryMovementGraph, onInspectMovementGraph }: {
  decisionId: DashboardDecisionId;
  state: AthleteWorkflowState;
  onBack: () => void;
  movementGraph: FullGraphReadResult | null;
  movementGraphExpanded: boolean;
  movementGraphLoading: boolean;
  movementGraphUnavailableReason?: string;
  onExpandMovementGraph: () => void;
  onCollapseMovementGraph: () => void;
  onRetryMovementGraph: () => void;
  onInspectMovementGraph: (input: GraphInspectionRequest) => Promise<GraphInspectionOutcome>;
}) {
  const fixture = useDashboardViewModel();
  const path = fixture.decisionPaths[decisionId];
  if (!path) return <><ScreenHeader title="Decision path unavailable" kicker="SOURCE DATA UNAVAILABLE" onBack={onBack} /><section className={`${styles.scroll} ${styles.stack}`} aria-label="Decision Path"><div className={styles.card}><div className={styles.bodyStrong}>This decision path is unavailable.</div><div className={styles.bodyCopy}>The selected item does not include a matching source-backed decision identifier.</div></div></section></>;
  const overridden = state.contentVersions.some((version) => version.kind === "override" && version.overrideDecisionId === decisionId);
  return <><ScreenHeader title="Decision path" kicker="GRAPH-TRAVERSED · SOURCE-BACKED" onBack={onBack} /><section className={`${styles.scroll} ${styles.stack}`} aria-label="Decision Path">
    <div className={styles.workoutTopline}><span className={styles.statusPill}>{path.kind}</span>{overridden && <span className={styles.versionPill}>COACH OVERRIDE · INK</span>}</div>
    {path.lanes.map((lane) => <div className={styles.lane} key={lane.name}><div className={styles.micro}>{lane.name}</div><div className={styles.bodyStrong}>{lane.text}</div><div className={styles.source}>{lane.source}</div></div>)}
    {overridden && <div className={styles.card}><div className={styles.bodyStrong}>{fixture.coach.name} retained this exercise</div><div className={styles.bodyCopy}>Human ownership is shown in ink. Signal marks only the retained graph provenance and warning.</div><span className={styles.signalKicker} style={{ marginTop: 10 }}>WARNING PROVENANCE RETAINED</span></div>}
    <div className={styles.subtle} style={{ textAlign: "center" }}>The same four lanes explain each selection, exclusion, substitution, override, and Copilot claim.</div>
    <FullGraphExplorer
      domain="movement-clinical"
      focusedLanes={path.lanes}
      fullGraph={movementGraph}
      expanded={movementGraphExpanded}
      loading={movementGraphLoading}
      unavailableReason={movementGraphUnavailableReason}
      onExpand={onExpandMovementGraph}
      onCollapse={onCollapseMovementGraph}
      onRetry={onRetryMovementGraph}
      onInspect={onInspectMovementGraph}
    />
  </section></>;
}

function InsightScreen({ detailId, state, onBack }: { detailId: string; state: AthleteWorkflowState; onBack: () => void }) {
  const answer = state.copilot.answers.find((candidate) => candidate.answerId === detailId) ?? state.copilot.lastReadyAnswer;
  return <><ScreenHeader title="Copilot answer" kicker="IMMUTABLE ANSWER DETAIL" onBack={onBack} /><section className={`${styles.scroll} ${styles.stack}`} aria-label="Insight">
    {answer ? <CopilotAnswerCard answer={answer} /> : <div className={styles.capabilityNote} role="status">No graph-backed answer is available.</div>}
  </section></>;
}

function WorkoutRationaleScreen({ onBack, openDecisionPath }: { onBack: () => void; openDecisionPath: (decisionId: DashboardDecisionId) => void }) {
  const fixture = useDashboardViewModel();
  const items = [...fixture.workoutSections.flatMap((section) => section.items), ...fixture.exclusions];
  return <><ScreenHeader title="Why this workout?" kicker="SOURCE-BACKED RATIONALE" onBack={onBack} /><section className={`${styles.scroll} ${styles.stack}`} aria-label="Workout rationale">
    <div className={styles.heroCard}><div className={styles.bodyStrong}>{fixture.workoutTitle}</div><div className={styles.bodyCopy}>Every reason below comes from the workout’s existing evidence and provenance.</div></div>
    {items.map((item) => <article className={styles.card} key={item.id}><div className={styles.bodyStrong}>{item.name}</div><div className={styles.bodyCopy}>{item.why}</div><div className={styles.source}>{item.provenance}</div>{item.decisionId && <button className={styles.pillButton} type="button" data-focus-key={`rationale-decision-${item.decisionId}`} onClick={() => openDecisionPath(item.decisionId!)}>See decision path →</button>}</article>)}
  </section></>;
}

function ApproveScreen({ currentVersion, published, dispatch, onBack }: { currentVersion: WorkoutVersion; published: boolean; dispatch: React.Dispatch<DashboardAction>; onBack: () => void }) {
  const fixture = useDashboardViewModel();
  return <><ScreenHeader title={`Approve v${currentVersion.number}`} kicker="FINAL CHECK BEFORE PUBLISH" onBack={onBack} /><section className={`${styles.scroll} ${styles.stack}`} aria-label="Approve">
    <div className={styles.card}><div className={styles.workoutTopline}><div className={styles.bodyStrong}>{currentVersion.durationMinutes}-min {fixture.workoutTitle}</div><span className={styles.versionPill}>v{currentVersion.number}</span></div><div className={styles.bodyCopy}>{currentVersion.intensity} intensity · {currentVersion.overrideDecisionId ? "1 override · reason on file · warning retained" : "No overrides · all constraints pass"}</div></div>
    <div className={styles.sectionLabel}>CHANGES IN THIS APPROVAL</div>
    <div className={styles.card}>{currentVersion.kind === "generated" ? <div className={styles.bodyCopy}>Original machine-generated, safety-checked draft.</div> : currentVersion.changes.map((change) => <div className={styles.bodyCopy} key={change}>· {change}</div>)}</div>
    <div className={styles.heroCard}><div className={styles.bodyCopy}>This fixture-only action records a local publication event for workout-v{currentVersion.number}. It does not send anything externally. Every prior draft, adjustment, and override stays in History.</div></div>
    <button className={styles.primaryButton} type="button" disabled={published} onClick={() => dispatch({ type: "publish-current-version", actor: fixture.coach.name })}>{published ? "Already recorded" : `Approve & record v${currentVersion.number} locally`}</button>
    <div className={styles.subtle} style={{ textAlign: "center" }}>or go back to keep adjusting</div>
  </section></>;
}

function DashboardDialog({ state, workflow, dispatch, onRequestAdjustment }: {
  state: DashboardState;
  workflow: AthleteWorkflowState;
  dispatch: React.Dispatch<DashboardAction>;
  onRequestAdjustment: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const fixture = useDashboardViewModel();
  const overrideItem = workflow.overrideDecisionIdDraft
    ? fixture.exclusions.find((item) => item.decisionId === workflow.overrideDecisionIdDraft)
    : null;

  useEffect(() => {
    const dialog = dialogRef.current;
    const focusable = dialog?.querySelector<HTMLElement>("input, textarea, button:not([disabled])");
    focusable?.focus();
  }, [state.dialog]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!workflow.pendingAdjustment) dispatch({ type: "cancel-dialog" });
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("input, textarea, button:not([disabled])")];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (state.dialog === "adjustment") return <div className={styles.dialogLayer} role="presentation"><section ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="adjust-title" onKeyDown={onKeyDown}>
    <span className={styles.handle} /><div><div id="adjust-title" className={styles.screenTitle}>Adjust today’s workout</div><div className={styles.bodyCopy}>Guided controls create one new content version when applied.</div></div>
    <label><span className={styles.bodyStrong}>Duration · {workflow.draftDuration} min</span><input className={styles.range} aria-label="Workout duration" type="range" min="30" max="60" step="5" disabled={workflow.pendingAdjustment} value={workflow.draftDuration} onChange={(event) => dispatch({ type: "set-draft-duration", duration: Number(event.target.value) })} /></label>
    <div><div className={styles.bodyStrong} style={{ marginBottom: 8 }}>Intensity</div><div className={styles.choiceRow}>{(["Light", "Moderate", "Hard"] as const).map((intensity) => <button className={`${styles.choice} ${workflow.draftIntensity === intensity ? styles.choiceActive : ""}`} type="button" disabled={workflow.pendingAdjustment} key={intensity} onClick={() => dispatch({ type: "set-draft-intensity", intensity })}>{intensity}</button>)}</div></div>
    <div className={styles.actionRow}><button className={styles.secondaryButton} type="button" disabled={workflow.pendingAdjustment} onClick={() => dispatch({ type: "cancel-dialog" })}>Cancel</button><button className={styles.primaryButton} type="button" disabled={workflow.pendingAdjustment} aria-busy={workflow.pendingAdjustment} onClick={onRequestAdjustment}>{workflow.pendingAdjustment ? "Applying adjustment…" : "Apply adjustment"}</button></div>
  </section></div>;

  return <div className={styles.dialogLayer} role="presentation"><section ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="override-title" onKeyDown={onKeyDown}>
    <span className={styles.handle} /><div><div id="override-title" className={styles.screenTitle}>Override: {overrideItem?.catalogName ?? "Unavailable decision"}</div><div className={styles.bodyCopy}>Human coach ownership is recorded in ink. The graph warning remains attached.</div></div>
    {overrideItem ? <div className={styles.card}><div className={styles.bodyStrong}>! {overrideItem.reason}</div><div className={styles.bodyCopy}>Flagged for {fixture.profile.injury.displayName.toLowerCase()} ({fixture.profile.injury.region}, {fixture.profile.injury.status}).</div><span className={styles.signalKicker} style={{ marginTop: 9 }}>{fixture.profile.injury.sourceLabel}</span></div> : <div className={styles.card}><div className={styles.bodyStrong}>Override unavailable</div><div className={styles.bodyCopy}>No matching source-backed decision was provided.</div></div>}
    <textarea className={styles.textarea} aria-label="Override reason" placeholder="Reason (required) — e.g. cleared by PT, light load only" value={workflow.overrideReasonDraft} onChange={(event) => dispatch({ type: "set-override-reason", reason: event.target.value })} />
    <div className={styles.actionRow}><button className={styles.secondaryButton} type="button" onClick={() => dispatch({ type: "cancel-dialog" })}>Cancel</button><button className={styles.primaryButton} type="button" disabled={!overrideItem || workflow.overrideReasonDraft.trim().length < 4} onClick={() => overrideItem && dispatch({ type: "apply-override", actor: fixture.coach.name, exerciseName: overrideItem.catalogName, warning: overrideItem.reason })}>Override — keep warning</button></div>
  </section></div>;
}
