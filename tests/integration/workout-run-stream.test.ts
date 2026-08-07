import { describe, expect, it, vi } from "vitest";
import { asWorkoutRunId } from "../../src/domain/contracts/workout";
import { InMemoryWorkoutRunRepository } from "../../src/graph/repositories/workout-runs";
import type { WorkerAuthorizationPort } from "../../src/application/ports/worker-authorization";
import { createSubmitWorkoutRun } from "../../src/application/use-cases/submit-workout-run";
import { createClaimWorkoutRun } from "../../src/application/use-cases/claim-workout-run";
import { createReplayWorkoutRunEvents } from "../../src/application/use-cases/retrieve-workout-run";
import { createAnswerWorkoutClarification } from "../../src/application/use-cases/answer-workout-clarification";
import { createRetryWorkoutRun } from "../../src/application/use-cases/retry-workout-run";
import { createWorkoutRunWorker } from "../../src/workers/workout-run-worker";

const NOW = "2026-08-07T10:00:00.000Z";

function createHarness(maxEventsPerRun = 100) {
  const repository = new InMemoryWorkoutRunRepository({ cursorSecret: "stream-test-secret", maxEventsPerRun });
  let id = 0;
  const authorization: WorkerAuthorizationPort = {
    createReference: vi.fn(async ({ runId }) => ({ status: "authorized" as const, authorizationReferenceId: `grant-ref:${runId}` })),
    authorize: vi.fn(async () => ({ status: "authorized" as const, authorizationId: "scope:process-local" })),
  };
  const submit = createSubmitWorkoutRun({
    repository,
    authorization,
    pinRevisions: vi.fn(async () => ({ status: "ready" as const, movementGraphRevisionId: "movement:sealed", memberContextRevisionId: "member:sealed" })),
    protectPrompt: vi.fn(async () => ({ status: "stored" as const, protectedPromptSnapshotId: "prompt:protected" })),
    createId: (kind) => `${kind}:${++id}`,
    now: () => NOW,
    modelConfigurationId: "model:test",
    policyRevision: "policy:v1",
  });
  return { repository, authorization, submit };
}

async function submitOne(testHarness: ReturnType<typeof createHarness>, overrides: Record<string, unknown> = {}) {
  return testHarness.submit({
    coachId: "coach:one", memberId: "member:one", sessionAuthorizationId: "session:one",
    prompt: "A knee-safe strength day", durationMinutes: 45, idempotencyKey: "submit:one", ...overrides,
  });
}

