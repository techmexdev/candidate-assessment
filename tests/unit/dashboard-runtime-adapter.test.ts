import { describe, expect, it, vi } from "vitest";

import type { WorkoutRunResource } from "../../src/application/use-cases/retrieve-workout-run";
import {
  createDashboardWorkoutRuntime,
  projectWorkoutRunResource,
  type DashboardWorkoutRuntimeClient,
} from "../../src/features/coach-dashboard/runtime-adapter";

const completedResource = (): WorkoutRunResource => ({
  runId: "run:1" as WorkoutRunResource["runId"],
  state: "completed",
  requestedDurationMinutes: 45,
  movementGraphRevisionId: "movement:7",
  memberContextRevisionId: "member:4",
  workout: {
    workoutVersionId: "workout:1" as NonNullable<WorkoutRunResource["workout"]>["workoutVersionId"],
    version: 1,
    createdAt: "2026-08-07T12:00:00.000Z",
    workout: {
      schemaVersion: "reviewable-workout/v1",
      runId: "run:1" as WorkoutRunResource["runId"],
      movementGraphRevisionId: "movement:7",
      memberContextRevisionId: "member:4",
      durationPolicyVersion: "duration:v1",
      sections: [
        {
          kind: "warm-up",
          items: [{ exerciseConceptId: "exercise:bike", dose: { kind: "timed", sets: 1, workSecondsPerSet: 300 }, restSeconds: 30, rationale: "Raises temperature without loading the knee.", timing: { plannedWorkSeconds: 300, plannedRestSeconds: 30, transitionSeconds: 15, totalSeconds: 345 }, warnings: [] }],
          timing: { plannedWorkSeconds: 300, plannedRestSeconds: 30, transitionSeconds: 15, totalSeconds: 345 },
        },
        {
          kind: "main",
          items: [{ exerciseConceptId: "exercise:box-squat", dose: { kind: "repetitions", sets: 3, repetitionsPerSet: 8, secondsPerRepetition: 4 }, restSeconds: 75, rationale: "Uses the reviewed knee-aware range.", timing: { plannedWorkSeconds: 96, plannedRestSeconds: 150, transitionSeconds: 15, totalSeconds: 261 }, warnings: [{ kind: "caution", assertionIds: ["assertion:caution"], evidenceIds: ["evidence:knee"] }] }],
          timing: { plannedWorkSeconds: 96, plannedRestSeconds: 150, transitionSeconds: 15, totalSeconds: 261 },
        },
        {
          kind: "cool-down",
          items: [{ exerciseConceptId: "exercise:breathing", dose: { kind: "timed", sets: 1, workSecondsPerSet: 180 }, restSeconds: 0, rationale: "Closes the session at low intensity.", timing: { plannedWorkSeconds: 180, plannedRestSeconds: 0, transitionSeconds: 0, totalSeconds: 180 }, warnings: [] }],
          timing: { plannedWorkSeconds: 180, plannedRestSeconds: 0, transitionSeconds: 0, totalSeconds: 180 },
        },
      ],
      timing: { requestedDurationSeconds: 2700, plannedWorkSeconds: 576, plannedRestSeconds: 180, transitionSeconds: 30, totalSeconds: 786, differenceSeconds: -1914 },
    },
  },
  provenance: {
    traceSchemaVersion: "workout-provenance/v1",
    digest: "trace:digest",
    movementGraphRevisionId: "movement:7",
    memberContextRevisionId: "member:4",
    activity: { activityId: "run:1" as WorkoutRunResource["runId"], kind: "workout-generation" },
    entities: [
      { entityId: "prompt:1", kind: "prompt" },
      { entityId: "movement:7", kind: "movement-graph-revision" },
      { entityId: "member:4", kind: "member-context-revision" },
      { entityId: "policy:1", kind: "policy" },
      { entityId: "candidates:1", kind: "candidate-set" },
      { entityId: "proposal:1", kind: "model-proposal" },
      { entityId: "workout:1", kind: "workout-version" },
    ],
    decisions: [
      { decisionId: "decision:box", kind: "cautioned", exerciseConceptId: "exercise:box-squat", movementGraphRevisionId: "movement:7", memberContextRevisionId: "member:4", sourceAssertionIds: ["assertion:caution"], contributingPathIds: ["path:knee"], evidenceIds: ["evidence:knee"], explanation: "Retained with a reviewed range caution." },
      { decisionId: "decision:split", kind: "excluded", exerciseConceptId: "exercise:split-squat", movementGraphRevisionId: "movement:7", memberContextRevisionId: "member:4", sourceAssertionIds: ["assertion:exclude"], contributingPathIds: ["path:joint"], evidenceIds: ["evidence:knee"], explanation: "Excluded because the path reaches the injured knee." },
      { decisionId: "decision:sub", kind: "substituted", exerciseConceptId: "exercise:box-squat", substitutedFromExerciseConceptId: "exercise:back-squat", movementGraphRevisionId: "movement:7", memberContextRevisionId: "member:4", sourceAssertionIds: ["assertion:sub"], contributingPathIds: ["path:sub"], evidenceIds: ["evidence:review"], explanation: "Reviewed substitution for back squat." },
    ],
    relations: [],
  },
});

