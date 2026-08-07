import type { WorkoutRunRepository } from "../ports/workout-run-repository";
import type { WorkerAuthorizationPort } from "../ports/worker-authorization";
import { authorizeWorkoutRunAccess, type WorkoutRunAccessInput } from "./authorize-workout-run-access";

export type CancelWorkoutRunResult = { readonly status: "canceled" | "already_completed" | "already-terminal" | "not-found" };

export function createCancelWorkoutRun(dependencies: {
  readonly repository: WorkoutRunRepository;
  readonly authorization: WorkerAuthorizationPort;
  readonly now: () => string;
}) {
  return async (input: WorkoutRunAccessInput): Promise<CancelWorkoutRunResult> => {
    let run = await authorizeWorkoutRunAccess(dependencies, input, "cancel");
    if (!run) return { status: "not-found" };
    if (run.state === "completed") return { status: "already_completed" };
    if (run.state === "failed" || run.state === "canceled") return { status: "already-terminal" };
    const canceled = await dependencies.repository.cancel(run.runId, run.coachId, run.memberId, dependencies.now());
    if (canceled.status === "updated") return { status: "canceled" };
    if (canceled.status === "missing") return { status: "not-found" };
    run = await dependencies.repository.getRun(input.runId, input.coachId, input.memberId);
    return { status: run?.state === "completed" ? "already_completed" : run ? "already-terminal" : "not-found" };
  };
}
