import { asWorkoutRunId } from "../src/domain/contracts/workout";
import { createConfiguredWorkoutWorkerComposition } from "../src/server/workout-worker-composition";
import { runWorkoutWorkerPoll } from "../src/server/workout-worker-poll";

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

function signal(status: "starting" | "ready" | "polling" | "intentional-shutdown" | "exited", detail?: string) {
  process.stdout.write(`${JSON.stringify({ status, ...(detail ? { detail } : {}) })}\n`);
}

function errorCode(error: unknown) {
  return error instanceof Error ? error.name : "UnknownError";
}

async function main() {
  const controller = new AbortController();
  let intentionalShutdown = false;
  const stop = () => {
    if (intentionalShutdown) return;
    intentionalShutdown = true;
    signal("intentional-shutdown");
    controller.abort(new Error("Workout worker interrupted"));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  signal("starting");
  let composition: ReturnType<typeof createConfiguredWorkoutWorkerComposition> | undefined;
  try {
    composition = createConfiguredWorkoutWorkerComposition();
    const activeComposition = composition;
    signal("ready");
    if (!hasArgument("poll")) {
      const invocation = {
        runId: asWorkoutRunId(argument("run-id")),
        coachId: argument("coach-id"),
        memberId: argument("member-id"),
      };
      const result = await activeComposition.runExplicit({ ...invocation, signal: controller.signal });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.status !== "completed" && result.status !== "awaiting-clarification") process.exitCode = 1;
    } else {
      const pollEveryMs = positiveEnvironment("WORKOUT_WORKER_POLL_MS", 1_000);
      signal("polling");
      await runWorkoutWorkerPoll({
        runNext: (input) => activeComposition.runNext(input),
        signal: controller.signal,
        pollEveryMs,
        onResult: (result) => {
          if (result.status !== "not-claimable") process.stdout.write(`${JSON.stringify({ status: result.status })}\n`);
        },
      });
    }
    signal("exited", intentionalShutdown ? "intentional-shutdown" : "completed");
  } catch (error) {
    signal("exited", intentionalShutdown ? "intentional-shutdown" : "failed");
    throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await composition?.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`workout_worker_error=${errorCode(error)}\n`);
  process.exitCode = 1;
});
