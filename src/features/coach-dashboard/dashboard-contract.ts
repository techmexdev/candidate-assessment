export type DashboardInsightId = "brief" | "adherence" | "sleep" | "change" | "churn";
export type DashboardDecisionId = string;

export type DashboardLoadState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "empty"; message: string }
  | { status: "error"; message: string; retryable: boolean };

export type StartNewDraftInput = {
  memberId: string;
  requestedBy: string;
};

export type StartNewDraftResult = {
  draftId: string;
};

export type StartNewDraftCapability =
  | { available: false; reason: string }
  | {
      available: true;
      startNewDraft: (input: StartNewDraftInput) => Promise<StartNewDraftResult>;
    };

export type DashboardAdapter = {
  initialState: DashboardLoadState<CoachDashboardViewModel>;
  load: () => Promise<DashboardLoadState<CoachDashboardViewModel>>;
  capabilities: {
    startNewDraft: StartNewDraftCapability;
    workoutGeneration?:
      | { available: false; reason: string }
      | { available: true; runtime: import("./runtime-adapter").DashboardWorkoutRuntime };
  };
};

export type DashboardWorkoutItem = {
  id: string;
  name: string;
  dose: string;
  rest?: string;
  why: string;
  provenance: string;
  decisionId?: DashboardDecisionId;
  catalogId: string | null;
  catalogName: string;
};

export type DashboardCopilotCard = {
  id: DashboardInsightId;
  kicker: string;
  title: string;
  headline?: string;
  rows?: { label: string; value: string }[];
  bars?: { label: string; value: number; displayValue: string }[];
  sources: string[];
  detail?: { recent: string; trend: string; stable: string; action: string };
};

export type CoachDashboardViewModel = {
  coach: { name: string };
  asOfDate: { weekday: string; monthDay: string };
  workoutTitle: string;
  member: {
    id: string;
    name: string;
    initials: string;
    age: number;
    height: number;
    weight: number;
    tier: string;
    memberSince: string;
    trainingDaysPerWeek: number;
  };
  metrics: { adherence: string; sleep: string; restingHeartRate: string };
  morningBrief: {
    celebrationTitle: string;
    celebration: string;
    celebrationSummary: string;
    riskTitle: string;
    risk: string;
    riskSummary: string;
    memberMessage: string;
    memberMessageDate: string;
  };
  profile: {
    injury: {
      id: string;
      region: string;
      joint: string;
      status: string;
      severity: string;
      since: string;
      notes: string;
      snomedct_hint: string;
      displayName: string;
      sinceLabel: string;
      sourceLabel: string;
    };
    goals: { id: string; text: string; priority: number; target_date: string | null }[];
    preferences: {
      preferred_session_minutes: number;
      training_days_per_week: number;
      preferred_days: string[];
      dislikes: string[];
      notes: string;
    };
    equipment: string[];
  };
  workoutSections: readonly { title: string; items: readonly DashboardWorkoutItem[] }[];
  exclusions: readonly (DashboardWorkoutItem & { decisionId: DashboardDecisionId; reason: string; overridable: boolean })[];
  decisionPaths: Readonly<Record<
    string,
    {
      kind: string;
      lanes: readonly { name: string; text: string; source: string }[];
    }
  >>;
  copilotCards: Record<DashboardInsightId, DashboardCopilotCard>;
  history: {
    date: string;
    title: string;
    planned: boolean;
    completed: boolean;
    duration_min: number;
    rpe: number | null;
    exercises: string[];
  }[];
};
