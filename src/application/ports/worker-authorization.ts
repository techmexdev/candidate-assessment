import type { WorkoutRunId } from "../../domain/contracts/workout";

export type WorkoutAuthorizationStage =
  | "claim"
  | "constraints"
  | "catalog"
  | "composition"
  | "validation"
  | "completion"
  | "read"
  | "replay"
  | "clarification"
  | "retry"
  | "cancel";

export type WorkerGrantAuthorization =
  | { readonly status: "authorized"; readonly authorizationId: string }
  | { readonly status: "denied" };

export type WorkerGrantReferenceResult =
  | { readonly status: "authorized"; readonly authorizationReferenceId: string }
  | { readonly status: "denied" };

/**
 * Server-only boundary for durable work authorization. Implementations store a
 * reference to a grant, never a browser credential or process-local scope.
 */
export interface WorkerAuthorizationPort {
  createReference(input: {
    readonly coachId: string;
    readonly memberId: string;
    readonly runId: WorkoutRunId;
    readonly sessionAuthorizationId: string;
  }): Promise<WorkerGrantReferenceResult>;
  authorize(input: {
    readonly authorizationReferenceId: string;
    readonly coachId: string;
    readonly memberId: string;
    readonly runId: WorkoutRunId;
    readonly stage: WorkoutAuthorizationStage;
  }): Promise<WorkerGrantAuthorization>;
}
