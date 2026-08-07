import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkoutRunRepository } from "../../src/application/ports/workout-run-repository";
import { asWorkoutRunId } from "../../src/domain/contracts/workout";
import { createWorkoutRunWorker } from "../../src/workers/workout-run-worker";

const RUN_ID = asWorkoutRunId("workout-run:worker-lease");
const FENCE = { runId: RUN_ID, generation: 1, workerId: "worker:one" } as const;

function claimed(expiresAt: string) {
  return {
    status: "claimed" as const,
    fence: FENCE,
    run: {
      runId: RUN_ID,
      state: "running" as const,
      claim: {
        generation: 1,
        workerId: "worker:one",
        claimedAt: new Date(0).toISOString(),
        heartbeatAt: new Date(0).toISOString(),
        expiresAt,
      },
    },
  };
}

function workerHarness(heartbeat: WorkoutRunRepository["heartbeat"], executeClaimed: () => Promise<{ status: "completed" }>) {
  const repository = { heartbeat } as WorkoutRunRepository;
  return createWorkoutRunWorker({
    repository,
    claim: vi.fn(async (input) => claimed(input.expiresAt)) as never,
    executeClaimed,
    workerId: "worker:one",
    now: () => new Date(Date.now()).toISOString(),
    leaseDurationMs: 100,
    heartbeatEveryMs: 40,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("workout run worker leases", () => {
  it("extends its local watchdog after each successful heartbeat and does not overlap renewals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let heartbeatCalls = 0;
    const never = new Promise<never>(() => undefined);
    const heartbeat = vi.fn<WorkoutRunRepository["heartbeat"]>(async (_fence, at, expiresAt) => {
      heartbeatCalls += 1;
      if (heartbeatCalls === 3) return never;
      return {
        status: "updated",
        run: claimed(expiresAt).run as never,
      };
    });
    const executeClaimed = vi.fn(async () => new Promise<{ status: "completed" }>(() => undefined));
    const worker = workerHarness(heartbeat, executeClaimed);

    let settled = false;
    const result = worker.runOnce({ runId: RUN_ID, coachId: "coach:one", memberId: "member:one" })
      .finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(110);

    expect(settled).toBe(false);
    expect(heartbeat).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30);
    await expect(result).resolves.toEqual({ status: "claim-lost" });
    expect(executeClaimed).toHaveBeenCalledOnce();
  });

  it("settles and stops heartbeats when the caller aborts even if execution ignores its signal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const heartbeat = vi.fn<WorkoutRunRepository["heartbeat"]>(async (_fence, _at, expiresAt) => ({
      status: "updated",
      run: claimed(expiresAt).run as never,
    }));
    const executeClaimed = vi.fn(async () => new Promise<{ status: "completed" }>(() => undefined));
    const worker = workerHarness(heartbeat, executeClaimed);
    const controller = new AbortController();

    const result = worker.runOnce({ runId: RUN_ID, coachId: "coach:one", memberId: "member:one", signal: controller.signal });
    await vi.advanceTimersByTimeAsync(45);
    controller.abort(new Error("caller canceled"));

    await expect(result).resolves.toEqual({ status: "claim-lost" });
    const callsAtAbort = heartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(heartbeat).toHaveBeenCalledTimes(callsAtAbort);
  });
});
