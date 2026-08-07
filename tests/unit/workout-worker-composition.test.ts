import { describe, expect, it, vi } from "vitest";
import { createSubmitWorkoutRun } from "../../src/application/use-cases/submit-workout-run";
import type { WorkerAuthorizationPort } from "../../src/application/ports/worker-authorization";
import type { WorkoutConstraintsProjection } from "../../src/domain/contracts/member-context-queries";
import { asWorkoutInputRevisionId, asWorkoutRunId } from "../../src/domain/contracts/workout";
import { InMemoryWorkoutRunRepository } from "../../src/graph/repositories/workout-runs";
import {
  createWorkoutWorkerComposition,
  createConfiguredWorkoutGatewayModel,
  createCanonicalWorkoutRuntimeDependencies,
  readConfiguredWorkoutWorkerOptions,
  unresolvedWorkoutConstraintIds,
} from "../../src/server/workout-worker-composition";
import type { WorkoutServerInfrastructure } from "../../src/server/workout-route-composition";

const NOW = "2026-08-07T10:00:00.000Z";

function authorization(): WorkerAuthorizationPort {
  return {
    createReference: async ({ runId }) => ({ status: "authorized", authorizationReferenceId: `grant:${runId}` }),
    authorize: async () => ({ status: "authorized", authorizationId: "scope:worker-test" }),
  };
}

