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
  | "adjustment"
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
  /**
   * Revalidates the current interactive session for the requested member.
   * Keeping this check behind the port lets stateful adapters honor scope
   * changes or revocation even when an older durable run grant remains valid.
   */
  authorizeSession(input: {
    readonly sessionAuthorizationId: string;
    readonly coachId: string;
    readonly memberId: string;
    readonly stage: Extract<WorkoutAuthorizationStage, "read" | "replay" | "clarification" | "retry" | "adjustment" | "cancel">;
  }): Promise<WorkerGrantAuthorization>;
  createReference(input: {
    readonly coachId: string;
    readonly memberId: string;
    readonly runId: WorkoutRunId;
    readonly sessionAuthorizationId: string;
    /** Stable key for idempotent provisioning after a durable creation reservation. */
    readonly provisioningKey: string;
    readonly provisionedAt: string;
  }): Promise<WorkerGrantReferenceResult>;
  authorize(input: {
    readonly authorizationReferenceId: string;
    readonly coachId: string;
    readonly memberId: string;
    readonly runId: WorkoutRunId;
    readonly stage: WorkoutAuthorizationStage;
  }): Promise<WorkerGrantAuthorization>;
}
