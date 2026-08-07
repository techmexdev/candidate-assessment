import { createHash } from "node:crypto";
import type { WorkoutRunState } from "../../domain/contracts/workout-run";
import type { ImmutableWorkoutVersion } from "../../domain/contracts/workout";
import type { WorkoutDecision, WorkoutProvenanceBundle } from "../../domain/contracts/workout-provenance";
import { canonicalJson } from "../revisions/movement-graph";

export const WORKOUT_RUN_SCHEMA_VERSION = "workout-run-schema/v1" as const;
export const WORKOUT_RUN_EVENT_SCHEMA_VERSION = "workout-run-event/v1" as const;
export const WORKOUT_RUN_CURSOR_SCHEMA_VERSION = "workout-run-cursor/v1" as const;

export const WORKOUT_RUN_LIMITS = Object.freeze({
  maximumEventPageSize: 100,
  defaultEventsRetainedPerRun: 1_000,
  maximumClarificationCandidates: 25,
});

export const WORKOUT_RUN_TERMINAL_STATES = new Set<WorkoutRunState>(["failed", "canceled", "completed"]);

export const WORKOUT_RUN_TRANSITIONS: Readonly<Record<WorkoutRunState, readonly WorkoutRunState[]>> = Object.freeze({
  queued: ["running", "canceled"],
  running: ["awaiting-clarification", "failed", "canceled", "completed"],
  "awaiting-clarification": ["queued", "canceled"],
  failed: [],
  canceled: [],
  completed: [],
});

export function isWorkoutRunTransitionAllowed(from: WorkoutRunState, to: WorkoutRunState): boolean {
  return WORKOUT_RUN_TRANSITIONS[from].includes(to);
}

const sha256 = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

export const canonicalWorkoutDecisionSetDigest = (decisions: readonly WorkoutDecision[]) => sha256(decisions);
export const canonicalWorkoutPayloadDigest = (workout: ImmutableWorkoutVersion) => sha256(workout);
export const canonicalWorkoutProvenanceDigest = (provenance: WorkoutProvenanceBundle) => {
  const canonical = Object.fromEntries(Object.entries(provenance).filter(([key]) => key !== "digest"));
  return sha256(canonical);
};
