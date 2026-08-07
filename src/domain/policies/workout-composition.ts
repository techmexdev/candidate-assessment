import type { CatalogSafetyDecision, CatalogSafetyResult } from "../contracts/catalog-safety";
import {
  WORKOUT_SECTION_ORDER,
  asWorkoutRunId,
  type ReviewableWorkout,
  type WorkoutDose,
  type WorkoutItem,
  type WorkoutSection,
  type WorkoutSectionKind,
  type WorkoutTiming,
} from "../contracts/workout";
import type { WorkoutValidationReceipt } from "../contracts/workout-run";

export type WorkoutDurationPolicy = {
  readonly version: string;
  readonly minimumMinutes: number;
  readonly maximumMinutes: number;
  readonly incrementMinutes: number;
  readonly maximumUnderfillSeconds: number;
  readonly maximumOverflowSeconds: number;
};

export const DEFAULT_WORKOUT_DURATION_POLICY: Readonly<WorkoutDurationPolicy> = Object.freeze({
  version: "workout-duration/v1",
  minimumMinutes: 30,
  maximumMinutes: 60,
  incrementMinutes: 5,
  maximumUnderfillSeconds: 60,
  maximumOverflowSeconds: 0,
});

export type WorkoutDoseBounds = {
  readonly minimumSets: number;
  readonly maximumSets: number;
  readonly minimumWorkSecondsPerSet: number;
  readonly maximumWorkSecondsPerSet: number;
  readonly minimumRestSeconds: number;
  readonly maximumRestSeconds: number;
};

export type WorkoutCompositionCandidate = {
  readonly exerciseConceptId: string;
  readonly allowedSections: readonly WorkoutSectionKind[];
  readonly doseBounds: Readonly<WorkoutDoseBounds>;
  readonly transitionSeconds: number;
};

export type WorkoutProposalItem = {
  readonly exerciseConceptId: string;
  readonly dose: Readonly<WorkoutDose>;
  readonly restSeconds: number;
  readonly rationale: string;
};

export type WorkoutCompositionProposal = {
  readonly schemaVersion: "workout-proposal/v1";
  readonly sections: readonly {
    readonly kind: WorkoutSectionKind;
    readonly items: readonly WorkoutProposalItem[];
  }[];
};

export type WorkoutCompositionValidationInput = {
  readonly runId: string;
  readonly claimGeneration: number;
  readonly requestedDurationMinutes: number;
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly revisionSealDigest: string;
  readonly requestDigest: string;
  readonly resolvedConstraintDigest: string;
  readonly safetyEnvelopeDigest: string;
  readonly completeDecisionSetDigest: string;
  readonly modelProposalDigest: string;
  readonly workoutPayloadDigest: string;
  readonly provenanceDigest: string;
  readonly proposal: WorkoutCompositionProposal;
  readonly candidates: readonly WorkoutCompositionCandidate[];
  readonly catalogSafety: CatalogSafetyResult;
  readonly durationPolicy?: WorkoutDurationPolicy;
};

export type WorkoutCompositionViolationCode =
  | "invalid-duration"
  | "invalid-authority"
  | "mixed-revision"
  | "missing-section"
  | "duplicate-section"
  | "empty-section"
  | "unknown-exercise"
  | "duplicate-exercise"
  | "unsafe-candidate"
  | "section-not-allowed"
  | "incomplete-decision-evidence"
  | "invalid-dose"
  | "invalid-rest"
  | "invalid-transition"
  | "invalid-rationale"
  | "budget-underflow"
  | "budget-overflow";

export type WorkoutCompositionViolation = {
  readonly code: WorkoutCompositionViolationCode;
  readonly section?: WorkoutSectionKind;
  readonly exerciseConceptId?: string;
};

export type WorkoutCompositionValidationResult =
  | { readonly status: "valid"; readonly workout: Readonly<ReviewableWorkout>; readonly receipt: Readonly<WorkoutValidationReceipt> }
  | { readonly status: "invalid"; readonly violations: readonly WorkoutCompositionViolation[] };

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function isFiniteInteger(value: number) {
  return Number.isFinite(value) && Number.isInteger(value);
}

