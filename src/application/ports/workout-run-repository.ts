import type { CatalogSafetyReadyResult } from "../../domain/contracts/catalog-safety";
import type { CompletedWorkoutRun, ResolvedConstraintSnapshot, WorkoutClarificationDescriptor, WorkoutRevisionSealArtifact, WorkoutRun, WorkoutRunFailure, WorkoutValidationReceipt } from "../../domain/contracts/workout-run";
import type { ImmutableWorkoutVersion, WorkoutInputRevisionId, WorkoutRunId } from "../../domain/contracts/workout";
import type { WorkoutProvenanceBundle } from "../../domain/contracts/workout-provenance";
import type { WorkoutCompositionProposal } from "../../domain/policies/workout-composition";

export type WorkoutRunFence = {
  readonly runId: WorkoutRunId;
  readonly generation: number;
  readonly workerId: string;
};

export type CreateWorkoutRunResult =
  | { readonly status: "created" | "replayed"; readonly run: WorkoutRun }
  | { readonly status: "idempotency-conflict" };

export type WorkoutRunCreationReservation = {
  readonly coachId: string;
  readonly memberId: string;
  readonly action: "generate-workout";
  readonly idempotencyKeyDigest: string;
  readonly requestDigest: string;
  readonly runId: WorkoutRunId;
  readonly ownerId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
};

export type ReserveWorkoutRunCreationResult =
  | { readonly status: "reserved"; readonly reservation: WorkoutRunCreationReservation }
  | { readonly status: "pending" }
  | { readonly status: "replayed"; readonly run: WorkoutRun }
  | { readonly status: "idempotency-conflict" };

export type FinalizeWorkoutRunCreationResult =
  | { readonly status: "created" | "replayed"; readonly run: WorkoutRun }
  | { readonly status: "idempotency-conflict" | "stale-reservation" };

export type ClaimWorkoutRunResult =
  | { readonly status: "claimed"; readonly run: WorkoutRun; readonly fence: WorkoutRunFence }
  | { readonly status: "not-claimable" | "missing" };

export type FencedMutationResult =
  | { readonly status: "updated"; readonly run: WorkoutRun }
  | { readonly status: "stale-fence" | "terminal" | "missing" };

export type CompleteWorkoutRunInput = {
  readonly fence: WorkoutRunFence;
  readonly authorizationReferenceId: string;
  readonly workoutVersion: ImmutableWorkoutVersion;
  readonly provenance: WorkoutProvenanceBundle;
  readonly validationReceipt: WorkoutValidationReceipt;
};

export type WorkoutCompletionArtifact =
  | { readonly kind: "revision-seals"; readonly payload: Readonly<WorkoutRevisionSealArtifact> }
  | { readonly kind: "safety-envelope"; readonly payload: Readonly<CatalogSafetyReadyResult> }
  | { readonly kind: "model-proposal"; readonly payload: Readonly<WorkoutCompositionProposal> };

/** Authorized, immutable material needed to re-verify a completed run on read. */
export type WorkoutCompletionProjection = {
  readonly revisionSeals: Readonly<WorkoutRevisionSealArtifact>;
  readonly safetyEnvelope: Readonly<CatalogSafetyReadyResult>;
  readonly modelProposal: Readonly<WorkoutCompositionProposal>;
  readonly validationReceipt: Readonly<WorkoutValidationReceipt>;
};

export type WorkoutRunEventKind =
  | "queued"
  | "claimed"
  | "heartbeat"
  | "stage"
  | "awaiting-clarification"
  | "clarification-answered"
  | "failed"
  | "canceled"
  | "completed";

export type WorkoutRunEvent = {
  readonly eventId: string;
  readonly schemaVersion: "workout-run-event/v1";
  readonly runId: WorkoutRunId;
  readonly sequence: number;
  readonly kind: WorkoutRunEventKind;
  readonly occurredAt: string;
  readonly safeData: Readonly<Record<string, string | number | boolean | null>>;
};

export type AppendWorkoutRunEvent = Pick<WorkoutRunEvent, "kind" | "occurredAt" | "safeData">;

