import { describe, expect, it, vi } from "vitest";

import type { WorkoutRunResource } from "../../src/application/use-cases/retrieve-workout-run";
import {
  createDashboardWorkoutRuntime,
  createFetchDashboardWorkoutRuntimeClient,
  projectWorkoutRunResource,
  type DashboardWorkoutRuntimeClient,
} from "../../src/features/coach-dashboard/runtime-adapter";
import { createFetchDashboardFullGraphClient } from "../../src/features/coach-dashboard/production-adapter";

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
      { decisionId: "decision:box", kind: "cautioned", selectionDisposition: "selected", safetyClassification: "caution", exerciseConceptId: "exercise:box-squat", movementGraphRevisionId: "movement:7", memberContextRevisionId: "member:4", sourceAssertionIds: ["assertion:caution"], contributingPathIds: ["path:knee"], evidenceIds: ["evidence:knee"], explanation: "Retained with a reviewed range caution." },
      { decisionId: "decision:split", kind: "excluded", selectionDisposition: "not-selected", safetyClassification: "excluded", exerciseConceptId: "exercise:split-squat", movementGraphRevisionId: "movement:7", memberContextRevisionId: "member:4", sourceAssertionIds: ["assertion:exclude"], contributingPathIds: ["path:joint"], evidenceIds: ["evidence:knee"], explanation: "Excluded because the path reaches the injured knee." },
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
    expect(projected.decisions[0]).toMatchObject({ selectionDisposition: "selected", safetyClassification: "caution" });
    expect(projected.decisions[1]).toMatchObject({ selectionDisposition: "not-selected", safetyClassification: "excluded" });
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

  it("loads the authoritative snapshot after cursor pruning and resumes without the stale cursor", async () => {
    const running = { ...completedResource(), state: "running" as const, workout: undefined, provenance: undefined };
    const read = vi.fn()
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(completedResource());
    const replay = vi.fn()
      .mockResolvedValueOnce({
        status: "ready" as const,
        cursor: "cursor:pruned",
        events: [{ eventId: "event:queued", sequence: 1, kind: "queued", occurredAt: "2026-08-07T12:00:00.000Z", data: {} }],
      })
      .mockResolvedValueOnce({ status: "resync_required" as const, snapshotUrl: "/api/workout-runs/run%3A1?memberId=member%3A1" })
      .mockResolvedValueOnce({
        status: "ready" as const,
        cursor: "cursor:fresh",
        events: [{ eventId: "event:completed", sequence: 9, kind: "completed", occurredAt: "2026-08-07T12:00:09.000Z", data: {} }],
      });
    const client: DashboardWorkoutRuntimeClient = {
      submit: vi.fn(async () => ({
        runId: "run:1",
        replayed: false,
        resourceUrl: "/api/workout-runs/run%3A1?memberId=member%3A1",
      })),
      replay,
      read,
    };
    const runtime = createDashboardWorkoutRuntime(client, { wait: async () => undefined });

    const result = await runtime.generate(
      { memberId: "member:1", prompt: "Knee-aware workout", durationMinutes: 45, idempotencyKey: "key:resync" },
      () => undefined,
    );

    expect(result.status).toBe("completed");
    expect(replay).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: "cursor:pruned" }));
    expect(replay).toHaveBeenNthCalledWith(3, expect.not.objectContaining({ cursor: expect.anything() }));
    expect(read).toHaveBeenNthCalledWith(1, expect.objectContaining({ resourceUrl: "/api/workout-runs/run%3A1?memberId=member%3A1" }));
  });

  it("parses pruned-cursor responses and follows their member-scoped snapshot links", async () => {
    const snapshotUrl = "/api/workout-runs/run%3A1?memberId=member%3A1";
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: "resync_required", snapshotUrl }, { status: 409 }))
      .mockResolvedValueOnce(Response.json(completedResource()));
    const client = createFetchDashboardWorkoutRuntimeClient(fetcher as typeof fetch);

    const replay = await client.replay({ runId: "run:1", memberId: "member:1", cursor: "cursor:pruned" });
    expect(replay).toEqual({ status: "resync_required", snapshotUrl });
    if (replay.status !== "resync_required") throw new Error("expected resync response");

    await expect(client.read({ runId: "run:1", memberId: "member:1", resourceUrl: replay.snapshotUrl }))
      .resolves.toMatchObject({ state: "completed" });
    expect(fetcher).toHaveBeenNthCalledWith(2, snapshotUrl, expect.anything());
  });
});

describe("dashboard full graph adapter", () => {
  it("loads a complete, revision-pinned movement projection without fetching on construction", async () => {
    const fetcher = vi.fn(async () => Response.json({
      status: "ready",
      data: {
        domain: "movement-clinical",
        revisionId: "movement:one",
        authority: "canonical",
        counts: { nodes: 2, relationships: 1 },
        nodes: [
          {
            id: "exercise:squat",
            kind: "exercise",
            label: "Squat",
            category: "domain",
            revisionId: "movement:one",
            detail: [{ key: "catalogId", value: "exercise:squat" }],
            provenance: { directAssertion: "present", assertionId: "assertion:exercise", source: { sourceId: "movement-catalog", sourceRevision: "v1" }, lineageIds: [] },
          },
          {
            id: "joint:knee",
            kind: "joint",
            label: "Knee",
            category: "domain",
            revisionId: "movement:one",
            detail: [],
            provenance: { directAssertion: "present", assertionId: "assertion:knee", source: { sourceId: "movement-catalog", sourceRevision: "v1" }, lineageIds: [] },
          },
        ],
        relationships: [{
          id: "assertion:targets",
          kind: "targets",
          fromId: "exercise:squat",
          toId: "joint:knee",
          revisionId: "movement:one",
          detail: [],
          provenance: { directAssertion: "present", assertionId: "assertion:targets", source: { sourceId: "movement-catalog", sourceRevision: "v1" }, lineageIds: [] },
        }],
      },
    }));

    const client = createFetchDashboardFullGraphClient(fetcher as typeof fetch);
    const result = await client.read({ domain: "movement-clinical", revisionId: "movement:one" });

    expect(result).toMatchObject({ status: "ready", data: { counts: { nodes: 2, relationships: 1 }, revisionId: "movement:one" } });
    expect(fetcher).toHaveBeenCalledWith("/api/movement-graph?revisionId=movement%3Aone", expect.anything());
  });

  it("fails closed when a projection is truncated or has a dangling edge", async () => {
    const fetcher = vi.fn(async () => Response.json({
      status: "ready",
      data: {
        domain: "member-context",
        revisionId: "context:one",
        memberId: "member:one",
        authority: "canonical",
        counts: { nodes: 1, relationships: 1 },
        nodes: [{
          id: "member:one",
          kind: "member",
          label: "Jordan Rivera",
          category: "identity",
          revisionId: "context:one",
          detail: [],
          provenance: { directAssertion: "none", lineageIds: [] },
        }],
        relationships: [{
          id: "assertion:missing",
          kind: "HAS_PROFILE",
          fromId: "member:one",
          toId: "profile:missing",
          revisionId: "context:one",
          detail: [],
          provenance: { directAssertion: "present", assertionId: "assertion:missing", source: { locator: "profile", artifactDigest: "sha256:fixture" }, lineageIds: [] },
        }],
      },
    }));
    const client = createFetchDashboardFullGraphClient(fetcher as typeof fetch);

    await expect(client.read({ domain: "member-context", memberId: "member:one" })).resolves.toEqual({
      status: "unavailable",
      domain: "member-context",
      message: "Member context is unavailable.",
    });
  });
});
