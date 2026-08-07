import type { CompletedWorkoutRun, ResolvedConstraintSnapshot, WorkoutRun, WorkoutRunFailure, WorkoutValidationReceipt } from "../../domain/contracts/workout-run";
import type { ImmutableWorkoutVersion, WorkoutInputRevisionId, WorkoutRunId } from "../../domain/contracts/workout";
import type { WorkoutProvenanceBundle } from "../../domain/contracts/workout-provenance";

export type WorkoutRunFence = {
  readonly runId: WorkoutRunId;
  readonly generation: number;
  readonly workerId: string;
};

export type CreateWorkoutRunResult =
  | { readonly status: "created" | "replayed"; readonly run: WorkoutRun }
  | { readonly status: "idempotency-conflict" };

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

export type WorkoutRunEventReadResult =
  | {
      readonly status: "ready";
      readonly events: readonly WorkoutRunEvent[];
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
  createOrFind(run: WorkoutRun): Promise<CreateWorkoutRunResult>;
  claim(runId: WorkoutRunId, workerId: string, now: string, expiresAt: string): Promise<ClaimWorkoutRunResult>;
  heartbeat(fence: WorkoutRunFence, now: string, expiresAt: string): Promise<FencedMutationResult>;
  saveConstraintSnapshot(fence: WorkoutRunFence, snapshot: ResolvedConstraintSnapshot): Promise<FencedMutationResult>;
  appendEvent(fence: WorkoutRunFence, event: AppendWorkoutRunEvent): Promise<FencedMutationResult>;
  awaitClarification(fence: WorkoutRunFence, at: string, candidateConceptIds: readonly string[]): Promise<ClarificationMutationResult>;
  answerClarification(runId: WorkoutRunId, coachId: string, memberId: string, revision: WorkoutRunInputRevision): Promise<ClarificationMutationResult>;
  createRetry(failedRunId: WorkoutRunId, coachId: string, memberId: string, retry: WorkoutRun): Promise<RetryWorkoutRunResult>;
  fail(fence: WorkoutRunFence, failure: WorkoutRunFailure): Promise<FencedMutationResult>;
  cancel(runId: WorkoutRunId, coachId: string, memberId: string, at: string): Promise<FencedMutationResult>;
  complete(input: CompleteWorkoutRunInput): Promise<{ readonly status: "completed"; readonly run: CompletedWorkoutRun } | { readonly status: "stale-fence" | "canceled" | "invalid-receipt" | "missing" }>;
  getRun(runId: WorkoutRunId, coachId: string, memberId: string): Promise<WorkoutRun | undefined>;
  getWorkout(runId: WorkoutRunId, coachId: string, memberId: string): Promise<ImmutableWorkoutVersion | undefined>;
  getProvenance(runId: WorkoutRunId, coachId: string, memberId: string): Promise<WorkoutProvenanceBundle | undefined>;
  readEvents(runId: WorkoutRunId, coachId: string, memberId: string, options: { readonly cursor?: string; readonly limit: number }): Promise<WorkoutRunEventReadResult>;
}
