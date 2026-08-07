import { describe, expect, it, vi } from "vitest";
import { asWorkoutRunId } from "../../src/domain/contracts/workout";
import { InMemoryWorkoutRunRepository } from "../../src/graph/repositories/workout-runs";
import type { WorkerAuthorizationPort } from "../../src/application/ports/worker-authorization";
import { createSubmitWorkoutRun } from "../../src/application/use-cases/submit-workout-run";
import { createClaimWorkoutRun } from "../../src/application/use-cases/claim-workout-run";
import { createReplayWorkoutRunEvents, createRetrieveWorkoutRun } from "../../src/application/use-cases/retrieve-workout-run";
import { createCancelWorkoutRun } from "../../src/application/use-cases/cancel-workout-run";
import { createAnswerWorkoutClarification } from "../../src/application/use-cases/answer-workout-clarification";
import { createRetryWorkoutRun } from "../../src/application/use-cases/retry-workout-run";
import { createWorkoutRunWorker } from "../../src/workers/workout-run-worker";

const NOW = "2026-08-07T10:00:00.000Z";

function createHarness(maxEventsPerRun = 100) {
  const repository = new InMemoryWorkoutRunRepository({ cursorSecret: "stream-test-secret", maxEventsPerRun, now: () => NOW });
  let id = 0;
  const authorization: WorkerAuthorizationPort = {
    createReference: vi.fn(async ({ runId }) => ({ status: "authorized" as const, authorizationReferenceId: `grant-ref:${runId}` })),
    authorizeSession: vi.fn(async ({ sessionAuthorizationId, coachId, memberId }) => coachId === "coach:one"
      && ((sessionAuthorizationId === "session:one" && memberId === "member:one")
        || (sessionAuthorizationId === "session:both" && (memberId === "member:one" || memberId === "member:wrong")))
      ? { status: "authorized" as const, authorizationId: "scope:current-session" }
      : { status: "denied" as const }),
    authorize: vi.fn(async () => ({ status: "authorized" as const, authorizationId: "scope:process-local" })),
  };
  const pinRevisions = vi.fn(async () => ({ status: "ready" as const, movementGraphRevisionId: "movement:sealed", memberContextRevisionId: "member:sealed" }));
  const protectPrompt = vi.fn(async (): Promise<
    | { readonly status: "stored"; readonly protectedPromptSnapshotId: string }
    | { readonly status: "failed" }
  > => ({ status: "stored", protectedPromptSnapshotId: "prompt:protected" }));
  const submit = createSubmitWorkoutRun({
    repository,
    authorization,
    pinRevisions,
    protectPrompt,
    createId: (kind) => `${kind}:${++id}`,
    now: () => NOW,
    modelConfigurationId: "model:test",
    policyRevision: "policy:v1",
  });
  return { repository, authorization, pinRevisions, protectPrompt, submit };
}

async function submitOne(testHarness: ReturnType<typeof createHarness>, overrides: Record<string, unknown> = {}) {
  return testHarness.submit({
    coachId: "coach:one", memberId: "member:one", sessionAuthorizationId: "session:one",
    prompt: "A knee-safe strength day", durationMinutes: 45, idempotencyKey: "submit:one", ...overrides,
  });
}

