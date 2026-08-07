import type {
  CopilotActionId,
  CopilotCanonicalIntentId,
  CopilotQuickPromptId,
  CopilotSectionId,
} from "../contracts/copilot";
import type {
  MemberContextEvidenceDomain,
  MemberEvidenceProjection,
} from "../contracts/member-context-queries";
import type { MemberContextRevisionScopedNode } from "../contracts/member-context";

export const COPILOT_INTENT_REGISTRY_VERSION = "copilot-intents/v1" as const;
export const COPILOT_MAX_QUESTION_LENGTH = 500;

type EvidenceKind = MemberContextRevisionScopedNode["kind"];

export type CopilotRetrievalStep =
  | {
      readonly stepId: string;
      readonly operation: "evidence";
      readonly domains: readonly MemberContextEvidenceDomain[];
      readonly evidenceKinds: readonly EvidenceKind[];
      readonly limit: number;
    }
  | {
      readonly stepId: string;
      readonly operation: "longitudinal-series";
      readonly metric: string;
      readonly lookbackDays: number;
      readonly minimumPoints: number;
      readonly limit: number;
    }
  | {
      readonly stepId: string;
      readonly operation: "relative-sequence";
      readonly domain: MemberContextEvidenceDomain;
      readonly metric: string;
      readonly minimumPoints: number;
      readonly limit: number;
    }
  | {
      readonly stepId: string;
      readonly operation: "conversation";
      readonly lookbackDays: number;
      readonly limit: number;
    }
  | {
      readonly stepId: string;
      readonly operation: "coach-brief";
      readonly limit: number;
    }
  | {
      readonly stepId: string;
      readonly operation: "citations";
      readonly limit: number;
    };

export type CopilotChartRecipe = {
  readonly recipeId: string;
  readonly type: "bar" | "line";
  readonly temporalMode: "calendar" | "relative-order";
  readonly metric: string;
  readonly minimumPoints: number;
};

export type CopilotIntentRecipe = {
  readonly registryVersion: typeof COPILOT_INTENT_REGISTRY_VERSION;
  readonly intentId: CopilotCanonicalIntentId;
  readonly aliases: readonly string[];
  readonly evidenceDomains: readonly MemberContextEvidenceDomain[];
  readonly evidenceKinds: readonly EvidenceKind[];
  readonly metrics: readonly string[];
  readonly sectionEvidenceKinds: Readonly<Partial<Record<CopilotSectionId, readonly EvidenceKind[]>>>;
  readonly actionIds: readonly CopilotActionId[];
  readonly timeoutMs: number;
  readonly readBudget: number;
  readonly chart: CopilotChartRecipe | null;
  readonly degradedState: "empty" | "insufficient-history";
  readonly steps: readonly CopilotRetrievalStep[];
};

function freeze<Value>(value: Value): Readonly<Value> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

function recipe(input: Omit<CopilotIntentRecipe, "registryVersion" | "readBudget">): CopilotIntentRecipe {
  return freeze({
    ...input,
    registryVersion: COPILOT_INTENT_REGISTRY_VERSION,
    readBudget: input.steps.length,
  }) as CopilotIntentRecipe;
}

const profileStep = {
  stepId: "profile",
  operation: "evidence",
  domains: ["profile"],
  evidenceKinds: ["member-profile"],
  limit: 1,
} as const;
const citationStep = { stepId: "citations", operation: "citations", limit: 100 } as const;