export type WorkoutRunEventPageEntry = {
  readonly event: WorkoutRunEvent;
  /** Cursor that resumes immediately after this event. */
  readonly cursor: string;
};

export type WorkoutRunEventReadResult =
  | {
      readonly status: "ready";
      readonly events: readonly WorkoutRunEventPageEntry[];
      readonly nextCursor: string;
      readonly highWaterSequence: number;
    }
  | { readonly status: "resync_required"; readonly snapshotUrl: string }
  | { readonly status: "not-found" };

export type WorkoutRunInputRevision = {
  readonly inputRevisionId: WorkoutInputRevisionId;
  readonly revision: number;
  readonly protectedPromptSnapshotId: string;
  readonly promptDigest: string;
  readonly effectiveInputDigest: string;
  readonly createdAt: string;
};

export type ClarificationMutationResult =
  | { readonly status: "updated"; readonly run: WorkoutRun }
  | { readonly status: "stale-fence" | "invalid-state" | "invalid-revision" | "missing" };

export type RetryWorkoutRunResult = CreateWorkoutRunResult | { readonly status: "not-retryable" | "missing" };

export interface WorkoutRunRepository {
  reserveCreation(input: WorkoutRunCreationReservation): Promise<ReserveWorkoutRunCreationResult>;
  finalizeCreation(reservation: WorkoutRunCreationReservation, run: WorkoutRun): Promise<FinalizeWorkoutRunCreationResult>;
  releaseCreation(reservation: WorkoutRunCreationReservation): Promise<void>;
  createOrFind(run: WorkoutRun): Promise<CreateWorkoutRunResult>;
  claim(runId: WorkoutRunId, workerId: string, now: string, expiresAt: string): Promise<ClaimWorkoutRunResult>;
  heartbeat(fence: WorkoutRunFence, now: string, expiresAt: string): Promise<FencedMutationResult>;
  saveConstraintSnapshot(fence: WorkoutRunFence, snapshot: ResolvedConstraintSnapshot): Promise<FencedMutationResult>;
  saveCompletionArtifact(fence: WorkoutRunFence, artifact: WorkoutCompletionArtifact): Promise<FencedMutationResult>;
  appendEvent(fence: WorkoutRunFence, event: AppendWorkoutRunEvent): Promise<FencedMutationResult>;
  awaitClarification(
    fence: WorkoutRunFence,
    at: string,
    clarification: WorkoutClarificationDescriptor | readonly string[],
  ): Promise<ClarificationMutationResult>;
  answerClarification(runId: WorkoutRunId, coachId: string, memberId: string, revision: WorkoutRunInputRevision): Promise<ClarificationMutationResult>;
  createRetry(failedRunId: WorkoutRunId, coachId: string, memberId: string, retry: WorkoutRun): Promise<RetryWorkoutRunResult>;
  fail(fence: WorkoutRunFence, failure: WorkoutRunFailure): Promise<FencedMutationResult>;
  cancel(runId: WorkoutRunId, coachId: string, memberId: string, at: string): Promise<FencedMutationResult>;
  complete(input: CompleteWorkoutRunInput): Promise<{ readonly status: "completed"; readonly run: CompletedWorkoutRun } | { readonly status: "stale-fence" | "canceled" | "invalid-receipt" | "missing" }>;
  getRun(runId: WorkoutRunId, coachId: string, memberId: string): Promise<WorkoutRun | undefined>;
  getWorkout(runId: WorkoutRunId, coachId: string, memberId: string): Promise<ImmutableWorkoutVersion | undefined>;
  getProvenance(runId: WorkoutRunId, coachId: string, memberId: string): Promise<WorkoutProvenanceBundle | undefined>;
  getCompletionProjection(runId: WorkoutRunId, coachId: string, memberId: string): Promise<WorkoutCompletionProjection | undefined>;
  readEvents(runId: WorkoutRunId, coachId: string, memberId: string, options: { readonly cursor?: string; readonly limit: number }): Promise<WorkoutRunEventReadResult>;
}
