import type { ImmutableWorkoutVersion, WorkoutInputRevisionId, WorkoutRunId } from "./workout";
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
