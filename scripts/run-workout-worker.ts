import { asWorkoutRunId } from "../src/domain/contracts/workout";
import { createConfiguredWorkoutWorkerComposition } from "../src/server/workout-worker-composition";

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined;
  if (!value || value.startsWith("--")) throw new Error(`--${name} is required`);
  return value;
}

function hasArgument(name: string) {
  return process.argv.includes(`--${name}`);
}

function positiveEnvironment(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const controller = new AbortController();
const stop = () => controller.abort(new Error("Workout worker interrupted"));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

const composition = createConfiguredWorkoutWorkerComposition();
try {
  if (!hasArgument("poll")) {
    const invocation = {
      runId: asWorkoutRunId(argument("run-id")),
      coachId: argument("coach-id"),
      memberId: argument("member-id"),
    };
    const result = await composition.runExplicit({ ...invocation, signal: controller.signal });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== "completed" && result.status !== "awaiting-clarification") process.exitCode = 1;
  } else {
    const pollEveryMs = positiveEnvironment("WORKOUT_WORKER_POLL_MS", 1_000);
    while (!controller.signal.aborted) {
      const result = await composition.runNext({ signal: controller.signal });
      if (result.status !== "not-claimable") process.stdout.write(`${JSON.stringify({ status: result.status })}\n`);
      if (result.status === "claim-lost" && controller.signal.aborted) break;
      if (result.status === "not-claimable") await new Promise((resolve) => setTimeout(resolve, pollEveryMs));
    }
  }
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await composition.close();
}