function plannedWorkSeconds(dose: WorkoutDose) {
  return dose.kind === "timed"
    ? dose.sets * dose.workSecondsPerSet
    : dose.sets * dose.repetitionsPerSet * dose.secondsPerRepetition;
}

function workSecondsPerSet(dose: WorkoutDose) {
  return dose.kind === "timed" ? dose.workSecondsPerSet : dose.repetitionsPerSet * dose.secondsPerRepetition;
}

function validDose(dose: WorkoutDose, bounds: WorkoutDoseBounds) {
  if (!isFiniteInteger(dose.sets) || dose.sets < bounds.minimumSets || dose.sets > bounds.maximumSets) return false;
  if (dose.kind === "timed") {
    return isFiniteInteger(dose.workSecondsPerSet)
      && dose.workSecondsPerSet >= bounds.minimumWorkSecondsPerSet
      && dose.workSecondsPerSet <= bounds.maximumWorkSecondsPerSet;
  }
  return isFiniteInteger(dose.repetitionsPerSet) && dose.repetitionsPerSet > 0
    && Number.isFinite(dose.secondsPerRepetition) && dose.secondsPerRepetition > 0
    && workSecondsPerSet(dose) >= bounds.minimumWorkSecondsPerSet
    && workSecondsPerSet(dose) <= bounds.maximumWorkSecondsPerSet;
}

function sumTiming(items: readonly WorkoutItem[]) {
  return items.reduce((total, item) => ({
    plannedWorkSeconds: total.plannedWorkSeconds + item.timing.plannedWorkSeconds,
    plannedRestSeconds: total.plannedRestSeconds + item.timing.plannedRestSeconds,
    transitionSeconds: total.transitionSeconds + item.timing.transitionSeconds,
    totalSeconds: total.totalSeconds + item.timing.totalSeconds,
  }), { plannedWorkSeconds: 0, plannedRestSeconds: 0, transitionSeconds: 0, totalSeconds: 0 });
}

export function calculateWorkoutTiming(sections: readonly WorkoutSection[], requestedDurationSeconds?: number): WorkoutTiming {
  const total = sections.reduce((timing, section) => {
    const sectionTiming = sumTiming(section.items);
    return {
      plannedWorkSeconds: timing.plannedWorkSeconds + sectionTiming.plannedWorkSeconds,
      plannedRestSeconds: timing.plannedRestSeconds + sectionTiming.plannedRestSeconds,
      transitionSeconds: timing.transitionSeconds + sectionTiming.transitionSeconds,
      totalSeconds: timing.totalSeconds + sectionTiming.totalSeconds,
    };
  }, { plannedWorkSeconds: 0, plannedRestSeconds: 0, transitionSeconds: 0, totalSeconds: 0 });
  const requested = requestedDurationSeconds ?? total.totalSeconds;
  return { ...total, requestedDurationSeconds: requested, differenceSeconds: total.totalSeconds - requested };
}

function decisionEvidenceComplete(decision: CatalogSafetyDecision) {
  return Boolean(decision.exerciseConceptId && decision.exerciseAssertionId)
    && decision.assertionIds.length > 0
    && decision.evidenceIds.length > 0;
}