describe("workout run submission, worker, and replay integration", () => {
  it("pins revisions, stores only protected input references, and enforces scoped idempotency", async () => {
    const dependencies = createHarness();
    const created = await submitOne(dependencies);
    const replayed = await submitOne(dependencies);
    const conflict = await submitOne(dependencies, { prompt: "A different workout" });

    expect(created.status).toBe("created");
    expect(conflict.status).toBe("idempotency-conflict");
    if (!("runId" in created)) throw new Error("run missing");
    expect(replayed).toMatchObject({ status: "replayed", runId: created.runId });
    const stored = await dependencies.repository.getRun(created.runId, "coach:one", "member:one");
    expect(stored).toMatchObject({
      movementGraphRevisionId: "movement:sealed", memberContextRevisionId: "member:sealed",
      authorizationReferenceId: `grant-ref:${created.runId}`,
      inputRevisions: [{ protectedPromptSnapshotId: "prompt:protected" }],
    });
    expect(JSON.stringify(stored)).not.toContain("A knee-safe strength day");
  });

  it("claims through durable authorization, heartbeats, and passes one fenced claim to execution", async () => {
    const dependencies = createHarness();
    const created = await submitOne(dependencies);
    if (!("runId" in created)) throw new Error("run missing");
    const claim = createClaimWorkoutRun({ repository: dependencies.repository, authorization: dependencies.authorization });
    const executeClaimed = vi.fn(async () => ({ status: "completed" as const }));
    const worker = createWorkoutRunWorker({
      repository: dependencies.repository,
      claim,
      executeClaimed,
      workerId: "worker:one",
      now: () => NOW,
      leaseDurationMs: 60_000,
      heartbeatEveryMs: 5_000,
      startHeartbeat: (heartbeat) => { void heartbeat(); return () => undefined; },
    });

    await expect(worker.runOnce({ runId: created.runId, coachId: "coach:one", memberId: "member:one" })).resolves.toEqual({ status: "completed" });
    expect(dependencies.authorization.authorize).toHaveBeenCalledWith(expect.objectContaining({ stage: "claim", authorizationReferenceId: `grant-ref:${created.runId}` }));
    expect(executeClaimed).toHaveBeenCalledWith(expect.objectContaining({ claimed: expect.objectContaining({ fence: expect.objectContaining({ generation: 1 }) }) }));
    const events = await dependencies.repository.readEvents(created.runId, "coach:one", "member:one", { limit: 100 });
    expect(events.status === "ready" ? events.events.map((event) => event.kind) : []).toContain("heartbeat");
  });

  it("replays only missing events and returns resync_required for a pruned cursor", async () => {
    const dependencies = createHarness(2);
    const created = await submitOne(dependencies);
    if (!("runId" in created)) throw new Error("run missing");
    const claim = await dependencies.repository.claim(created.runId, "worker:one", NOW, "2026-08-07T10:01:00.000Z");
    if (claim.status !== "claimed") throw new Error("claim missing");
    const replay = createReplayWorkoutRunEvents({ repository: dependencies.repository, authorization: dependencies.authorization });
    const first = await replay({ runId: created.runId, coachId: "coach:one", memberId: "member:one", limit: 1 });
    if (first.status !== "ready") throw new Error("initial replay missing");

    await dependencies.repository.appendEvent(claim.fence, { kind: "stage", occurredAt: NOW, safeData: { stage: "constraints" } });
    await dependencies.repository.appendEvent(claim.fence, { kind: "stage", occurredAt: NOW, safeData: { stage: "catalog" } });
    const pruned = await replay({ runId: created.runId, coachId: "coach:one", memberId: "member:one", cursor: first.nextCursor, limit: 10 });
    expect(pruned).toEqual({ status: "resync_required", snapshotUrl: `/api/workout-runs/${created.runId}` });

    const current = await replay({ runId: created.runId, coachId: "coach:one", memberId: "member:one", limit: 10 });
    expect(current.status === "ready" ? current.events.map(({ event }) => event.kind) : []).toEqual(["stage", "stage"]);
    expect(JSON.stringify(current)).not.toMatch(/prompt|grant-ref|scope:process/i);
    await expect(replay({ runId: created.runId, coachId: "coach:one", memberId: "member:one", cursor: "forged.cursor", limit: 10 }))
      .resolves.toEqual({ status: "not-found" });

    vi.mocked(dependencies.authorization.authorize).mockResolvedValueOnce({ status: "denied" });
    await expect(replay({ runId: created.runId, coachId: "coach:one", memberId: "member:one", cursor: "still.forged", limit: 10 }))
      .resolves.toEqual({ status: "not-found" });
  });

  it("appends clarification immutably and creates a distinct linked retry", async () => {
    const dependencies = createHarness();
    const created = await submitOne(dependencies);
    if (!("runId" in created)) throw new Error("run missing");
    const claim = await dependencies.repository.claim(created.runId, "worker:one", NOW, "2026-08-07T10:01:00.000Z");
    if (claim.status !== "claimed") throw new Error("claim missing");
    await dependencies.repository.awaitClarification(claim.fence, NOW, ["joint:knee"]);
    const answer = createAnswerWorkoutClarification({
      repository: dependencies.repository, authorization: dependencies.authorization,
      protectPrompt: async () => ({ status: "stored" as const, protectedPromptSnapshotId: "prompt:clarification" }),
      createId: () => "input:clarification", now: () => NOW,
    });
    await expect(answer({ runId: created.runId, coachId: "coach:one", memberId: "member:one", sessionAuthorizationId: "session:one", answer: "Use the patellofemoral restriction" }))
      .resolves.toEqual({ status: "requeued", revision: 2 });
    const clarified = await dependencies.repository.getRun(created.runId, "coach:one", "member:one");
    expect(clarified?.inputRevisions).toHaveLength(2);
    expect(JSON.stringify(clarified)).not.toContain("Use the patellofemoral restriction");

    const secondClaim = await dependencies.repository.claim(created.runId, "worker:two", NOW, "2026-08-07T10:01:00.000Z");
    if (secondClaim.status !== "claimed") throw new Error("second claim missing");
    await dependencies.repository.fail(secondClaim.fence, { kind: "provider-failure", stage: "composition", safeMessage: "Workout generation could not be completed.", occurredAt: NOW });
    const retry = createRetryWorkoutRun({
      repository: dependencies.repository, authorization: dependencies.authorization,
      createId: (kind) => `${kind}:retry`, now: () => NOW, modelConfigurationId: "model:test", policyRevision: "policy:v1",
    });
    const retried = await retry({ runId: created.runId, coachId: "coach:one", memberId: "member:one", sessionAuthorizationId: "session:one", idempotencyKey: "retry:one" });
    expect(retried).toMatchObject({ status: "created", runId: asWorkoutRunId("workout-run:retry") });
    if (!("runId" in retried)) throw new Error("retry missing");
    await expect(dependencies.repository.getRun(retried.runId, "coach:one", "member:one")).resolves.toMatchObject({ retryOfRunId: created.runId, state: "queued" });
  });
});
