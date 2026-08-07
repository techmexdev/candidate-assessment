import type { ImmutableWorkoutVersion, WorkoutInputRevisionId, WorkoutRunId, WorkoutVersionId } from "./workout";
import type { WorkoutProvenanceBundle } from "./workout-provenance";

export const WORKOUT_RUN_STATES = [
  "queued",
  "running",
  "awaiting-clarification",
  "failed",
  "canceled",
  "completed",
] as const;
export type WorkoutRunState = (typeof WORKOUT_RUN_STATES)[number];
export type TerminalWorkoutRunState = Extract<WorkoutRunState, "failed" | "canceled" | "completed">;

export type WorkoutInputRevision = {
  readonly inputRevisionId: WorkoutInputRevisionId;
  readonly revision: number;
  readonly protectedPromptSnapshotId: string;
  readonly promptDigest: string;
  readonly effectiveInputDigest: string;
  readonly createdAt: string;
};

export type WorkoutClarificationFieldKey =
  | "conditionStatus"
  | "recoveryStage"
  | "severityBand"
  | "affectedLaterality";

export type WorkoutClarificationAllowedValue = {
  readonly value: string;
  readonly label: string;
};

/** Safe, browser-visible clarification metadata. Evidence identity is represented only by an opaque reference. */
export type WorkoutClarificationField = {
  readonly id: string;
  /** Server-owned semantic key used to serialize the answer; it is not an evidence identifier. */
  readonly key: WorkoutClarificationFieldKey;
  readonly label: string;
  readonly allowedValues: readonly WorkoutClarificationAllowedValue[];
  readonly evidenceReference: string;
};

export type WorkoutClarificationDescriptor = {
  readonly schemaVersion: "workout-clarification/v1";
  readonly fields: readonly WorkoutClarificationField[];
};

export type WorkoutRunClaim = {
  readonly generation: number;
  readonly workerId: string;
  readonly claimedAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
};

/**
 * Typed, bounded controls accepted by the connected adjustment route.  These
 * controls are persisted inside the protected input revision; they are never
 * trusted from a browser projection or copied into a historical run.
 */
export const WORKOUT_ADJUSTMENT_INTENSITIES = ["light", "moderate", "hard"] as const;
export type WorkoutAdjustmentIntensity = (typeof WORKOUT_ADJUSTMENT_INTENSITIES)[number];

export type WorkoutAdjustmentInjuryApplicability = {
  readonly conditionStatus?: string;
  readonly recoveryStage?: string;
  readonly severityBand?: string;
  readonly affectedLaterality?: "left" | "right" | "bilateral" | "unknown";
};

export type WorkoutAdjustmentEquipment = {
  /** Complete replacement set when supplied; IDs are reviewed Movement IDs. */
  readonly availableEquipmentConceptIds: readonly string[];
};

export type WorkoutAdjustment = {
  readonly prompt?: string;
  readonly durationMinutes?: number;
  readonly intensity?: WorkoutAdjustmentIntensity;
  readonly exclusions?: readonly string[];
  readonly injuryApplicability?: Readonly<WorkoutAdjustmentInjuryApplicability>;
  readonly equipment?: Readonly<WorkoutAdjustmentEquipment>;
};

export const WORKOUT_ADJUSTMENT_KEYS = [
  "prompt", "durationMinutes", "intensity", "exclusions", "injuryApplicability", "equipment",
] as const;
export type WorkoutAdjustmentKey = (typeof WORKOUT_ADJUSTMENT_KEYS)[number];

export type WorkoutAdjustmentValidation =
  | { readonly status: "valid"; readonly value: WorkoutAdjustment }
  | { readonly status: "invalid-request"; readonly reason: string };

export type WorkoutRunAdjustmentInput = {
  readonly predecessorRunId: WorkoutRunId;
  readonly predecessorWorkoutVersionId: WorkoutVersionId;
  readonly adjustment: Readonly<WorkoutAdjustment>;
};

const ADJUSTMENT_MAX_PROMPT_LENGTH = 500;
const ADJUSTMENT_MAX_EXCLUSIONS = 16;
const ADJUSTMENT_MAX_EQUIPMENT = 32;
const ADJUSTMENT_MAX_FIELD_LENGTH = 100;

