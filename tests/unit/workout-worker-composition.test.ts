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
} from "../../src/server/workout-worker-composition";
import type { WorkoutServerInfrastructure } from "../../src/server/workout-route-composition";
import { createProtectedWorkoutInputVault } from "../../src/server/workout-protected-input";

const NOW = "2026-08-07T10:00:00.000Z";

function authorization(): WorkerAuthorizationPort {
  return {
    authorizeSession: async () => ({ status: "authorized", authorizationId: "session:worker-test" }),
    createReference: async ({ runId }) => ({ status: "authorized", authorizationReferenceId: `grant:${runId}` }),
    authorize: async () => ({ status: "authorized", authorizationId: "scope:worker-test" }),
  };
}

const reviewed = (stableConceptId: string) => ({
  state: "reviewed" as const,
  graph: "movement-clinical" as const,
  stableConceptId,
  reviewedBy: "reviewer:test",
  reviewedAt: NOW,
  sourceArtifactDigest: "sha256:reviewed",
});

function canonicalInfrastructure(constraints: WorkoutConstraintsProjection) {
  const protectedInput = createProtectedWorkoutInputVault("p".repeat(32));
  const catalog = [
    {
      exerciseConceptId: "exercise:goblet-squat",
      exerciseAssertionId: "assertion:exercise:squat",
      attributes: { priorityTier: "1", supportsWeight: true, isBilateral: true },
      relations: [
        { kind: "requires", targetConceptId: "equipment:dumbbell", targetKind: "equipment", targetAssertionId: "assertion:equipment:dumbbell", edgeAssertionId: "assertion:requires:dumbbell" },
        { kind: "expresses", targetConceptId: "movement-pattern:lower-body", targetKind: "movement-pattern", targetAssertionId: "assertion:pattern:lower", edgeAssertionId: "assertion:expresses:lower" },
      ],
      familyRelations: [],
    },
    {
      exerciseConceptId: "exercise:barbell-row",
      exerciseAssertionId: "assertion:exercise:row",
      attributes: { priorityTier: "1", supportsWeight: true, isBilateral: true },
      relations: [
        { kind: "requires", targetConceptId: "equipment:barbell", targetKind: "equipment", targetAssertionId: "assertion:equipment:barbell", edgeAssertionId: "assertion:requires:barbell" },
        { kind: "expresses", targetConceptId: "movement-pattern:upper-body", targetKind: "movement-pattern", targetAssertionId: "assertion:pattern:upper", edgeAssertionId: "assertion:expresses:upper" },
      ],
      familyRelations: [],
    },
  ] as const;
  const graphResult = <T>(data: T) => ({ status: "ok" as const, graphRevisionId: "movement:one", authority: "canonical" as const, data });
  const movementHandle = {
    graphRevisionId: "movement:one",
    authority: "canonical" as const,
    resolveConceptCandidates: async ({ text }: { text: string }) => {
      const normalized = text.toLocaleLowerCase();
      const match = normalized === "lower body" || normalized === "lower-body strength"
        ? { conceptId: "movement-pattern:lower-body", assertionId: "assertion:pattern:lower", kind: "movement-pattern" as const, label: "Lower body", exactMatchedAlias: text }
        : normalized === "upper body" || normalized === "upper-body strength"
          ? { conceptId: "movement-pattern:upper-body", assertionId: "assertion:pattern:upper", kind: "movement-pattern" as const, label: "Upper body", exactMatchedAlias: text }
          : normalized === "goblet squat"
            ? { conceptId: "exercise:goblet-squat", assertionId: "assertion:exercise:squat", kind: "exercise" as const, label: "Goblet squat", exactMatchedAlias: text }
          : undefined;
      return graphResult(match ? [{ ...match, fuzzyMatchedAlias: text, fuzzyScore: 1, vectorMatchedAlias: text, vectorScore: 1, groundingStatus: "active-mapping" as const, mappingAssertionIds: [] }] : []);
    },
    getCatalogExerciseFacts: async () => graphResult(catalog),
    getCatalogFamilyFacts: async ({ conceptId }: { conceptId: string }) => graphResult(
      conceptId === "movement-pattern:lower-body" ? [{
        exerciseConceptId: "exercise:goblet-squat", exerciseAssertionId: "assertion:exercise:squat", matchedConceptId: conceptId,
        matchedConceptAssertionId: "assertion:pattern:lower", matchKind: "expresses" as const, pathAssertionIds: ["assertion:expresses:lower"],
      }] : conceptId === "exercise:goblet-squat" ? [{
        exerciseConceptId: "exercise:goblet-squat", exerciseAssertionId: "assertion:exercise:squat", matchedConceptId: conceptId,
        matchedConceptAssertionId: "assertion:exercise:squat", matchKind: "exact-exercise" as const, pathAssertionIds: ["assertion:exercise:squat"],
      }] : [],
    ),
    getClinicalRuleFacts: async ({ conditionConceptId }: { conditionConceptId: string }) => graphResult(conditionConceptId === "condition:knee-pain" ? [{
      conditionConceptId,
      conditionAssertionId: "assertion:condition:knee-pain",
      ruleConceptId: "clinical-rule:knee-pain",
      ruleAssertionId: "assertion:rule:knee-pain",
      effect: "caution" as const,
      applicability: { conditionStatuses: ["active"], recoveryStages: ["return-to-training"], severityBands: ["moderate"], lateralityPolicy: "conservative-when-unknown" as const },
      overridePolicy: { allowed: false, rationaleRequired: false },
      targetConceptId: "joint:knee",
      targetKind: "joint" as const,
      pathAssertionIds: ["assertion:rule-target:knee"],
      mappingAssertionIds: [],
      evidenceAssertionIds: ["assertion:evidence:knee"],
    }] : []),
    getAnatomyPaths: async ({ conceptId }: { conceptId: string }) => graphResult([{
      descendantConceptId: conceptId,
      ancestorConceptId: conceptId,
      nodeAssertionIds: ["assertion:joint:knee"],
      edgeAssertionIds: [],
    }]),
    getExerciseConstraintFacts: async ({ exerciseConceptId }: { exerciseConceptId: string }) => graphResult(catalog.find((item) => item.exerciseConceptId === exerciseConceptId)!),
    getSubstitutionCandidates: async () => graphResult([]),
    getAssertions: async () => graphResult([]),
  };
  const memberHandle = {
    memberId: "member:one",
    coachId: "coach:one",
    contextRevisionId: "member:one",
    authority: "canonical" as const,
    getWorkoutConstraints: async () => ({ status: "ready" as const, memberId: "member:one", contextRevisionId: "member:one", authority: "canonical" as const, evidenceIds: [], data: constraints }),
  };
  const record = { get: (field: string) => field === "sealId" ? "revision-seal:test" : "sha256:seal" };
  return {
    environment: "test",
    secret: "p".repeat(32),
    protectedInput,
    repository: new InMemoryWorkoutRunRepository({ cursorSecret: "canonical-runtime" }),
    authorization: authorization(),
    movement: { openActive: async () => ({ status: "ready" as const, handle: movementHandle }), openRevision: async () => ({ status: "ready" as const, handle: movementHandle }) },
    memberContext: { openActive: async () => ({ status: "ready" as const, handle: memberHandle }), openRevision: async () => ({ status: "ready" as const, handle: memberHandle }) },
    client: { executeRead: async (work: (transaction: { run: () => Promise<{ records: readonly typeof record[] }> }) => unknown) => work({ run: async () => ({ records: [record] }) }), close: async () => undefined },
  } as unknown as WorkoutServerInfrastructure;
}

