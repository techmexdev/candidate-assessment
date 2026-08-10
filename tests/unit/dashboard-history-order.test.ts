import { describe, expect, it } from "vitest";

import { sortWorkoutHistoryChronologically, type WorkoutHistoryEntry } from "../../src/features/coach-dashboard/history-order";

const workout = (date: string, title: string): WorkoutHistoryEntry => ({
  date,
  title,
  planned: true,
  completed: true,
  duration_min: 30,
  rpe: 6,
  exercises: [],
});

describe("workout history display order", () => {
  it("sorts runs from oldest to newest without mutating the source list", () => {
    const source = [
      workout("2026-06-03", "Latest"),
      workout("2026-05-27", "Earliest"),
      workout("2026-06-01", "Middle"),
    ];

    expect(sortWorkoutHistoryChronologically(source).map((item) => item.date)).toEqual([
      "2026-05-27",
      "2026-06-01",
      "2026-06-03",
    ]);
    expect(source.map((item) => item.date)).toEqual([
      "2026-06-03",
      "2026-05-27",
      "2026-06-01",
    ]);
  });

  it("preserves source order for runs on the same date", () => {
    const source = [
      workout("2026-06-03", "Second run"),
      workout("2026-06-03", "First run"),
    ];

    expect(sortWorkoutHistoryChronologically(source).map((item) => item.title)).toEqual([
      "Second run",
      "First run",
    ]);
  });
});