function boundedText(value: unknown, maximum = ADJUSTMENT_MAX_FIELD_LENGTH): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

/** Validate and normalize the JSON-shaped adjustment boundary. */
export function validateWorkoutAdjustment(value: unknown): WorkoutAdjustmentValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "invalid-request", reason: "adjustment-object-required" };
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !(WORKOUT_ADJUSTMENT_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) return { status: "invalid-request", reason: "unknown-adjustment-key" };
  if (raw.prompt !== undefined && !boundedText(raw.prompt, ADJUSTMENT_MAX_PROMPT_LENGTH)) return { status: "invalid-request", reason: "invalid-prompt" };
  if (raw.durationMinutes !== undefined && (!Number.isInteger(raw.durationMinutes) || Number(raw.durationMinutes) < 30 || Number(raw.durationMinutes) > 60 || Number(raw.durationMinutes) % 5 !== 0)) {
    return { status: "invalid-request", reason: "invalid-duration" };
  }
  if (raw.intensity !== undefined && !(WORKOUT_ADJUSTMENT_INTENSITIES as readonly unknown[]).includes(raw.intensity)) return { status: "invalid-request", reason: "invalid-intensity" };
  let exclusions: readonly string[] | undefined;
  if (raw.exclusions !== undefined) {
    if (!Array.isArray(raw.exclusions) || raw.exclusions.length > ADJUSTMENT_MAX_EXCLUSIONS || raw.exclusions.some((item) => !boundedText(item))) {
      return { status: "invalid-request", reason: "invalid-exclusions" };
    }
    exclusions = [...new Set(raw.exclusions.map((item) => (item as string).trim()))];
  }
  let injuryApplicability: WorkoutAdjustmentInjuryApplicability | undefined;
  if (raw.injuryApplicability !== undefined) {
    if (!raw.injuryApplicability || typeof raw.injuryApplicability !== "object" || Array.isArray(raw.injuryApplicability)) return { status: "invalid-request", reason: "invalid-injury-applicability" };
    const injury = raw.injuryApplicability as Record<string, unknown>;
    const injuryKeys = ["conditionStatus", "recoveryStage", "severityBand", "affectedLaterality"] as const;
    if (Object.keys(injury).some((key) => !(injuryKeys as readonly string[]).includes(key))) return { status: "invalid-request", reason: "unknown-injury-key" };
    for (const key of injuryKeys.slice(0, 3)) if (injury[key] !== undefined && !boundedText(injury[key])) return { status: "invalid-request", reason: "invalid-injury-field" };
    if (injury.affectedLaterality !== undefined && !["left", "right", "bilateral", "unknown"].includes(String(injury.affectedLaterality))) return { status: "invalid-request", reason: "invalid-laterality" };
    injuryApplicability = Object.fromEntries(Object.entries(injury).filter(([, item]) => item !== undefined).map(([key, item]) => [key, typeof item === "string" ? item.trim() : item])) as WorkoutAdjustmentInjuryApplicability;
  }
  let equipment: WorkoutAdjustmentEquipment | undefined;
  if (raw.equipment !== undefined) {
    if (!raw.equipment || typeof raw.equipment !== "object" || Array.isArray(raw.equipment)) return { status: "invalid-request", reason: "invalid-equipment" };
    const equipmentRaw = raw.equipment as Record<string, unknown>;
    if (Object.keys(equipmentRaw).some((key) => key !== "availableEquipmentConceptIds")) return { status: "invalid-request", reason: "unknown-equipment-key" };
    if (!Array.isArray(equipmentRaw.availableEquipmentConceptIds) || equipmentRaw.availableEquipmentConceptIds.length > ADJUSTMENT_MAX_EQUIPMENT
      || equipmentRaw.availableEquipmentConceptIds.some((item) => !boundedText(item, 160) || !(item as string).startsWith("equipment:"))) return { status: "invalid-request", reason: "invalid-equipment" };
    const ids = [...new Set(equipmentRaw.availableEquipmentConceptIds.map((item) => (item as string).trim()))];
    equipment = { availableEquipmentConceptIds: ids };
  }
  const normalized: WorkoutAdjustment = {
    ...(raw.prompt === undefined ? {} : { prompt: (raw.prompt as string).trim() }),
    ...(raw.durationMinutes === undefined ? {} : { durationMinutes: raw.durationMinutes as number }),
    ...(raw.intensity === undefined ? {} : { intensity: raw.intensity as WorkoutAdjustmentIntensity }),
    ...(exclusions === undefined ? {} : { exclusions }),
    ...(injuryApplicability === undefined ? {} : { injuryApplicability }),
    ...(equipment === undefined ? {} : { equipment }),
  };
  if (Object.keys(normalized).length === 0) return { status: "invalid-request", reason: "empty-adjustment" };
  return { status: "valid", value: normalized };
}

