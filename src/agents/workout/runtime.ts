import { createExecuteWorkoutRun, type ExecuteWorkoutRunDependencies } from "../../application/use-cases/execute-workout-run";

/** Public server-only runtime surface. It intentionally exposes no model-callable tools. */
export function createWorkoutRuntime(dependencies: ExecuteWorkoutRunDependencies) {
  return Object.freeze({ execute: createExecuteWorkoutRun(dependencies) });
}