function initialViolations(input: WorkoutCompositionValidationInput, policy: WorkoutDurationPolicy) {
  const violations: WorkoutCompositionViolation[] = [];
  if (!isFiniteInteger(input.requestedDurationMinutes)
    || input.requestedDurationMinutes < policy.minimumMinutes
    || input.requestedDurationMinutes > policy.maximumMinutes
    || input.requestedDurationMinutes % policy.incrementMinutes !== 0) {
    violations.push({ code: "invalid-duration" });
  }
  if (input.catalogSafety.status !== "ready" || input.catalogSafety.authority !== "canonical") {
    violations.push({ code: "invalid-authority" });
    return violations;
  }
  if (input.catalogSafety.movementGraphRevisionId !== input.movementGraphRevisionId
    || input.catalogSafety.memberContextRevisionId !== input.memberContextRevisionId
    || input.catalogSafety.decisions.some((decision) => decision.movementGraphRevisionId !== input.movementGraphRevisionId
      || decision.memberContextRevisionId !== input.memberContextRevisionId)) {
    violations.push({ code: "mixed-revision" });
  }
  for (const decision of input.catalogSafety.decisions) {
    if (!decisionEvidenceComplete(decision)) {
      violations.push({ code: "incomplete-decision-evidence", exerciseConceptId: decision.exerciseConceptId });
    }
  }
  return violations;
}

