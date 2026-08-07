import { describe, expect, it } from "vitest";
import { runWorkoutWorkerPoll } from "../../src/server/workout-worker-poll";

describe("workout worker poll loop", () => {
  it("uses the queue entry point until graceful abort", async () => {
    const controller = new AbortController();
    const statuses: string[] = [];
    let calls = 0;
    await runWorkoutWorkerPoll({
      runNext: async ({ signal }) => {
        expect(signal).toBe(controller.signal);
        calls += 1;
        if (calls === 2) controller.abort();
        return { status: "not-claimable" };
      },
      signal: controller.signal,
      pollEveryMs: 1,
      onResult: (result) => statuses.push(result.status),
    });
    expect(calls).toBe(2);
    expect(statuses).toEqual(["not-claimable", "not-claimable"]);
  });

  it("surfaces a non-shutdown worker failure", async () => {
    const failure = new Error("queue unavailable");
    await expect(runWorkoutWorkerPoll({
      runNext: async () => { throw failure; },
      signal: new AbortController().signal,
      pollEveryMs: 1,
    })).rejects.toBe(failure);
  });
});
