import type { FullGraphDomain, FullGraphReadResult } from "../../domain/contracts/full-graph-view";

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
    session?: DashboardSessionCapability;
    startNewDraft: StartNewDraftCapability;
    workoutGeneration?:
      | { available: false; reason: string }
      | { available: true; runtime: import("./runtime-adapter").DashboardWorkoutRuntime };
    copilot?: DashboardCopilotCapability;
    conversation?:
      | { available: false; reason: string }
      | { available: true; client: DashboardConversationClient };
    fullGraph?: DashboardFullGraphCapability;
  };
};

export type DashboardSession = {
  readonly coachId: string;
  readonly memberIds: readonly string[];
  readonly expiresAt: string;
};

export type DashboardSessionClient = {
  readonly current: (input?: { readonly signal?: AbortSignal }) => Promise<DashboardSession | null>;
  readonly signIn: (input?: { readonly signal?: AbortSignal }) => Promise<DashboardSession>;
  readonly signOut: (input?: { readonly signal?: AbortSignal }) => Promise<void>;
};

export type DashboardSessionCapability = {
  readonly available: boolean;
  readonly client: DashboardSessionClient;
};

export type DashboardCopilotControls = {
  readonly retry: boolean;
  readonly refresh: boolean;
  readonly keepLastReadyAnswer: boolean;
};

export type DashboardCopilotOutcome = CopilotOutcome & { readonly controls: DashboardCopilotControls };

export type DashboardCopilotRequest = {
  readonly requestId: string;
  readonly memberId: string;
  readonly requestedFor: string;
  readonly input: CopilotQuestionInput;
  readonly continuation?: SignedCopilotContinuation;
  readonly signal?: AbortSignal;
};

export type DashboardCopilotClient = {
  readonly request: (input: DashboardCopilotRequest) => Promise<DashboardCopilotOutcome>;
};

export type DashboardCopilotCapability =
  | { readonly available: false; readonly reason: string }
  | {
      readonly available: true;
      readonly client: DashboardCopilotClient;
      readonly supportsMember: (memberId: string) => boolean;
    };

export type DashboardConversationClient = {
  readonly load: (input: {
    readonly memberId: string;
    readonly contextRevisionId?: string;
    readonly signal?: AbortSignal;
  }) => Promise<import("../../application/use-cases/retrieve-member-conversation").MemberConversationTimeline>;
};

export type DashboardFullGraphRequest = {
  readonly domain: FullGraphDomain;
  readonly memberId?: string;
  readonly revisionId?: string;
  readonly signal?: AbortSignal;
};

export type DashboardFullGraphClient = {
  readonly read: (input: DashboardFullGraphRequest) => Promise<FullGraphReadResult>;
};

export type DashboardFullGraphCapability =
  | { readonly available: false; readonly reason: string }
  | {
      readonly available: true;
      readonly client: DashboardFullGraphClient;
      readonly supports: (input: DashboardFullGraphRequest) => boolean;
    };

export type CoachContext = { name: string };
export type CoachAsOfDate = { weekday: string; monthDay: string };

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

export type CoachDashboardMemberViewModel = {
  coach: CoachContext;
  asOfDate: CoachAsOfDate;
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

export type CoachDashboardFixtureMemberViewModel = CoachDashboardMemberViewModel & {
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
  copilotCards: Record<DashboardInsightId, DashboardCopilotCard>;
};

export type CoachAthleteSummary = {
  id: string;
  name: string;
  initials: string;
  tier: string;
  adherence: string;
  suggestedWorkoutTitle: string;
  lastSessionLabel: string;
  nextSessionId: string | null;
  nextSessionLabel: string | null;
  nextSessionAt: string | null;
};

export type CoachSession = {
  id: string;
  athleteId: string;
  startsAt: string;
  label: string;
  durationMinutes: number;
  status: "upcoming";
};

export type CoachDashboardWorkspace = {
  coach: CoachContext;
  asOfDate: CoachAsOfDate;
  coachDayDate: string;
  timezone: string;
  athletes: CoachAthleteSummary[];
  sessions: CoachSession[];
  memberViews: Record<string, CoachDashboardMemberViewModel>;
};

export type CoachTodayProjection = {
  sessions: CoachSession[];
  scheduledAthletes: {
    athlete: CoachAthleteSummary;
    firstSession: CoachSession;
  }[];
};

export type CoachDashboardViewModel = CoachDashboardMemberViewModel & {
  workspace: CoachDashboardWorkspace;
};
import type {
  CopilotOutcome,
  CopilotQuestionInput,
  SignedCopilotContinuation,
} from "../../domain/contracts/copilot";