describe("workout run submission, worker, and replay integration", () => {
  it("requires current member scope as well as the durable run grant for every interactive operation", async () => {
    const dependencies = createHarness();
    const first = await submitOne(dependencies);
    const second = await submitOne(dependencies, { idempotencyKey: "submit:two" });
    const third = await submitOne(dependencies, { idempotencyKey: "submit:three" });
    if (!("runId" in first) || !("runId" in second) || !("runId" in third)) throw new Error("runs missing");

    const retrieve = createRetrieveWorkoutRun({ repository: dependencies.repository, authorization: dependencies.authorization });
    const replay = createReplayWorkoutRunEvents({ repository: dependencies.repository, authorization: dependencies.authorization });
    const cancel = createCancelWorkoutRun({ repository: dependencies.repository, authorization: dependencies.authorization, now: () => NOW });
    const answer = createAnswerWorkoutClarification({
      repository: dependencies.repository,
      authorization: dependencies.authorization,
      protectPrompt: async () => ({ status: "stored" as const, protectedPromptSnapshotId: "prompt:clarification" }),
      createId: () => "input:clarification-current-scope",
      now: () => NOW,
    });
    const retry = createRetryWorkoutRun({
      repository: dependencies.repository,
      authorization: dependencies.authorization,
      createId: (kind) => `${kind}:current-scope-retry`,
      now: () => NOW,
      modelConfigurationId: "model:test",
      policyRevision: "policy:v1",
    });

    const clarificationClaim = await dependencies.repository.claim(second.runId, "worker:clarification", NOW, "2026-08-07T10:01:00.000Z");
    if (clarificationClaim.status !== "claimed") throw new Error("clarification claim missing");
    await dependencies.repository.awaitClarification(clarificationClaim.fence, NOW, ["joint:knee"]);
    const retryClaim = await dependencies.repository.claim(third.runId, "worker:retry", NOW, "2026-08-07T10:01:00.000Z");
    if (retryClaim.status !== "claimed") throw new Error("retry claim missing");
    await dependencies.repository.fail(retryClaim.fence, {
      kind: "provider-failure", stage: "composition", safeMessage: "Workout generation could not be completed.", occurredAt: NOW,
    });

    const revoked = { coachId: "coach:one", memberId: "member:one", sessionAuthorizationId: "session:revoked" } as const;
    const wrongMember = { coachId: "coach:one", memberId: "member:wrong", sessionAuthorizationId: "session:both" } as const;
    const current = { coachId: "coach:one", memberId: "member:one", sessionAuthorizationId: "session:one" } as const;

    for (const access of [revoked, wrongMember]) {
      await expect(retrieve({ runId: first.runId, ...access })).resolves.toEqual({ status: "not-found" });
      await expect(replay({ runId: first.runId, ...access })).resolves.toEqual({ status: "not-found" });
      await expect(cancel({ runId: first.runId, ...access })).resolves.toEqual({ status: "not-found" });
      await expect(answer({ runId: second.runId, ...access, answer: "Use the patellofemoral restriction" })).resolves.toEqual({ status: "not-found" });
      await expect(retry({ runId: third.runId, ...access, idempotencyKey: `retry:${access.memberId}` })).resolves.toEqual({ status: "not-found" });
    }

    await expect(retrieve({ runId: first.runId, ...current })).resolves.toMatchObject({ status: "ready" });
    await expect(replay({ runId: first.runId, ...current })).resolves.toMatchObject({ status: "ready" });
    await expect(answer({ runId: second.runId, ...current, answer: "Use the patellofemoral restriction" }))
      .resolves.toEqual({ status: "requeued", revision: 2 });
    await expect(retry({ runId: third.runId, ...current, idempotencyKey: "retry:current" }))
      .resolves.toMatchObject({ status: "created" });
    await expect(cancel({ runId: first.runId, ...current })).resolves.toEqual({ status: "canceled" });

    expect(dependencies.authorization.authorizeSession).toHaveBeenCalledWith(expect.objectContaining({ stage: "read", sessionAuthorizationId: "session:one" }));
    expect(dependencies.authorization.authorizeSession).toHaveBeenCalledWith(expect.objectContaining({ stage: "replay", sessionAuthorizationId: "session:one" }));
    expect(dependencies.authorization.authorizeSession).toHaveBeenCalledWith(expect.objectContaining({ stage: "cancel", sessionAuthorizationId: "session:one" }));
    expect(dependencies.authorization.authorizeSession).toHaveBeenCalledWith(expect.objectContaining({ stage: "clarification", sessionAuthorizationId: "session:one" }));
    expect(dependencies.authorization.authorizeSession).toHaveBeenCalledWith(expect.objectContaining({ stage: "retry", sessionAuthorizationId: "session:one" }));
  });

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
    expect(dependencies.authorization.createReference).toHaveBeenCalledTimes(1);
    expect(dependencies.protectPrompt).toHaveBeenCalledTimes(1);
  });

  it("reserves scoped submission identity before provisioning side effects under concurrency", async () => {
    const dependencies = createHarness();
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
    dependencies.protectPrompt.mockImplementationOnce(async () => {
      await promptGate;
      return { status: "stored" as const, protectedPromptSnapshotId: "prompt:protected" };
    });

    const first = submitOne(dependencies);
    await vi.waitFor(() => expect(dependencies.protectPrompt).toHaveBeenCalledTimes(1));
    const duplicate = submitOne(dependencies);
    const conflict = submitOne(dependencies, { prompt: "A different workout" });
    await Promise.resolve();

    expect(dependencies.authorization.createReference).toHaveBeenCalledTimes(1);
    expect(dependencies.protectPrompt).toHaveBeenCalledTimes(1);
    releasePrompt();
    const results = await Promise.all([first, duplicate, conflict]);

    expect(results.map(({ status }) => status).sort()).toEqual(["created", "idempotency-conflict", "replayed"]);
    expect(dependencies.authorization.createReference).toHaveBeenCalledTimes(1);
    expect(dependencies.protectPrompt).toHaveBeenCalledTimes(1);
  });

  it("recovers abandoned submission provisioning on the reserved run identity without exposing a partial run", async () => {
    const dependencies = createHarness();
    dependencies.protectPrompt.mockResolvedValueOnce({ status: "failed" as const });

    await expect(submitOne(dependencies)).resolves.toEqual({ status: "canonical-state-unavailable" });
    await expect(dependencies.repository.getRun(asWorkoutRunId("workout-run:1"), "coach:one", "member:one")).resolves.toBeUndefined();

    const recovered = await submitOne(dependencies);
    expect(recovered).toEqual({ status: "created", runId: asWorkoutRunId("workout-run:1") });
    expect(dependencies.authorization.createReference).toHaveBeenCalledTimes(2);
    expect(dependencies.authorization.createReference).toHaveBeenNthCalledWith(1, expect.objectContaining({
      runId: "workout-run:1", provisioningKey: "workout-run-creation:workout-run:1", provisionedAt: NOW,
    }));
    expect(dependencies.authorization.createReference).toHaveBeenNthCalledWith(2, expect.objectContaining({
      runId: "workout-run:1", provisioningKey: "workout-run-creation:workout-run:1", provisionedAt: NOW,
    }));
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
    expect(events.status === "ready" ? events.events.map(({ event }) => event.kind) : []).toContain("heartbeat");
  });

  it("replays only missing events and returns resync_required for a pruned cursor", async () => {
    const dependencies = createHarness(2);
    const created = await submitOne(dependencies);
    if (!("runId" in created)) throw new Error("run missing");
    const claim = await dependencies.repository.claim(created.runId, "worker:one", NOW, "2026-08-07T10:01:00.000Z");
    if (claim.status !== "claimed") throw new Error("claim missing");
    const replay = createReplayWorkoutRunEvents({ repository: dependencies.repository, authorization: dependencies.authorization });
    const first = await replay({ runId: created.runId, coachId: "coach:one", memberId: "member:one", sessionAuthorizationId: "session:one", limit: 1 });
    if (first.status !== "ready") throw new Error("initial replay missing");

    await dependencies.repository.appendEvent(claim.fence, { kind: "stage", occurredAt: NOW, safeData: { stage: "constraints" } });
    await dependencies.repository.appendEvent(claim.fence, { kind: "stage", occurredAt: NOW, safeData: { stage: "catalog" } });
    const pruned = await replay({ runId: created.runId, coachId: "coach:one", memberId: "member:one", sessionAuthorizationId: "session:one", cursor: first.nextCursor, limit: 10 });
    expect(pruned).toEqual({ status: "resync_required", snapshotUrl: `/api/workout-runs/${created.runId}` });

    const current = await replay({ runId: created.runId, coachId: "coach:one", memberId: "member:one", sessionAuthorizationId: "session:one", limit: 10 });
    expect(current.status === "ready" ? current.events.map(({ event }) => event.kind) : []).toEqual(["stage", "stage"]);
    expect(JSON.stringify(current)).not.toMatch(/prompt|grant-ref|scope:process/i);
    await expect(replay({ runId: created.runId, coachId: "coach:one", memberId: "member:one", sessionAuthorizationId: "session:one", cursor: "forged.cursor", limit: 10 }))
      .resolves.toEqual({ status: "not-found" });

    vi.mocked(dependencies.authorization.authorize).mockResolvedValueOnce({ status: "denied" });
    await expect(replay({ runId: created.runId, coachId: "coach:one", memberId: "member:one", sessionAuthorizationId: "session:one", cursor: "still.forged", limit: 10 }))
      .resolves.toEqual({ status: "not-found" });
  });

  it("reads a maximum-size replay page with one repository call", async () => {
    const dependencies = createHarness(200);
    const created = await submitOne(dependencies);
    if (!("runId" in created)) throw new Error("run missing");
    const claim = await dependencies.repository.claim(created.runId, "worker:one", NOW, "2026-08-07T10:01:00.000Z");
    if (claim.status !== "claimed") throw new Error("claim missing");
    for (let index = 0; index < 98; index += 1) {
      await dependencies.repository.appendEvent(claim.fence, {
        kind: "stage",
        occurredAt: NOW,
        safeData: { stage: `stage-${index}` },
      });
    }
    const readEvents = vi.spyOn(dependencies.repository, "readEvents");
    const replay = createReplayWorkoutRunEvents({ repository: dependencies.repository, authorization: dependencies.authorization });

    const result = await replay({
      runId: created.runId,
      coachId: "coach:one",
      memberId: "member:one",
      sessionAuthorizationId: "session:one",
      limit: 100,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("replay page missing");
    expect(result.events).toHaveLength(100);
    expect(result.events.map(({ event }) => event.sequence)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    expect(new Set(result.events.map(({ cursor }) => cursor)).size).toBe(100);
    expect(result.nextCursor).toBe(result.events[99]?.cursor);
    expect(result.highWaterSequence).toBe(100);
    expect(readEvents).toHaveBeenCalledTimes(1);
    expect(readEvents).toHaveBeenCalledWith(created.runId, "coach:one", "member:one", { limit: 100 });

    const resumeCursor = result.events[49]?.cursor;
    if (!resumeCursor) throw new Error("mid-page cursor missing");
    const resumed = await replay({
      runId: created.runId,
      coachId: "coach:one",
      memberId: "member:one",
      sessionAuthorizationId: "session:one",
      cursor: resumeCursor,
      limit: 100,
    });
    expect(resumed.status === "ready" ? resumed.events.map(({ event }) => event.sequence) : []).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 51),
    );
  });

  it("appends clarification immutably and creates a distinct linked retry", async () => {
    const dependencies = createHarness();
    const created = await submitOne(dependencies);
    if (!("runId" in created)) throw new Error("run missing");
    const claim = await dependencies.repository.claim(created.runId, "worker:one", NOW, "2026-08-07T10:01:00.000Z");
    if (claim.status !== "claimed") throw new Error("claim missing");
    await dependencies.repository.awaitClarification(claim.fence, NOW, ["joint:knee"]);
    const protectClarification = vi.fn(async () => ({ status: "stored" as const, protectedPromptSnapshotId: "prompt:clarification" }));
    const answer = createAnswerWorkoutClarification({
      repository: dependencies.repository, authorization: dependencies.authorization,
      protectPrompt: protectClarification,
      createId: () => "input:clarification", now: () => NOW,
    });
    await expect(answer({ runId: created.runId, coachId: "coach:one", memberId: "member:one", sessionAuthorizationId: "session:one", answer: "Use the patellofemoral restriction" }))
      .resolves.toEqual({ status: "requeued", revision: 2 });
    expect(protectClarification).toHaveBeenCalledWith(expect.objectContaining({
      previousProtectedPromptSnapshotId: "prompt:protected",
      prompt: "Use the patellofemoral restriction",
    }));
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

  it("reserves retry identity before provisioning a replacement grant under concurrency", async () => {
    const dependencies = createHarness();
    const created = await submitOne(dependencies);
    if (!("runId" in created)) throw new Error("run missing");
    const claim = await dependencies.repository.claim(created.runId, "worker:retry-source", NOW, "2026-08-07T10:01:00.000Z");
    if (claim.status !== "claimed") throw new Error("claim missing");
    await dependencies.repository.fail(claim.fence, {
      kind: "provider-failure", stage: "composition", safeMessage: "Workout generation could not be completed.", occurredAt: NOW,
    });
    const retry = createRetryWorkoutRun({
      repository: dependencies.repository,
      authorization: dependencies.authorization,
      createId: (() => { let value = 0; return (kind) => `${kind}:concurrent-retry:${++value}`; })(),
      now: () => NOW,
      modelConfigurationId: "model:test",
      policyRevision: "policy:v1",
    });
    vi.mocked(dependencies.authorization.createReference).mockClear();
    let releaseGrant!: () => void;
    const grantGate = new Promise<void>((resolve) => { releaseGrant = resolve; });
    vi.mocked(dependencies.authorization.createReference).mockImplementationOnce(async ({ runId }) => {
      await grantGate;
      return { status: "authorized" as const, authorizationReferenceId: `grant-ref:${runId}` };
    });

    const input = { runId: created.runId, coachId: "coach:one", memberId: "member:one", sessionAuthorizationId: "session:one", idempotencyKey: "retry:concurrent" };
    const first = retry(input);
    await vi.waitFor(() => expect(dependencies.authorization.createReference).toHaveBeenCalledTimes(1));
    const duplicate = retry(input);
    await Promise.resolve();

    expect(dependencies.authorization.createReference).toHaveBeenCalledTimes(1);
    releaseGrant();
    const results = await Promise.all([first, duplicate]);
    expect(results.map(({ status }) => status).sort()).toEqual(["created", "replayed"]);
    expect(dependencies.authorization.createReference).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ runId: (results[1] as { runId?: string }).runId });
  });
});
