import { asWorkoutRunId } from "../src/domain/contracts/workout";
import { createConfiguredWorkoutWorkerComposition } from "../src/server/workout-worker-composition";

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined;
  if (!value || value.startsWith("--")) throw new Error(`--${name} is required`);
  return value;
}

const controller = new AbortController();
const stop = () => controller.abort(new Error("Workout worker interrupted"));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

const invocation = {
  runId: asWorkoutRunId(argument("run-id")),
  coachId: argument("coach-id"),
  memberId: argument("member-id"),
};
const composition = createConfiguredWorkoutWorkerComposition();
try {
  const result = await composition.runExplicit({
    ...invocation,
    signal: controller.signal,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "completed" && result.status !== "awaiting-clarification") process.exitCode = 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await composition.close();
}
