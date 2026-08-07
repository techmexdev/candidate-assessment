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

  const runClaimed = async (claimed: ClaimedRun, signal?: AbortSignal): Promise<ExecuteWorkoutRunResult> => {
      const leaseExpiresAt = claimed.run.claim?.expiresAt ?? expiresAt(dependencies.now(), dependencies.leaseDurationMs);
      const execution = new AbortController();
      let stopped = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let stopHeartbeat: () => void = () => undefined;
      let settleCancellation!: (result: ExecuteWorkoutRunResult) => void;
      const cancellation = new Promise<ExecuteWorkoutRunResult>((resolve) => { settleCancellation = resolve; });
      const stopForClaimLoss = (reason: unknown) => {
        if (stopped) return;
        stopped = true;
        stopHeartbeat();
        if (watchdog) clearTimeout(watchdog);
        execution.abort(reason);
        settleCancellation({ status: "claim-lost" });
      };
      const resetWatchdog = (renewedExpiresAt: string) => {
        if (watchdog) clearTimeout(watchdog);
        const remainingMs = Date.parse(renewedExpiresAt) - Date.parse(dependencies.now());
        if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
          stopForClaimLoss(new Error("Workout run lease expired"));
          return;
        }
        watchdog = setTimeout(
          () => stopForClaimLoss(new Error("Workout run lease expired")),
          remainingMs,
        );
        watchdog.unref?.();
      };
      const cancelExecution = () => stopForClaimLoss(signal?.reason);
      signal?.addEventListener("abort", cancelExecution, { once: true });
      resetWatchdog(claimed.run.claim?.expiresAt ?? leaseExpiresAt);
      const heartbeat = async () => {
        if (stopped) return;
        try {
          const at = dependencies.now();
          const renewed = await dependencies.repository.heartbeat(claimed.fence, at, expiresAt(at, dependencies.leaseDurationMs));
          if (stopped) return;
          if (renewed.status === "updated") {
            resetWatchdog(renewed.run.claim?.expiresAt ?? expiresAt(at, dependencies.leaseDurationMs));
            return;
          }
        } catch {
          // Repository failures lose the claim just like an explicit stale fence.
        }
        stopForClaimLoss(new Error("Workout run claim was lost"));
      };
      try {
        if (signal?.aborted) stopForClaimLoss(signal.reason);
        await Promise.race([heartbeat(), cancellation]);
        if (stopped) return { status: "claim-lost" };
        stopHeartbeat = (dependencies.startHeartbeat ?? defaultHeartbeatScheduler)(heartbeat, dependencies.heartbeatEveryMs);
        const executionResult = dependencies.executeClaimed({
          runId: claimed.run.runId,
          workerId: dependencies.workerId,
          leaseExpiresAt,
          claimed,
          signal: execution.signal,
        });
        const result = await Promise.race([executionResult, cancellation]);
        return stopped ? { status: "claim-lost" } : result;
      } finally {
        stopped = true;
        stopHeartbeat();
        if (watchdog) clearTimeout(watchdog);
        signal?.removeEventListener("abort", cancelExecution);
      }
  };

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
      return runClaimed(claimed, input.signal);
    },
    /** Queue mode uses only the claimed run/fence returned by the repository. */
    async runClaimed(claimed: ClaimedRun, signal?: AbortSignal): Promise<ExecuteWorkoutRunResult> {
      return runClaimed(claimed, signal);
    },
  };
}