export type ResolvedConstraintSnapshot = {
  readonly schemaVersion: "resolved-constraint-snapshot/v1";
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly canonicalConstraintIds: readonly string[];
  readonly applicabilityAssertionIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly zeroMatchCertificates: readonly {
    readonly resolverId: string;
    readonly canonicalQuery: string;
    readonly searchPolicyVersion: string;
    readonly maximumResults: number;
    readonly emptyResult: true;
    readonly evidenceId: string;
  }[];
  readonly resolverVersion: string;
  readonly searchPolicyVersion: string;
  readonly digest: string;
};

export type WorkoutRevisionSealArtifact = {
  readonly schemaVersion: "workout-revision-seals/v1";
  readonly movementGraphRevisionId: string;
  readonly movementGraphSealId: string;
  readonly movementGraphSealDigest: string;
  readonly memberContextRevisionId: string;
  readonly memberContextSealId: string;
  readonly memberContextSealDigest: string;
};

export type WorkoutValidationReceipt = {
  readonly runId: WorkoutRunId;
  readonly claimGeneration: number;
  readonly requestDigest: string;
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly revisionSealDigest: string;
  readonly resolvedConstraintDigest: string;
  readonly safetyEnvelopeDigest: string;
  readonly completeDecisionSetDigest: string;
  readonly modelProposalDigest: string;
  readonly workoutPayloadDigest: string;
  readonly provenanceDigest: string;
  readonly durationPolicyVersion: string;
  readonly policyVersion: string;
  readonly schemaVersion: "workout-validation-receipt/v1";
};

export type WorkoutRunFailure = {
  readonly kind:
    | "authorization-denied"
    | "graph-unavailable"
    | "insufficient-safety-context"
    | "clarification-required"
    | "provider-failure"
    | "proposal-invalid"
    | "claim-lost"
    | "canceled";
  readonly stage: string;
  readonly safeMessage: string;
  readonly occurredAt: string;
};

export type WorkoutRun = {
  readonly runId: WorkoutRunId;
  readonly coachId: string;
  readonly memberId: string;
  readonly authorizationReferenceId: string;
  readonly idempotencyKeyDigest: string;
  readonly requestDigest: string;
  readonly requestedDurationMinutes: number;
  readonly modelConfigurationId: string;
  readonly policyRevision: string;
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly state: WorkoutRunState;
  readonly inputRevisions: readonly WorkoutInputRevision[];
  readonly activeInputRevisionId: WorkoutInputRevisionId;
  /** Present only while the run awaits a typed, server-owned safety answer. */
  readonly clarification?: Readonly<WorkoutClarificationDescriptor>;
  readonly claim?: Readonly<WorkoutRunClaim>;
  readonly constraintSnapshot?: Readonly<ResolvedConstraintSnapshot>;
  readonly failure?: Readonly<WorkoutRunFailure>;
  readonly retryOfRunId?: WorkoutRunId;
  /** Adjustment lineage. The predecessor is immutable and is never overwritten. */
  readonly predecessorRunId?: WorkoutRunId;
  readonly predecessorWorkoutVersionId?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
};

export type CompletedWorkoutRun = WorkoutRun & {
  readonly state: "completed";
  readonly endedAt: string;
  readonly workoutVersion: ImmutableWorkoutVersion;
  readonly provenance: WorkoutProvenanceBundle;
  readonly validationReceipt: WorkoutValidationReceipt;
};