export const COPILOT_INTENT_REGISTRY: Readonly<Record<CopilotCanonicalIntentId, CopilotIntentRecipe>> = freeze({
  "morning-brief": recipe({
    intentId: "morning-brief",
    aliases: ["Morning brief", "morning brief"],
    evidenceDomains: ["profile", "coach-brief", "workouts", "adherence", "churn", "conversations"],
    evidenceKinds: ["member-profile", "coach-brief", "coach-task", "workout-session", "observation", "churn-assessment", "churn-reason", "conversation", "message"],
    metrics: ["weekly-workout-completion"],
    sectionEvidenceKinds: {
      "morning-brief": ["coach-brief", "coach-task"],
      "recent-facts": ["workout-session", "observation", "message"],
      trend: ["observation", "workout-session", "message"],
    },
    actionIds: ["celebrate-progress", "review-adherence", "review-churn-risk"],
    timeoutMs: 1_000,
    chart: null,
    degradedState: "empty",
    steps: [
      profileStep,
      { stepId: "brief", operation: "coach-brief", limit: 10 },
      { stepId: "brief-context", operation: "evidence", domains: ["workouts", "adherence", "churn"], evidenceKinds: ["workout-session", "observation", "churn-assessment", "churn-reason"], limit: 32 },
      { stepId: "message-pattern", operation: "conversation", lookbackDays: 28, limit: 40 },
      citationStep,
    ],
  }),
  adherence: recipe({
    intentId: "adherence",
    aliases: ["Adherence", "Show adherence"],
    evidenceDomains: ["profile", "adherence"],
    evidenceKinds: ["member-profile", "observation"],
    metrics: ["weekly-workout-completion"],
    sectionEvidenceKinds: { answer: ["observation"], trend: ["observation"] },
    actionIds: ["review-adherence", "celebrate-progress"],
    timeoutMs: 1_000,
    chart: { recipeId: "adherence-four-weeks", type: "bar", temporalMode: "calendar", metric: "weekly-workout-completion", minimumPoints: 2 },
    degradedState: "insufficient-history",
    steps: [
      profileStep,
      { stepId: "adherence-four-weeks", operation: "longitudinal-series", metric: "weekly-workout-completion", lookbackDays: 28, minimumPoints: 2, limit: 4 },
      citationStep,
    ],
  }),
  sleep: recipe({
    intentId: "sleep",
    aliases: ["Sleep", "Show sleep"],
    evidenceDomains: ["profile", "biomarkers"],
    evidenceKinds: ["member-profile", "observation"],
    metrics: ["sleep-hours"],
    sectionEvidenceKinds: { answer: ["observation"], trend: ["observation"] },
    actionIds: ["review-sleep"],
    timeoutMs: 1_000,
    chart: { recipeId: "sleep-relative-seven", type: "bar", temporalMode: "relative-order", metric: "sleep-hours", minimumPoints: 2 },
    degradedState: "insufficient-history",
    steps: [
      profileStep,
      { stepId: "sleep-relative-seven", operation: "relative-sequence", domain: "biomarkers", metric: "sleep-hours", minimumPoints: 2, limit: 7 },
      citationStep,
    ],
  }),
  "changes-since-last-week": recipe({
    intentId: "changes-since-last-week",
    aliases: ["What changed since last week?", "What changed since last week"],
    evidenceDomains: ["profile", "adherence", "biomarkers", "workouts", "preferences"],
    evidenceKinds: ["member-profile", "observation", "workout-session", "preference"],
    metrics: ["weekly-workout-completion", "sleep-hours"],
    sectionEvidenceKinds: {
      "recent-facts": ["observation", "workout-session"],
      trend: ["observation", "workout-session"],
      "stable-context": ["preference"],
    },
    actionIds: ["review-with-member", "celebrate-progress", "review-adherence", "review-sleep"],
    timeoutMs: 1_000,
    chart: { recipeId: "adherence-four-weeks", type: "line", temporalMode: "calendar", metric: "weekly-workout-completion", minimumPoints: 2 },
    degradedState: "insufficient-history",
    steps: [
      profileStep,
      { stepId: "adherence-four-weeks", operation: "longitudinal-series", metric: "weekly-workout-completion", lookbackDays: 28, minimumPoints: 2, limit: 4 },
      { stepId: "sleep-relative-seven", operation: "relative-sequence", domain: "biomarkers", metric: "sleep-hours", minimumPoints: 2, limit: 7 },
      { stepId: "recent-and-stable", operation: "evidence", domains: ["workouts", "preferences"], evidenceKinds: ["workout-session", "preference"], limit: 12 },
      citationStep,
    ],
  }),
  "churn-risk": recipe({
    intentId: "churn-risk",
    aliases: ["Churn risk", "Show churn risk"],
    evidenceDomains: ["profile", "adherence", "workouts", "conversations", "churn"],
    evidenceKinds: ["member-profile", "observation", "workout-session", "conversation", "message", "churn-assessment", "churn-reason"],
    metrics: ["weekly-workout-completion"],
    sectionEvidenceKinds: { answer: ["observation", "workout-session", "message", "churn-assessment", "churn-reason"] },
    actionIds: ["review-churn-risk", "review-with-member"],
    timeoutMs: 1_000,
    chart: null,
    degradedState: "insufficient-history",
    steps: [
      profileStep,
      { stepId: "adherence-history", operation: "longitudinal-series", metric: "weekly-workout-completion", lookbackDays: 56, minimumPoints: 2, limit: 4 },
      { stepId: "workout-and-source-risk", operation: "evidence", domains: ["workouts", "churn"], evidenceKinds: ["workout-session", "churn-assessment", "churn-reason"], limit: 24 },
      { stepId: "message-pattern", operation: "conversation", lookbackDays: 28, limit: 40 },
      citationStep,
    ],
  }),
}) as Readonly<Record<CopilotCanonicalIntentId, CopilotIntentRecipe>>;