describe("dashboard workout runtime adapter", () => {
  it("projects all canonical sections, dose, rest, exclusions, and stored decision paths", () => {
    const projected = projectWorkoutRunResource(completedResource());

    expect(projected.workoutSections.map((section) => section.title)).toEqual(["Warm-up", "Main", "Cool-down"]);
    expect(projected.workoutSections[1]?.items[0]).toMatchObject({
      catalogId: "exercise:box-squat",
      dose: "3×8",
      rest: "75 sec rest",
      why: "Uses the reviewed knee-aware range.",
      decisionId: "decision:box",
    });
    expect(projected.exclusions).toEqual([
      expect.objectContaining({ catalogId: "exercise:split-squat", reason: "Excluded because the path reaches the injured knee.", overridable: false }),
    ]);
    expect(projected.decisionPaths["decision:split"]?.lanes).toEqual([
      expect.objectContaining({ name: "Decision", text: "Excluded because the path reaches the injured knee." }),
      expect.objectContaining({ name: "Graph path", source: "path:joint" }),
      expect.objectContaining({ name: "Evidence", source: "assertion:exclude · evidence:knee" }),
      expect.objectContaining({ name: "Pinned revisions", source: "movement:7 · member:4" }),
    ]);
    expect(projected.decisions.map((decision) => decision.kind)).toEqual(["cautioned", "excluded", "substituted"]);
  });

  it("deduplicates replayed events and fetches the authoritative resource after completion", async () => {
    const read = vi.fn(async () => completedResource());
    const client: DashboardWorkoutRuntimeClient = {
      submit: vi.fn(async () => ({ runId: "run:1", replayed: false })),
      replay: vi.fn()
        .mockResolvedValueOnce({
          cursor: "cursor:2",
          events: [
            { eventId: "event:1", sequence: 1, kind: "queued", occurredAt: "2026-08-07T12:00:00.000Z", data: {} },
            { eventId: "event:2", sequence: 2, kind: "stage", occurredAt: "2026-08-07T12:00:01.000Z", data: { stage: "compose" } },
          ],
        })
        .mockResolvedValueOnce({
          cursor: "cursor:3",
          events: [
            { eventId: "event:2", sequence: 2, kind: "stage", occurredAt: "2026-08-07T12:00:01.000Z", data: { stage: "compose" } },
            { eventId: "event:3", sequence: 3, kind: "completed", occurredAt: "2026-08-07T12:00:02.000Z", data: { workoutVersionId: "workout:1" } },
          ],
        }),
      read,
    };
    const updates: string[] = [];
    const runtime = createDashboardWorkoutRuntime(client, { wait: async () => undefined });

    const result = await runtime.generate(
      { memberId: "member:1", prompt: "Knee-aware workout", durationMinutes: 45, idempotencyKey: "key:1" },
      (update) => updates.push(update.status),
    );

    expect(result.status).toBe("completed");
    expect(updates).toEqual(["submitting", "queued", "running", "completed"]);
    expect(read).toHaveBeenCalledOnce();
  });

  it("surfaces reconnect and terminal failure states without inventing partial workout content", async () => {
    const client: DashboardWorkoutRuntimeClient = {
      submit: vi.fn(async () => ({ runId: "run:2", replayed: true })),
      replay: vi.fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce({ cursor: "cursor:1", events: [{ eventId: "event:1", sequence: 1, kind: "failed", occurredAt: "2026-08-07T12:00:00.000Z", data: { kind: "no-safe-candidates", stage: "catalog-safety" } }] }),
      read: vi.fn(),
    };
    const updates: string[] = [];
    const runtime = createDashboardWorkoutRuntime(client, { wait: async () => undefined });

    const result = await runtime.generate(
      { memberId: "member:1", prompt: "Unsafe request", durationMinutes: 45, idempotencyKey: "key:2" },
      (update) => updates.push(update.status),
    );

    expect(result).toMatchObject({ status: "no-safe-result", runId: "run:2" });
    expect(updates).toEqual(["submitting", "disconnected", "no-safe-result"]);
    expect(client.read).not.toHaveBeenCalled();
  });
});
