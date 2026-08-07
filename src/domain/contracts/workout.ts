import type { CatalogSafetyClassification } from "./catalog-safety";

declare const workoutIdBrand: unique symbol;

export type BrandedWorkoutId<Name extends string> = string & { readonly [workoutIdBrand]: Name };
export type WorkoutRunId = BrandedWorkoutId<"WorkoutRunId">;
export type WorkoutVersionId = BrandedWorkoutId<"WorkoutVersionId">;
export type WorkoutInputRevisionId = BrandedWorkoutId<"WorkoutInputRevisionId">;
export type WorkoutDecisionId = BrandedWorkoutId<"WorkoutDecisionId">;

function brandedId<Name extends string>(value: string, label: Name): BrandedWorkoutId<Name> {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
  return value as BrandedWorkoutId<Name>;
}

export const asWorkoutRunId = (value: string) => brandedId(value, "WorkoutRunId");
export const asWorkoutVersionId = (value: string) => brandedId(value, "WorkoutVersionId");
export const asWorkoutInputRevisionId = (value: string) => brandedId(value, "WorkoutInputRevisionId");
export const asWorkoutDecisionId = (value: string) => brandedId(value, "WorkoutDecisionId");

export const WORKOUT_SECTION_ORDER = ["warm-up", "main", "cool-down"] as const;
export type WorkoutSectionKind = (typeof WORKOUT_SECTION_ORDER)[number];

export type TimedWorkoutDose = {
  readonly kind: "timed";
  readonly sets: number;
  readonly workSecondsPerSet: number;
};

export type RepetitionWorkoutDose = {
  readonly kind: "repetitions";
  readonly sets: number;
  readonly repetitionsPerSet: number;
  /** Server-owned candidate metadata supplies this value; it is not model arithmetic. */
  readonly secondsPerRepetition: number;
};

export type WorkoutDose = TimedWorkoutDose | RepetitionWorkoutDose;

export type WorkoutItemTiming = {
  readonly plannedWorkSeconds: number;
  readonly plannedRestSeconds: number;
  readonly transitionSeconds: number;
  readonly totalSeconds: number;
};

export type WorkoutDecisionWarning = {
  readonly kind: Extract<CatalogSafetyClassification, "caution" | "downranked">;
  readonly assertionIds: readonly string[];
  readonly evidenceIds: readonly string[];
};

export type WorkoutItem = {
  readonly exerciseConceptId: string;
  readonly dose: Readonly<WorkoutDose>;
  readonly restSeconds: number;
  readonly rationale: string;
  readonly timing: Readonly<WorkoutItemTiming>;
  readonly warnings: readonly WorkoutDecisionWarning[];
};

export type WorkoutSectionTiming = {
  readonly plannedWorkSeconds: number;
  readonly plannedRestSeconds: number;
  readonly transitionSeconds: number;
  readonly totalSeconds: number;
};

export type WorkoutSection = {
  readonly kind: WorkoutSectionKind;
  readonly items: readonly WorkoutItem[];
  readonly timing: Readonly<WorkoutSectionTiming>;
};

export type WorkoutTiming = WorkoutSectionTiming & {
  readonly requestedDurationSeconds: number;
  readonly differenceSeconds: number;
};

export type ReviewableWorkout = {
  readonly schemaVersion: "reviewable-workout/v1";
  readonly runId: WorkoutRunId;
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly durationPolicyVersion: string;
  readonly sections: readonly WorkoutSection[];
  readonly timing: Readonly<WorkoutTiming>;
};

export type ImmutableWorkoutVersion = {
  readonly workoutVersionId: WorkoutVersionId;
  readonly version: number;
  readonly createdAt: string;
  readonly workout: Readonly<ReviewableWorkout>;
};