describe("workout worker production composition", () => {
  it("claims a submitted queued run and drives it to a durable terminal state", async () => {
    const repository = new InMemoryWorkoutRunRepository({ cursorSecret: "worker-composition-test", now: () => NOW });
    const grants = authorization();
    const submit = createSubmitWorkoutRun({
      repository,
      authorization: grants,
      pinRevisions: async () => ({ status: "ready", movementGraphRevisionId: "movement:one", memberContextRevisionId: "member:one" }),
      protectPrompt: async () => ({ status: "stored", protectedPromptSnapshotId: "protected:one" }),
      createId: (kind) => `${kind}:one`,
      now: () => NOW,
      modelConfigurationId: "model:test",
      policyRevision: "policy:test",
    });
    const submitted = await submit({
      coachId: "coach:one",
      memberId: "member:one",
      sessionAuthorizationId: "session:one",
      prompt: "A bounded workout",
      durationMinutes: 45,
      idempotencyKey: "worker-entry-1",
    });
    if (!("runId" in submitted)) throw new Error("submission failed");

    const composition = createWorkoutWorkerComposition({
      repository,
      authorization: grants,
      executeClaimed: async ({ claimed }) => {
        await repository.fail(claimed.fence, {
          kind: "graph-unavailable",
          stage: "deterministic-test",
          safeMessage: "Workout generation could not be completed.",
          occurredAt: NOW,
        });
        return { status: "failed", reason: "graph-unavailable" };
      },
      workerId: "worker:composition-test",
      now: () => NOW,
      leaseDurationMs: 60_000,
      heartbeatEveryMs: 10_000,
      executionTimeoutMs: 30_000,
    });

    await expect(composition.runExplicit({
      runId: submitted.runId,
      coachId: "coach:one",
      memberId: "member:one",
    })).resolves.toEqual({ status: "failed", reason: "graph-unavailable" });
    await expect(repository.getRun(submitted.runId, "coach:one", "member:one"))
      .resolves.toMatchObject({ state: "failed", failure: { stage: "deterministic-test" } });
  });

  it("fails closed when required production worker configuration is absent", () => {
    expect(() => readConfiguredWorkoutWorkerOptions({ NODE_ENV: "production" }))
      .toThrow(/WORKOUT_ROUTE_SECRET/);

    expect(() => readConfiguredWorkoutWorkerOptions({
      NODE_ENV: "production",
      WORKOUT_ROUTE_SECRET: "x".repeat(32),
      NEO4J_URI: "neo4j+s://graph.example.com:7687",
      NEO4J_USERNAME: "neo4j",
      NEO4J_PASSWORD: "not-a-local-password",
    })).toThrow(/WORKOUT_WORKER_ID/);

    expect(() => readConfiguredWorkoutWorkerOptions({
      NODE_ENV: "production",
      WORKOUT_ROUTE_SECRET: "x".repeat(32),
      NEO4J_URI: "neo4j+s://graph.example.com:7687",
      NEO4J_USERNAME: "neo4j",
      NEO4J_PASSWORD: "not-a-local-password",
      WORKOUT_WORKER_ID: "worker:production",
    })).toThrow(/WORKOUT_MODEL_ID/);

    expect(() => readConfiguredWorkoutWorkerOptions({
      NODE_ENV: "production",
      WORKOUT_ROUTE_SECRET: "x".repeat(32),
      NEO4J_URI: "neo4j+s://graph.example.com:7687",
      NEO4J_USERNAME: "neo4j",
      NEO4J_PASSWORD: "not-a-local-password",
      WORKOUT_WORKER_ID: "worker:production",
      WORKOUT_MODEL_ID: "openai/gpt-5-mini",
    })).toThrow(/AI_GATEWAY_API_KEY/);
  });

  it("instantiates the configured model through the AI Gateway provider", () => {
    const model = createConfiguredWorkoutGatewayModel({
      gatewayApiKey: "gateway-test-key",
      modelId: "openai/gpt-5-mini",
    });

    expect(model).toMatchObject({ provider: "gateway", modelId: "openai/gpt-5-mini" });
    expect(model.doGenerate).toBeTypeOf("function");
  });

  it("requires clarification for every unresolved member constraint category", () => {
    const constraints = {
      injuries: [{
        evidenceId: "evidence:injury",
        domainReferences: [{ state: "reviewed", graph: "movement-clinical", stableConceptId: "joint:knee" }],
      }],
      equipment: [{
        evidenceId: "evidence:equipment",
        domainReference: { state: "reviewed", graph: "movement-clinical", stableConceptId: "equipment:dumbbell" },
      }],
      preferences: [{
        evidenceId: "evidence:preference",
        domainReferences: [],
      }],
    } as unknown as WorkoutConstraintsProjection;

    expect(unresolvedWorkoutConstraintIds(constraints)).toEqual([
      "equipment:dumbbell",
      "evidence:preference",
      "joint:knee",
    ]);
    expect(unresolvedWorkoutConstraintIds({ injuries: [], equipment: [], preferences: [] })).toEqual([]);
  });

  it("stops configured resolution at clarification before graph safety or AI when constraints are unresolved", async () => {
    const constraints = {
      injuries: [],
      equipment: [{
        evidenceId: "evidence:equipment",
        domainReference: { state: "reviewed", graph: "movement-clinical", stableConceptId: "equipment:dumbbell" },
      }],
      preferences: [{ evidenceId: "evidence:preference", domainReferences: [] }],
    } as unknown as WorkoutConstraintsProjection;
    const movementOpen = vi.fn(async () => { throw new Error("movement graph must not be opened"); });
    const infrastructure = {
      repository: new InMemoryWorkoutRunRepository({ cursorSecret: "configured-resolution-test" }),
      authorization: authorization(),
      memberContext: {
        openActive: vi.fn(),
        openRevision: vi.fn(async () => ({
          status: "ready",
          handle: {
            memberId: "member:one",
            coachId: "coach:one",
            contextRevisionId: "member:one",
            authority: "canonical",
            getWorkoutConstraints: async () => ({
              status: "ready",
              memberId: "member:one",
              contextRevisionId: "member:one",
              authority: "canonical",
              evidenceIds: ["evidence:equipment", "evidence:preference"],
              data: constraints,
            }),
          },
        })),
      },
      movement: { openActive: movementOpen, openRevision: movementOpen },
    } as unknown as WorkoutServerInfrastructure;
    const runtime = createCanonicalWorkoutRuntimeDependencies(infrastructure, {
      workerId: "worker:test",
      modelId: "openai/gpt-5-mini",
      gatewayApiKey: "gateway-test-key",
      leaseDurationMs: 60_000,
      heartbeatEveryMs: 10_000,
      executionTimeoutMs: 30_000,
      providerTimeoutMs: 5_000,
    });
    const runId = asWorkoutRunId("workout-run:configured-resolution");
    const grant = await runtime.authorizeGrant({
      authorizationReferenceId: "grant:test",
      runId,
      coachId: "coach:one",
      memberId: "member:one",
      stage: "constraints",
    });
    if (grant.status !== "authorized") throw new Error("test grant failed");

    await expect(runtime.resolveConstraints({
      run: {
        runId,
        coachId: "coach:one",
        memberId: "member:one",
        memberContextRevisionId: "member:one",
        movementGraphRevisionId: "movement:one",
      } as never,
      authorizationId: grant.authorizationId,
    })).resolves.toEqual({
      status: "clarification-required",
      candidateConceptIds: ["equipment:dumbbell", "evidence:preference"],
    });
    expect(movementOpen).not.toHaveBeenCalled();
  });

  it("propagates caller cancellation through the bounded execution timeout", async () => {
    const repository = new InMemoryWorkoutRunRepository({ cursorSecret: "worker-composition-cancel" });
    const runId = asWorkoutRunId("workout-run:cancel");
    await repository.createOrFind({
      runId,
      coachId: "coach:one",
      memberId: "member:one",
      authorizationReferenceId: "grant:cancel",
      idempotencyKeyDigest: "sha256:cancel-key",
      requestDigest: "sha256:cancel-request",
      requestedDurationMinutes: 45,
      modelConfigurationId: "model:test",
      policyRevision: "policy:test",
      movementGraphRevisionId: "movement:one",
      memberContextRevisionId: "member:one",
      state: "queued",
      inputRevisions: [{
        inputRevisionId: asWorkoutInputRevisionId("input:cancel"),
        revision: 1,
        protectedPromptSnapshotId: "protected:cancel",
        promptDigest: "sha256:prompt",
        effectiveInputDigest: "sha256:effective",
        createdAt: new Date().toISOString(),
      }],
      activeInputRevisionId: asWorkoutInputRevisionId("input:cancel"),
    });
    const executeClaimed = vi.fn(async () => new Promise<never>(() => undefined));
    const composition = createWorkoutWorkerComposition({
      repository,
      authorization: authorization(),
      executeClaimed,
      workerId: "worker:composition-cancel",
      now: () => new Date().toISOString(),
      leaseDurationMs: 60_000,
      heartbeatEveryMs: 10_000,
      executionTimeoutMs: 30_000,
    });
    const controller = new AbortController();
    controller.abort(new Error("operator canceled"));

    await expect(composition.runExplicit({
      runId,
      coachId: "coach:one",
      memberId: "member:one",
      signal: controller.signal,
    })).resolves.toEqual({ status: "claim-lost" });
    expect(executeClaimed).not.toHaveBeenCalled();
  });
});
