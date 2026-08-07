import type { WorkoutRunId } from "../../domain/contracts/workout";
import type { WorkerAuthorizationPort } from "../ports/worker-authorization";
import type { ClaimWorkoutRunResult, WorkoutRunRepository } from "../ports/workout-run-repository";

export type ClaimWorkoutRunInput = {
  readonly runId: WorkoutRunId;
  readonly coachId: string;
  readonly memberId: string;
  readonly workerId: string;
  readonly now: string;
  readonly expiresAt: string;
};

export type ClaimWorkoutRun = (input: ClaimWorkoutRunInput) => Promise<ClaimWorkoutRunResult>;

export function createClaimWorkoutRun(dependencies: {
  readonly repository: WorkoutRunRepository;
  readonly authorization: WorkerAuthorizationPort;
}): ClaimWorkoutRun {
  return async (input) => {
    const run = await dependencies.repository.getRun(input.runId, input.coachId, input.memberId);
    if (!run) return { status: "missing" };
    const authorization = await dependencies.authorization.authorize({
      authorizationReferenceId: run.authorizationReferenceId,
      runId: run.runId,
      coachId: run.coachId,
      memberId: run.memberId,
      stage: "claim",
    });
    if (authorization.status !== "authorized") return { status: "not-claimable" };
    return dependencies.repository.claim(input.runId, input.workerId, input.now, input.expiresAt);
  };
}