export type CopilotIntentSelection =
  | { readonly kind: "quick-prompt"; readonly promptId: string }
  | { readonly kind: "exact-alias"; readonly text: string }
  | { readonly kind: "model-classified"; readonly question: string; readonly intentId: string };

export type CopilotIntentResolution =
  | { readonly status: "resolved"; readonly intentId: CopilotCanonicalIntentId; readonly recipe: CopilotIntentRecipe }
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "unsupported" };

function knownIntent(value: string): value is CopilotCanonicalIntentId {
  return Object.hasOwn(COPILOT_INTENT_REGISTRY, value);
}

export function resolveCopilotIntent(selection: Readonly<CopilotIntentSelection>): CopilotIntentResolution {
  let intentId: string | undefined;
  if (selection.kind === "quick-prompt") intentId = selection.promptId;
  if (selection.kind === "exact-alias") {
    if (!selection.text || selection.text.length > COPILOT_MAX_QUESTION_LENGTH) {
      return { status: "invalid", message: "Question is outside the supported input bounds." };
    }
    intentId = Object.values(COPILOT_INTENT_REGISTRY)
      .find((entry) => entry.aliases.includes(selection.text))?.intentId;
    if (!intentId) return { status: "unsupported" };
  }
  if (selection.kind === "model-classified") {
    if (!selection.question.trim() || selection.question.length > COPILOT_MAX_QUESTION_LENGTH) {
      return { status: "invalid", message: "Question is outside the supported input bounds." };
    }
    intentId = selection.intentId;
  }
  if (!intentId || !knownIntent(intentId)) {
    return selection.kind === "model-classified" || selection.kind === "quick-prompt"
      ? { status: "invalid", message: "Canonical intent is not allowlisted." }
      : { status: "unsupported" };
  }
  return { status: "resolved", intentId, recipe: COPILOT_INTENT_REGISTRY[intentId] };
}

export type CopilotEvidenceSelection = {
  readonly sectionId: CopilotSectionId;
  readonly evidenceIds: readonly string[];
};

export function validateCopilotEvidenceSelections(
  recipeValue: Readonly<CopilotIntentRecipe>,
  selections: readonly CopilotEvidenceSelection[],
  evidence: readonly MemberEvidenceProjection[],
): boolean {
  const byId = new Map(evidence.map((item) => [item.evidenceId, item]));
  return selections.every((selection) => {
    const allowedKinds = recipeValue.sectionEvidenceKinds[selection.sectionId];
    return Boolean(allowedKinds)
      && selection.evidenceIds.length > 0
      && new Set(selection.evidenceIds).size === selection.evidenceIds.length
      && selection.evidenceIds.every((id) => {
        const item = byId.get(id);
        return item !== undefined && allowedKinds!.includes(item.kind);
      });
  });
}

export function isCopilotQuickPromptId(value: string): value is CopilotQuickPromptId {
  return knownIntent(value);
}
