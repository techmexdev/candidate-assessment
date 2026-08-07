import type { WorkoutRunId } from "../../domain/contracts/workout";
import type { WorkoutRun } from "../../domain/contracts/workout-run";
import type { WorkoutAuthorizationStage, WorkerAuthorizationPort } from "../ports/worker-authorization";
import type { WorkoutRunRepository } from "../ports/workout-run-repository";

type InteractiveStage = Extract<WorkoutAuthorizationStage, "read" | "replay" | "clarification" | "retry" | "cancel">;

export type WorkoutRunAccessInput = {
  readonly runId: WorkoutRunId;
  readonly coachId: string;
  readonly memberId: string;
  readonly sessionAuthorizationId: string;
};

/** Requires the live member scope and the run's durable grant without exposing which check failed. */
export async function authorizeWorkoutRunAccess(
  dependencies: { readonly repository: WorkoutRunRepository; readonly authorization: WorkerAuthorizationPort },
  input: WorkoutRunAccessInput,
  stage: InteractiveStage,
): Promise<WorkoutRun | undefined> {
  if (!input.sessionAuthorizationId.trim()) return undefined;
  const currentSession = await dependencies.authorization.authorizeSession({
    sessionAuthorizationId: input.sessionAuthorizationId,
    coachId: input.coachId,
    memberId: input.memberId,
    stage,
  });
  if (currentSession.status !== "authorized") return undefined;

  const run = await dependencies.repository.getRun(input.runId, input.coachId, input.memberId);
  if (!run) return undefined;
  const durableGrant = await dependencies.authorization.authorize({
    authorizationReferenceId: run.authorizationReferenceId,
    runId: run.runId,
    coachId: run.coachId,
    memberId: run.memberId,
    stage,
  });
  return durableGrant.status === "authorized" ? run : undefined;
}