export function validateWorkoutComposition(input: WorkoutCompositionValidationInput): WorkoutCompositionValidationResult {
  const policy = input.durationPolicy ?? DEFAULT_WORKOUT_DURATION_POLICY;
  const violations = initialViolations(input, policy);
  if (input.catalogSafety.status !== "ready" || input.catalogSafety.authority !== "canonical") {
    return deepFreeze({ status: "invalid", violations }) as WorkoutCompositionValidationResult;
  }
  const sectionsByKind = new Map<WorkoutSectionKind, WorkoutCompositionProposal["sections"][number][]>();
  for (const section of input.proposal.sections) {
    const entries = sectionsByKind.get(section.kind) ?? [];
    entries.push(section);
    sectionsByKind.set(section.kind, entries);
  }
  for (const kind of WORKOUT_SECTION_ORDER) {
    const sections = sectionsByKind.get(kind) ?? [];
    if (sections.length === 0) violations.push({ code: "missing-section", section: kind });
    if (sections.length > 1) violations.push({ code: "duplicate-section", section: kind });
    if (sections.length === 1 && sections[0]!.items.length === 0) violations.push({ code: "empty-section", section: kind });
  }
  const decisions = new Map(input.catalogSafety.decisions.map((decision) => [decision.exerciseConceptId, decision]));
  const candidates = new Map(input.candidates.map((candidate) => [candidate.exerciseConceptId, candidate]));
  const seen = new Set<string>();
  const sections: WorkoutSection[] = [];
  for (const kind of WORKOUT_SECTION_ORDER) {
    const proposalSection = sectionsByKind.get(kind)?.[0];
    if (!proposalSection) continue;
    const items: WorkoutItem[] = [];
    for (const proposalItem of proposalSection.items) {
      const exerciseConceptId = proposalItem.exerciseConceptId;
      if (seen.has(exerciseConceptId)) violations.push({ code: "duplicate-exercise", section: kind, exerciseConceptId });
      seen.add(exerciseConceptId);
      const decision = decisions.get(exerciseConceptId);
      const candidate = candidates.get(exerciseConceptId);
      if (!decision || !candidate) {
        violations.push({ code: "unknown-exercise", section: kind, exerciseConceptId });
        continue;
      }
      if (decision.classification === "excluded") violations.push({ code: "unsafe-candidate", section: kind, exerciseConceptId });
      if (decision.movementGraphRevisionId !== input.movementGraphRevisionId
        || decision.memberContextRevisionId !== input.memberContextRevisionId) {
        violations.push({ code: "mixed-revision", section: kind, exerciseConceptId });
      }
      if (!candidate.allowedSections.includes(kind)) violations.push({ code: "section-not-allowed", section: kind, exerciseConceptId });
      if (!validDose(proposalItem.dose, candidate.doseBounds)) violations.push({ code: "invalid-dose", section: kind, exerciseConceptId });
      if (!isFiniteInteger(proposalItem.restSeconds)
        || proposalItem.restSeconds < candidate.doseBounds.minimumRestSeconds
        || proposalItem.restSeconds > candidate.doseBounds.maximumRestSeconds) {
        violations.push({ code: "invalid-rest", section: kind, exerciseConceptId });
      }
      if (!isFiniteInteger(candidate.transitionSeconds) || candidate.transitionSeconds < 0) {
        violations.push({ code: "invalid-transition", section: kind, exerciseConceptId });
      }
      if (!proposalItem.rationale.trim()) violations.push({ code: "invalid-rationale", section: kind, exerciseConceptId });
      if (!validDose(proposalItem.dose, candidate.doseBounds)
        || !isFiniteInteger(proposalItem.restSeconds)
        || !isFiniteInteger(candidate.transitionSeconds)) continue;
      const work = plannedWorkSeconds(proposalItem.dose);
      const rest = proposalItem.restSeconds * Math.max(0, proposalItem.dose.sets - 1);
      const timing = {
        plannedWorkSeconds: work,
        plannedRestSeconds: rest,
        transitionSeconds: candidate.transitionSeconds,
        totalSeconds: work + rest + candidate.transitionSeconds,
      };
      const warnings = decision.classification === "caution" || decision.classification === "downranked"
        ? [{ kind: decision.classification, assertionIds: [...decision.assertionIds], evidenceIds: [...decision.evidenceIds] }]
        : [];
      items.push({ ...proposalItem, dose: { ...proposalItem.dose }, timing, warnings });
    }
    sections.push({ kind, items, timing: sumTiming(items) });
  }
  const requestedDurationSeconds = input.requestedDurationMinutes * 60;
  const computed = calculateWorkoutTiming(sections, requestedDurationSeconds);
  const differenceSeconds = computed.differenceSeconds;
  if (differenceSeconds > policy.maximumOverflowSeconds) violations.push({ code: "budget-overflow" });
  if (differenceSeconds < -policy.maximumUnderfillSeconds) violations.push({ code: "budget-underflow" });
  if (violations.length > 0) return deepFreeze({ status: "invalid", violations }) as WorkoutCompositionValidationResult;
  const timing = computed;
  const workout: ReviewableWorkout = {
    schemaVersion: "reviewable-workout/v1",
    runId: asWorkoutRunId(input.runId),
    movementGraphRevisionId: input.movementGraphRevisionId,
    memberContextRevisionId: input.memberContextRevisionId,
    durationPolicyVersion: policy.version,
    sections,
    timing,
  };
  const receipt: WorkoutValidationReceipt = {
    runId: workout.runId,
    claimGeneration: input.claimGeneration,
    requestDigest: input.requestDigest,
    movementGraphRevisionId: input.movementGraphRevisionId,
    memberContextRevisionId: input.memberContextRevisionId,
    revisionSealDigest: input.revisionSealDigest,
    resolvedConstraintDigest: input.resolvedConstraintDigest,
    safetyEnvelopeDigest: input.safetyEnvelopeDigest,
    completeDecisionSetDigest: input.completeDecisionSetDigest,
    modelProposalDigest: input.modelProposalDigest,
    workoutPayloadDigest: input.workoutPayloadDigest,
    provenanceDigest: input.provenanceDigest,
    durationPolicyVersion: policy.version,
    policyVersion: "workout-composition/v1",
    schemaVersion: "workout-validation-receipt/v1",
  };
  return deepFreeze({ status: "valid", workout, receipt }) as WorkoutCompositionValidationResult;
}

const RECEIPT_FIELDS: readonly (keyof WorkoutValidationReceipt)[] = [
  "runId", "claimGeneration", "requestDigest", "movementGraphRevisionId", "memberContextRevisionId",
  "revisionSealDigest", "resolvedConstraintDigest", "safetyEnvelopeDigest", "completeDecisionSetDigest",
  "modelProposalDigest", "workoutPayloadDigest", "provenanceDigest", "durationPolicyVersion", "policyVersion", "schemaVersion",
];

export function verifyValidationReceipt(receipt: WorkoutValidationReceipt, expected: WorkoutValidationReceipt) {
  return RECEIPT_FIELDS.every((field) => receipt[field] === expected[field]);
}
