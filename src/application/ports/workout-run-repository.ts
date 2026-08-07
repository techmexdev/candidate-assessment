import type { CompletedWorkoutRun, ResolvedConstraintSnapshot, WorkoutRun, WorkoutRunFailure, WorkoutValidationReceipt } from "../../domain/contracts/workout-run";
import type { ImmutableWorkoutVersion, WorkoutRunId } from "../../domain/contracts/workout";
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

export interface WorkoutRunRepository {
  createOrFind(run: WorkoutRun): Promise<CreateWorkoutRunResult>;
  claim(runId: WorkoutRunId, workerId: string, now: string, expiresAt: string): Promise<ClaimWorkoutRunResult>;
  heartbeat(fence: WorkoutRunFence, now: string, expiresAt: string): Promise<FencedMutationResult>;
  saveConstraintSnapshot(fence: WorkoutRunFence, snapshot: ResolvedConstraintSnapshot): Promise<FencedMutationResult>;
  fail(fence: WorkoutRunFence, failure: WorkoutRunFailure): Promise<FencedMutationResult>;
  cancel(runId: WorkoutRunId, coachId: string, memberId: string, at: string): Promise<FencedMutationResult>;
  complete(input: CompleteWorkoutRunInput): Promise<{ readonly status: "completed"; readonly run: CompletedWorkoutRun } | { readonly status: "stale-fence" | "canceled" | "invalid-receipt" | "missing" }>;
  getRun(runId: WorkoutRunId, coachId: string, memberId: string): Promise<WorkoutRun | undefined>;
  getWorkout(runId: WorkoutRunId, coachId: string, memberId: string): Promise<ImmutableWorkoutVersion | undefined>;
  getProvenance(runId: WorkoutRunId, coachId: string, memberId: string): Promise<WorkoutProvenanceBundle | undefined>;
}
