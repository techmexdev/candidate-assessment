import type {
  CopilotChurnView,
  CopilotDerivedChurnLevel,
  CopilotDerivedChurnReason,
  CopilotExcludedChurnReason,
  CopilotScopeEnvelope,
  CopilotSourceChurnAssessment,
} from "../contracts/copilot";
import type {
  ChurnAssessmentEvidenceProjection,
  ChurnReasonEvidenceProjection,
  MessageProjection,
  ObservationEvidenceProjection,
  WorkoutSessionEvidenceProjection,
} from "../contracts/member-context-queries";

const levelRank: Readonly<Record<Exclude<CopilotDerivedChurnLevel, "insufficient-evidence">, number>> = {
  low: 0,
  watch: 1,
  elevated: 2,
};

function temporalTime(value: { readonly temporal: ObservationEvidenceProjection["temporal"] }): number {
  if (value.temporal.precision === "exact-timestamp") return Date.parse(value.temporal.effectiveAt);
  if (value.temporal.precision === "date") return Date.parse(`${value.temporal.effectiveOn}T00:00:00.000Z`);
  return Number.NaN;
}

function stableEvidenceIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

function sourceView(
  scope: CopilotScopeEnvelope,
  assessment: ChurnAssessmentEvidenceProjection | null,
  reasons: readonly ChurnReasonEvidenceProjection[],
): CopilotSourceChurnAssessment | null {
  if (!assessment) return null;
  const ordered = [...reasons].sort((left, right) => left.sourceOrder - right.sourceOrder || left.evidenceId.localeCompare(right.evidenceId));
  return {
    ...scope,
    level: assessment.level,
    reasons: ordered.map((reason) => ({
      text: reason.text,
      basisStatus: reason.basisStatus,
      evidenceIds: [reason.evidenceId],
    })),
    evidenceIds: stableEvidenceIds([assessment.evidenceId, ...ordered.map((reason) => reason.evidenceId)]),
  };
}

export type ChurnRiskInput = {
  readonly scope: CopilotScopeEnvelope;
  readonly evidenceAsOf: string;
  readonly adherence: readonly ObservationEvidenceProjection[];
  readonly workouts: readonly WorkoutSessionEvidenceProjection[];
  readonly messages: readonly MessageProjection[];
  readonly sourceAssessment: ChurnAssessmentEvidenceProjection | null;
  readonly sourceReasons: readonly ChurnReasonEvidenceProjection[];
};

export function deriveChurnRisk(input: Readonly<ChurnRiskInput>): CopilotChurnView {
  const asOf = Date.parse(input.evidenceAsOf);
  if (!Number.isFinite(asOf)) throw new Error("Churn evidence as-of timestamp is invalid.");
  const source = sourceView(input.scope, input.sourceAssessment, input.sourceReasons);
  const excludedSourceReasons: CopilotExcludedChurnReason[] = input.sourceReasons
    .filter((reason) => reason.basisStatus === "unsupported-source")
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
    .map((reason) => ({
      code: "unsupported-source-risk",
      basisStatus: "unsupported-source",
      evidenceIds: [reason.evidenceId],
    }));

  const adherence = input.adherence
    .filter((point) => point.metric === "weekly-workout-completion"
      && point.unit === "percent"
      && typeof point.value === "number"
      && Number.isFinite(point.value)
      && Number.isFinite(temporalTime(point))
      && temporalTime(point) <= asOf)
    .sort((left, right) => temporalTime(left) - temporalTime(right) || left.evidenceId.localeCompare(right.evidenceId))
    .slice(-2);
  const workouts = input.workouts
    .filter((workout) => workout.planned && Number.isFinite(temporalTime(workout)) && temporalTime(workout) <= asOf)
    .sort((left, right) => temporalTime(left) - temporalTime(right) || left.evidenceId.localeCompare(right.evidenceId))
    .slice(-4);

  if (adherence.length < 2 || workouts.length < 2) {
    return {
      derived: {
        ...input.scope,
        methodVersion: "churn-v1",
        level: "insufficient-evidence",
        reasons: [],
        excludedSourceReasons,
        evidenceIds: stableEvidenceIds([
          ...adherence.map((point) => point.evidenceId),
          ...workouts.map((workout) => workout.evidenceId),
        ]),
      },
      source,
    };
  }

  let level: Exclude<CopilotDerivedChurnLevel, "insufficient-evidence"> = "low";
  const reasons: CopilotDerivedChurnReason[] = [];
  const raise = (candidate: "watch" | "elevated", reason: CopilotDerivedChurnReason) => {
    if (levelRank[candidate] > levelRank[level]) level = candidate;
    reasons.push(reason);
  };

  const priorValue = adherence[0]!.value as number;
  const latestValue = adherence[1]!.value as number;
  const drop = priorValue - latestValue;
  if (drop >= 25) {
    raise("elevated", { code: "adherence-drop-25pp", evidenceIds: adherence.map((point) => point.evidenceId) });
  } else if (drop >= 10) {
    raise("watch", { code: "adherence-drop-10pp", evidenceIds: adherence.map((point) => point.evidenceId) });
  }

  const missed = workouts.filter((workout) => !workout.completed);
  if (missed.length >= 2) {
    raise("elevated", { code: "planned-workouts-missed-2", evidenceIds: missed.map((workout) => workout.evidenceId) });
  } else if (missed.length === 1) {
    raise("watch", { code: "planned-workout-missed-1", evidenceIds: [missed[0]!.evidenceId] });
  }

  const dayMs = 24 * 60 * 60 * 1_000;
  const latestStart = asOf - 14 * dayMs;
  const priorStart = asOf - 28 * dayMs;
  const memberMessages = input.messages
    .filter((message) => message.senderRole === "member" && message.temporal.precision === "exact-timestamp")
    .map((message) => ({ message, timestamp: Date.parse((message.temporal as { readonly effectiveAt: string }).effectiveAt) }))
    .filter((entry) => Number.isFinite(entry.timestamp) && entry.timestamp >= priorStart && entry.timestamp <= asOf)
    .sort((left, right) => left.timestamp - right.timestamp || left.message.evidenceId.localeCompare(right.message.evidenceId));
  const priorMessages = memberMessages.filter((entry) => entry.timestamp < latestStart);
  const latestMessages = memberMessages.filter((entry) => entry.timestamp >= latestStart);
  if (priorMessages.length >= 2) {
    const messageEvidenceIds = stableEvidenceIds([
      ...priorMessages.map((entry) => entry.message.evidenceId),
      ...latestMessages.map((entry) => entry.message.evidenceId),
    ]);
    if (latestMessages.length === 0) {
      raise("elevated", { code: "member-message-window-empty", evidenceIds: messageEvidenceIds });
    } else if ((priorMessages.length - latestMessages.length) / priorMessages.length >= 0.5) {
      raise("watch", { code: "member-message-decline-50pct", evidenceIds: messageEvidenceIds });
    }
  }

  reasons.sort((left, right) => left.code.localeCompare(right.code));
  return {
    derived: {
      ...input.scope,
      methodVersion: "churn-v1",
      level,
      reasons,
      excludedSourceReasons,
      evidenceIds: stableEvidenceIds([
        ...adherence.map((point) => point.evidenceId),
        ...workouts.map((workout) => workout.evidenceId),
        ...reasons.flatMap((reason) => reason.evidenceIds),
      ]),
    },
    source,
  };
}
