import type { WorkoutRunId } from "../domain/contracts/workout";
import type { ExecuteWorkoutRunResult } from "../application/use-cases/execute-workout-run";
import type { ClaimWorkoutRun } from "../application/use-cases/claim-workout-run";
import type { ClaimWorkoutRunResult, WorkoutRunRepository } from "../application/ports/workout-run-repository";

type ClaimedRun = Extract<ClaimWorkoutRunResult, { readonly status: "claimed" }>;

export type WorkoutRunWorkerDependencies = {
  readonly repository: WorkoutRunRepository;
  readonly claim: ClaimWorkoutRun;
  readonly executeClaimed: (input: {
    readonly runId: WorkoutRunId;
    readonly workerId: string;
    readonly leaseExpiresAt: string;
    readonly claimed: ClaimedRun;
    readonly signal: AbortSignal;
  }) => Promise<ExecuteWorkoutRunResult>;
  readonly workerId: string;
  readonly now: () => string;
  readonly leaseDurationMs: number;
  readonly heartbeatEveryMs: number;
  readonly startHeartbeat?: (heartbeat: () => Promise<void>, intervalMs: number) => () => void;
};

const expiresAt = (now: string, durationMs: number) => new Date(Date.parse(now) + durationMs).toISOString();

function defaultHeartbeatScheduler(heartbeat: () => Promise<void>, intervalMs: number) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer = setTimeout(async () => {
      await heartbeat();
      if (!stopped) schedule();
    }, intervalMs);
    timer.unref?.();
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** A separately invokable worker entry point. Request handlers never call it. */
export function createWorkoutRunWorker(dependencies: WorkoutRunWorkerDependencies) {
  if (!dependencies.workerId.trim()) throw new Error("workerId must not be empty");
  if (!Number.isFinite(dependencies.leaseDurationMs) || dependencies.leaseDurationMs <= 0) throw new Error("leaseDurationMs must be positive");
  if (!Number.isFinite(dependencies.heartbeatEveryMs) || dependencies.heartbeatEveryMs <= 0
    || dependencies.heartbeatEveryMs >= dependencies.leaseDurationMs) throw new Error("heartbeatEveryMs must be positive and shorter than the lease");

  return {
    async runOnce(input: { readonly runId: WorkoutRunId; readonly coachId: string; readonly memberId: string; readonly signal?: AbortSignal }): Promise<ExecuteWorkoutRunResult> {
      const claimedAt = dependencies.now();
      const leaseExpiresAt = expiresAt(claimedAt, dependencies.leaseDurationMs);
      const claimed = await dependencies.claim({
        ...input,
        workerId: dependencies.workerId,
        now: claimedAt,
        expiresAt: leaseExpiresAt,
      });
      if (claimed.status !== "claimed") return { status: "not-claimable" };

      let heartbeatLost = false;
      const execution = new AbortController();
      const cancelExecution = () => execution.abort(input.signal?.reason);
      input.signal?.addEventListener("abort", cancelExecution, { once: true });
      const timeout = setTimeout(() => execution.abort(new Error("Workout run lease expired")), dependencies.leaseDurationMs);
      timeout.unref?.();
      const heartbeat = async () => {
        try {
          const at = dependencies.now();
          const renewed = await dependencies.repository.heartbeat(claimed.fence, at, expiresAt(at, dependencies.leaseDurationMs));
          if (renewed.status === "updated") return;
        } catch {
          // Repository failures lose the claim just like an explicit stale fence.
        }
        if (!heartbeatLost) {
          heartbeatLost = true;
          execution.abort(new Error("Workout run claim was lost"));
        }
      };
      let stopHeartbeat: () => void = () => undefined;
      try {
        await heartbeat();
        if (heartbeatLost) return { status: "claim-lost" };
        stopHeartbeat = (dependencies.startHeartbeat ?? defaultHeartbeatScheduler)(heartbeat, dependencies.heartbeatEveryMs);
        const result = await dependencies.executeClaimed({
          runId: input.runId,
          workerId: dependencies.workerId,
          leaseExpiresAt,
          claimed,
          signal: execution.signal,
        });
        return heartbeatLost && result.status === "completed" ? { status: "claim-lost" } : result;
      } finally {
        stopHeartbeat();
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", cancelExecution);
      }
    },
  };
}
