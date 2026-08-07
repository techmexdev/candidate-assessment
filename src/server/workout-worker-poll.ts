export type WorkoutWorkerPollResult = { readonly status: string };

export type WorkoutWorkerPollOptions = {
  readonly runNext: (input: { readonly signal: AbortSignal }) => Promise<WorkoutWorkerPollResult>;
  readonly signal: AbortSignal;
  readonly pollEveryMs: number;
  readonly onResult?: (result: WorkoutWorkerPollResult) => void;
};

function waitForPoll(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Shared long-lived queue loop used by the detached worker and connected acceptance. */
export async function runWorkoutWorkerPoll(options: WorkoutWorkerPollOptions): Promise<void> {
  if (!Number.isSafeInteger(options.pollEveryMs) || options.pollEveryMs <= 0) throw new Error("pollEveryMs must be a positive integer");
  while (!options.signal.aborted) {
    try {
      const result = await options.runNext({ signal: options.signal });
      options.onResult?.(result);
      if (result.status === "claim-lost" && options.signal.aborted) break;
      if (result.status === "not-claimable") await waitForPoll(options.signal, options.pollEveryMs);
    } catch (error) {
      if (options.signal.aborted) break;
      throw error;
    }
  }
}
