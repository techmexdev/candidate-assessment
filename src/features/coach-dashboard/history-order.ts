import type { CoachDashboardMemberViewModel } from "./dashboard-contract";

export type WorkoutHistoryEntry = CoachDashboardMemberViewModel["history"][number];

/** Keep workout history display order date-based while preserving same-day source order. */
export function sortWorkoutHistoryChronologically(
  history: readonly WorkoutHistoryEntry[],
): WorkoutHistoryEntry[] {
  return history
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => Date.parse(left.entry.date) - Date.parse(right.entry.date) || left.index - right.index)
    .map(({ entry }) => entry);
}