function runtimeOptions() {
  return { workerId: "worker:test", modelId: "openai/gpt-5-mini", gatewayApiKey: "gateway-test-key", leaseDurationMs: 60_000, heartbeatEveryMs: 10_000, executionTimeoutMs: 30_000, providerTimeoutMs: 5_000 };
}

function resolvingRun(infrastructure: ReturnType<typeof canonicalInfrastructure>, prompt: string, revision = 1) {
  const runId = asWorkoutRunId("workout-run:canonical-resolution");
  const sealed = infrastructure.protectedInput.protect({ coachId: "coach:one", memberId: "member:one", runId, prompt });
  if (sealed.status !== "stored") throw new Error("prompt protection failed");
  const inputRevisionId = asWorkoutInputRevisionId(`input:resolution:${revision}`);
  return {
    runId,
    coachId: "coach:one",
    memberId: "member:one",
    memberContextRevisionId: "member:one",
    movementGraphRevisionId: "movement:one",
    requestedDurationMinutes: 45,
    inputRevisions: [{ inputRevisionId, revision, protectedPromptSnapshotId: sealed.protectedPromptSnapshotId, promptDigest: "sha256:prompt", effectiveInputDigest: "sha256:effective", createdAt: NOW }],
    activeInputRevisionId: inputRevisionId,
  } as never;
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

  it("allows deterministic queue mode without provider credentials outside production", () => {
    expect(readConfiguredWorkoutWorkerOptions({
      NODE_ENV: "development",
      WORKOUT_DEMO_MODE: "deterministic",
      WORKOUT_ROUTE_SECRET: "x".repeat(32),
      WORKOUT_WORKER_ID: "worker:demo",
    })).toMatchObject({ mode: "deterministic", modelId: "demo:deterministic" });
  });

  it("instantiates the configured model through the AI Gateway provider", () => {
    const model = createConfiguredWorkoutGatewayModel({
      gatewayApiKey: "gateway-test-key",
      modelId: "openai/gpt-5-mini",
    });

    expect(model).toMatchObject({ provider: "gateway", modelId: "openai/gpt-5-mini" });
    expect(model.doGenerate).toBeTypeOf("function");
  });

  it("resolves distinct protected prompts and carries reviewed equipment/preferences into graph safety", async () => {
    const constraints = {
      injuries: [],
      equipment: [{
        evidenceId: "evidence:equipment",
        assertionId: "assertion:member:dumbbell",
        available: true,
        domainReference: reviewed("equipment:dumbbell"),
      }],
      preferences: [{ evidenceId: "evidence:preference", domainReferences: [reviewed("movement-pattern:lower-body")] }],
    } as unknown as WorkoutConstraintsProjection;
    const infrastructure = canonicalInfrastructure(constraints);
    const runtime = createCanonicalWorkoutRuntimeDependencies(infrastructure, runtimeOptions());
    const lower = resolvingRun(infrastructure, "Lower-body strength");
    const upper = resolvingRun(infrastructure, "Upper-body strength");
    const excluded = resolvingRun(infrastructure, "Lower body workout, avoid goblet squat.");
    const runId = asWorkoutRunId("workout-run:canonical-resolution");
    const grant = await runtime.authorizeGrant({
      authorizationReferenceId: "grant:test",
      runId,
      coachId: "coach:one",
      memberId: "member:one",
      stage: "constraints",
    });
    if (grant.status !== "authorized") throw new Error("test grant failed");

    const lowerResolved = await runtime.resolveConstraints({ run: lower, authorizationId: grant.authorizationId });
    const upperResolved = await runtime.resolveConstraints({ run: upper, authorizationId: grant.authorizationId });
    const excludedResolved = await runtime.resolveConstraints({ run: excluded, authorizationId: grant.authorizationId });
    expect(lowerResolved).toMatchObject({ status: "ready", canonicalIntent: { focusConceptIds: ["movement-pattern:lower-body"] } });
    expect(upperResolved).toMatchObject({ status: "ready", canonicalIntent: { focusConceptIds: ["movement-pattern:upper-body"] } });
    expect(excludedResolved).toMatchObject({ status: "ready", explicitExclusions: [{ conceptId: "exercise:goblet-squat", resolution: { certificateId: expect.stringMatching(/^resolution-certificate:/) } }] });
    if (lowerResolved.status !== "ready") throw new Error("resolution failed");
    expect(lowerResolved.preferences).toHaveLength(1);
    const evaluated = await runtime.evaluateCatalogSafety({
      coachId: "coach:one", memberId: "member:one", authorizationId: grant.authorizationId, runId,
      memberContextRevisionId: "member:one", movementGraphRevisionId: "movement:one",
      injuryApplicability: lowerResolved.injuryApplicability,
      explicitExclusions: lowerResolved.explicitExclusions,
      preferences: lowerResolved.preferences,
    });
    expect(evaluated).toMatchObject({
      status: "ready",
      downranked: [expect.objectContaining({ exerciseConceptId: "exercise:goblet-squat" })],
      excluded: [expect.objectContaining({ exerciseConceptId: "exercise:barbell-row" })],
    });
    if (excludedResolved.status !== "ready") throw new Error("exclusion resolution failed");
    const excludedEvaluation = await runtime.evaluateCatalogSafety({
      coachId: "coach:one", memberId: "member:one", authorizationId: grant.authorizationId, runId,
      memberContextRevisionId: "member:one", movementGraphRevisionId: "movement:one",
      injuryApplicability: [], explicitExclusions: excludedResolved.explicitExclusions, preferences: excludedResolved.preferences,
    });
    expect(excludedEvaluation).toMatchObject({
      status: "ready",
      excluded: expect.arrayContaining([expect.objectContaining({ exerciseConceptId: "exercise:goblet-squat" })]),
    });
  });

  it("clarifies only missing injury applicability fields, then resolves after an authenticated structured answer", async () => {
    const constraints = {
      equipment: [{ evidenceId: "evidence:equipment", assertionId: "assertion:member:dumbbell", available: true, domainReference: reviewed("equipment:dumbbell") }],
      preferences: [],
      injuries: [{
        evidenceId: "evidence:knee",
        assertionId: "assertion:member:knee",
        status: "recovering",
        severity: "mild",
        domainReferences: [reviewed("condition:knee-pain"), reviewed("joint:knee")],
      }],
    } as unknown as WorkoutConstraintsProjection;
    const infrastructure = canonicalInfrastructure(constraints);
    const runtime = createCanonicalWorkoutRuntimeDependencies(infrastructure, runtimeOptions());
    const run = resolvingRun(infrastructure, "Lower-body strength") as unknown as {
      runId: ReturnType<typeof asWorkoutRunId>;
      coachId: string;
      memberId: string;
      inputRevisions: { inputRevisionId: ReturnType<typeof asWorkoutInputRevisionId>; revision: number; protectedPromptSnapshotId: string; promptDigest: string; effectiveInputDigest: string; createdAt: string }[];
      activeInputRevisionId: ReturnType<typeof asWorkoutInputRevisionId>;
    };
    const grant = await runtime.authorizeGrant({ authorizationReferenceId: "grant:test", runId: run.runId, coachId: run.coachId, memberId: run.memberId, stage: "constraints" });
    if (grant.status !== "authorized") throw new Error("test grant failed");
    const first = await runtime.resolveConstraints({ run: run as never, authorizationId: grant.authorizationId });
    expect(first).toMatchObject({
      status: "clarification-required",
      candidateConceptIds: expect.arrayContaining([
        expect.stringMatching(/^clarification:/),
      ]),
      clarification: {
        schemaVersion: "workout-clarification/v1",
        fields: expect.arrayContaining([
          expect.objectContaining({ key: "recoveryStage", allowedValues: expect.any(Array) }),
          expect.objectContaining({ key: "affectedLaterality", allowedValues: expect.any(Array) }),
        ]),
      },
    });

    const answer = infrastructure.protectedInput.protect({
      coachId: run.coachId,
      memberId: run.memberId,
      runId: run.runId,
      prompt: JSON.stringify({ injuries: { "evidence:knee": { conditionStatus: "active", recoveryStage: "return-to-training", severityBand: "moderate", affectedLaterality: "left" } } }),
      previousProtectedPromptSnapshotId: run.inputRevisions[0]!.protectedPromptSnapshotId,
    });
    if (answer.status !== "stored") throw new Error("answer protection failed");
    const revisedId = asWorkoutInputRevisionId("input:resolution:2");
    run.inputRevisions.push({ inputRevisionId: revisedId, revision: 2, protectedPromptSnapshotId: answer.protectedPromptSnapshotId, promptDigest: "sha256:answer", effectiveInputDigest: "sha256:revised", createdAt: NOW });
    run.activeInputRevisionId = revisedId;
    const revised = await runtime.resolveConstraints({ run: run as never, authorizationId: grant.authorizationId });
    expect(revised).toMatchObject({
      status: "ready",
      canonicalIntent: { focusConceptIds: ["movement-pattern:lower-body"] },
      injuryApplicability: [{
        memberEvidenceId: "evidence:knee",
        conditionConceptId: "condition:knee-pain",
        affectedAnatomyConceptId: "joint:knee",
        conditionStatus: "active",
        recoveryStage: "return-to-training",
        severityBand: "moderate",
        affectedLaterality: "left",
        resolution: { certificateId: expect.stringMatching(/^resolution-certificate:/) },
      }],
    });
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
