import { randomBytes, randomUUID } from "node:crypto";
import { createGateway } from "ai";
import { createAiSdkWorkoutComposer } from "../agents/workout/ai-sdk-composer";
import { InMemoryCatalogSafetySessionStore } from "../application/ports/catalog-safety-sessions";
import type { WorkerAuthorizationPort } from "../application/ports/worker-authorization";
import type { WorkoutRunRepository } from "../application/ports/workout-run-repository";
import { createClaimWorkoutRun } from "../application/use-cases/claim-workout-run";
import {
  createEvaluateCatalogSafety,
  type CatalogSafetyResolutionCertificateVerifier,
} from "../application/use-cases/evaluate-catalog-safety";
import {
  createExecuteWorkoutRun,
  type ExecuteWorkoutRunDependencies,
} from "../application/use-cases/execute-workout-run";
import { createRetrieveMemberContext } from "../application/use-cases/retrieve-member-context";
import { createValidateWorkoutCandidates } from "../application/use-cases/validate-workout-candidates";
import type { WorkoutRunId } from "../domain/contracts/workout";
import type { WorkoutConstraintsProjection } from "../domain/contracts/member-context-queries";
import type { WorkoutCompositionCandidate } from "../domain/policies/workout-composition";
import { MEMBER_CONTEXT_CYPHER } from "../graph/cypher/member-context";
import { MOVEMENT_CYPHER } from "../graph/cypher/movement";
import { canonicalWorkoutDigest } from "../graph/schema/workout-run-schema";
import { createWorkoutRunWorker, type WorkoutRunWorkerDependencies } from "../workers/workout-run-worker";
import {
  createConfiguredWorkoutServerInfrastructure,
  workoutRouteSecret,
  type WorkoutServerInfrastructure,
} from "./workout-route-composition";

type Environment = Readonly<Record<string, string | undefined>>;

export type ConfiguredWorkoutWorkerOptions = {
  readonly workerId: string;
  readonly modelId: string;
  readonly gatewayApiKey: string;
  readonly leaseDurationMs: number;
  readonly heartbeatEveryMs: number;
  readonly executionTimeoutMs: number;
  readonly providerTimeoutMs: number;
};

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} must be configured for the workout worker`);
  return value;
}

function positiveInteger(environment: Environment, name: string, fallback: number): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** Validate all worker-specific configuration before opening a graph connection. */
export function readConfiguredWorkoutWorkerOptions(environment: Environment = process.env): ConfiguredWorkoutWorkerOptions {
  const runtimeEnvironment = environment.NODE_ENV ?? "production";
  workoutRouteSecret(runtimeEnvironment, environment.WORKOUT_ROUTE_SECRET);
  if (runtimeEnvironment === "production") {
    required(environment, "NEO4J_URI");
    required(environment, "NEO4J_USERNAME");
    required(environment, "NEO4J_PASSWORD");
  }
  const workerId = required(environment, "WORKOUT_WORKER_ID");
  const modelId = required(environment, "WORKOUT_MODEL_ID");
  const gatewayApiKey = required(environment, "AI_GATEWAY_API_KEY");
  const leaseDurationMs = positiveInteger(environment, "WORKOUT_LEASE_DURATION_MS", 60_000);
  const heartbeatEveryMs = positiveInteger(environment, "WORKOUT_HEARTBEAT_INTERVAL_MS", 15_000);
  const executionTimeoutMs = positiveInteger(environment, "WORKOUT_EXECUTION_TIMEOUT_MS", 45_000);
  const providerTimeoutMs = positiveInteger(environment, "WORKOUT_PROVIDER_TIMEOUT_MS", 15_000);
  if (heartbeatEveryMs >= leaseDurationMs) {
    throw new Error("WORKOUT_HEARTBEAT_INTERVAL_MS must be shorter than WORKOUT_LEASE_DURATION_MS");
  }
  return Object.freeze({ workerId, modelId, gatewayApiKey, leaseDurationMs, heartbeatEveryMs, executionTimeoutMs, providerTimeoutMs });
}

export function createConfiguredWorkoutGatewayModel(options: Pick<ConfiguredWorkoutWorkerOptions, "gatewayApiKey" | "modelId">) {
  return createGateway({ apiKey: options.gatewayApiKey })(options.modelId);
}

export type WorkoutWorkerCompositionDependencies = {
  readonly repository: WorkoutRunRepository;
  readonly authorization: WorkerAuthorizationPort;
  readonly executeClaimed: WorkoutRunWorkerDependencies["executeClaimed"];
  readonly workerId: string;
  readonly now: () => string;
  readonly leaseDurationMs: number;
  readonly heartbeatEveryMs: number;
  readonly executionTimeoutMs: number;
};

/** Compose the detached worker around injected application dependencies. */
export function createWorkoutWorkerComposition(dependencies: WorkoutWorkerCompositionDependencies) {
  if (!Number.isSafeInteger(dependencies.executionTimeoutMs) || dependencies.executionTimeoutMs <= 0) {
    throw new Error("executionTimeoutMs must be a positive integer");
  }
  const worker = createWorkoutRunWorker({
    repository: dependencies.repository,
    claim: createClaimWorkoutRun({ repository: dependencies.repository, authorization: dependencies.authorization }),
    executeClaimed: dependencies.executeClaimed,
    workerId: dependencies.workerId,
    now: dependencies.now,
    leaseDurationMs: dependencies.leaseDurationMs,
    heartbeatEveryMs: dependencies.heartbeatEveryMs,
  });
  return Object.freeze({
    runExplicit(input: {
      readonly runId: WorkoutRunId;
      readonly coachId: string;
      readonly memberId: string;
      readonly signal?: AbortSignal;
    }) {
      const timeout = AbortSignal.timeout(dependencies.executionTimeoutMs);
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
      return worker.runOnce({ ...input, signal });
    },
  });
}

type ProcessScope = { readonly coachId: string; readonly memberId: string };

function createScopedGrantAuthorizer(authorization: WorkerAuthorizationPort) {
  const scopes = new Map<string, ProcessScope>();
  const authorizeGrant: ExecuteWorkoutRunDependencies["authorizeGrant"] = async (input) => {
    const result = await authorization.authorize(input);
    if (result.status === "authorized") {
      scopes.set(result.authorizationId, { coachId: input.coachId, memberId: input.memberId });
    }
    return result;
  };
  const authorizeMemberContext = (claims: { readonly coachId: string; readonly memberId: string; readonly authorizationId: string }) => {
    const scope = scopes.get(claims.authorizationId);
    return scope?.coachId === claims.coachId && scope.memberId === claims.memberId;
  };
  return { authorizeGrant, authorizeMemberContext };
}

const deniedCertificates: CatalogSafetyResolutionCertificateVerifier = Object.freeze({
  trustedIssuerId: "workout-worker:no-implicit-resolution",
  verify: async () => ({ status: "invalid" as const }),
});

const defaultCandidate = (exerciseConceptId: string): WorkoutCompositionCandidate => ({
  exerciseConceptId,
  allowedSections: ["warm-up", "main", "cool-down"],
  doseBounds: {
    minimumSets: 1,
    maximumSets: 12,
    minimumWorkSecondsPerSet: 30,
    maximumWorkSecondsPerSet: 3_600,
    minimumRestSeconds: 0,
    maximumRestSeconds: 300,
  },
  transitionSeconds: 0,
});

function reviewedReferences(references: readonly { readonly state: string; readonly graph?: string; readonly stableConceptId?: string }[]) {
  return references.flatMap((reference) => reference.state === "reviewed"
    && reference.graph === "movement-clinical" && reference.stableConceptId ? [reference.stableConceptId] : []);
}

/** IDs requiring an upstream verified resolution artifact before safety can run. */
export function unresolvedWorkoutConstraintIds(
  constraints: Pick<WorkoutConstraintsProjection, "equipment" | "injuries" | "preferences">,
): readonly string[] {
  return [...new Set([
    ...constraints.injuries.flatMap((injury) => {
      const references = reviewedReferences(injury.domainReferences);
      return references.length > 0 ? references : [injury.evidenceId];
    }),
    ...constraints.equipment.flatMap((equipment) => {
      const references = reviewedReferences([equipment.domainReference]);
      return references.length > 0 ? references : [equipment.evidenceId];
    }),
    ...constraints.preferences.flatMap((preference) => {
      const references = reviewedReferences(preference.domainReferences);
      return references.length > 0 ? references : [preference.evidenceId];
    }),
  ])].sort();
}

async function readRevisionSeals(
  infrastructure: WorkoutServerInfrastructure,
  memberId: string,
  movementGraphRevisionId: string,
  memberContextRevisionId: string,
) {
  return infrastructure.client.executeRead(async (transaction) => {
    const movement = (await transaction.run(MOVEMENT_CYPHER.readSealedRevision, { revisionId: movementGraphRevisionId })).records[0];
    const member = (await transaction.run(MEMBER_CONTEXT_CYPHER.readSealedRevision, { memberId, contextRevisionId: memberContextRevisionId })).records[0];
    const movementGraphSealId = movement?.get("sealId");
    const movementGraphSealDigest = movement?.get("canonicalDigest");
    const memberContextSealId = member?.get("sealId");
    const memberContextSealDigest = member?.get("canonicalDigest");
    if (![movementGraphSealId, movementGraphSealDigest, memberContextSealId, memberContextSealDigest]
      .every((value) => typeof value === "string" && value.length > 0)) return undefined;
    return {
      schemaVersion: "workout-revision-seals/v1" as const,
      movementGraphRevisionId,
      movementGraphSealId: movementGraphSealId as string,
      movementGraphSealDigest: movementGraphSealDigest as string,
      memberContextRevisionId,
      memberContextSealId: memberContextSealId as string,
      memberContextSealDigest: memberContextSealDigest as string,
    };
  });
}

export function createCanonicalWorkoutRuntimeDependencies(
  infrastructure: WorkoutServerInfrastructure,
  options: ConfiguredWorkoutWorkerOptions,
): ExecuteWorkoutRunDependencies {
  const now = () => new Date().toISOString();
  const sessions = new InMemoryCatalogSafetySessionStore();
  const scoped = createScopedGrantAuthorizer(infrastructure.authorization);
  const retrieveMemberContext = createRetrieveMemberContext({
    memberContext: infrastructure.memberContext,
    authorizeMemberContext: scoped.authorizeMemberContext,
  });
  const resolveConstraints: ExecuteWorkoutRunDependencies["resolveConstraints"] = async ({ run, authorizationId, persistedSnapshot }) => {
    const member = await retrieveMemberContext({
      coachId: run.coachId,
      memberId: run.memberId,
      authorizationId,
      contextRevisionId: run.memberContextRevisionId,
    });
    if (member.status !== "ready") return { status: "failed", reason: "graph-unavailable" };
    const constraints = await member.handle.getWorkoutConstraints({ limit: 100, timeoutMs: 1_000 });
    if (constraints.status !== "ready" || member.handle.authority !== "canonical") {
      return { status: "failed", reason: "graph-unavailable" };
    }
    // These inputs require separately verified resolution certificates. Until
    // a producer exists, never silently omit or infer them from member text.
    const candidateConceptIds = unresolvedWorkoutConstraintIds(constraints.data);
    if (candidateConceptIds.length > 0) {
      return { status: "clarification-required", candidateConceptIds };
    }
    const movement = await infrastructure.movement.openRevision(run.movementGraphRevisionId);
    if (movement.status !== "ready" || movement.handle.authority !== "canonical") {
      return { status: "failed", reason: "graph-unavailable" };
    }
    const catalog = await movement.handle.getCatalogExerciseFacts({ maxResults: 100 });
    if (catalog.status !== "ok") return { status: "failed", reason: "graph-unavailable" };
    const revisionSeals = await readRevisionSeals(
      infrastructure,
      run.memberId,
      run.movementGraphRevisionId,
      run.memberContextRevisionId,
    );
    if (!revisionSeals) return { status: "failed", reason: "graph-unavailable" };
    const canonicalConstraintIds = [...new Set([
      ...constraints.data.equipment.flatMap(({ domainReference }) => domainReference.state === "reviewed"
        && domainReference.graph === "movement-clinical" && domainReference.stableConceptId ? [domainReference.stableConceptId] : []),
      ...constraints.data.preferences.flatMap((preference) => preference.domainReferences.flatMap((reference) => reference.state === "reviewed"
        && reference.graph === "movement-clinical" && reference.stableConceptId ? [reference.stableConceptId] : [])),
    ])].sort();
    const evidenceIds = [...new Set([
      ...constraints.data.equipment.map(({ evidenceId }) => evidenceId),
      ...constraints.data.preferences.map(({ evidenceId }) => evidenceId),
    ])].sort();
    const snapshotBase = {
      schemaVersion: "resolved-constraint-snapshot/v1" as const,
      movementGraphRevisionId: run.movementGraphRevisionId,
      memberContextRevisionId: run.memberContextRevisionId,
      canonicalConstraintIds,
      applicabilityAssertionIds: [] as readonly string[],
      evidenceIds,
      zeroMatchCertificates: [] as const,
      resolverVersion: "canonical-member-context/v1",
      searchPolicyVersion: "canonical-exact-reference/v1",
    };
    const snapshot = persistedSnapshot ?? { ...snapshotBase, digest: canonicalWorkoutDigest(snapshotBase) };
    return {
      status: "ready",
      snapshot,
      canonicalIntent: {
        focusConceptIds: canonicalConstraintIds.filter((id) => id.startsWith("movement-pattern:")),
        requestedDurationMinutes: run.requestedDurationMinutes,
      },
      injuryApplicability: [],
      explicitExclusions: [],
      preferences: [],
      candidateProfiles: catalog.data.map(({ exerciseConceptId }) => defaultCandidate(exerciseConceptId)),
      revisionSeals,
    };
  };
  const evaluateCatalogSafety = createEvaluateCatalogSafety({
    movement: infrastructure.movement,
    memberContext: infrastructure.memberContext,
    authorizeMemberContext: scoped.authorizeMemberContext,
    sessions,
    tokenSource: { randomBytes },
    now,
    securityAudit: { record: () => undefined },
    resolutionCertificates: deniedCertificates,
  });
  const validateCandidates: ExecuteWorkoutRunDependencies["validateCandidates"] = (request) => createValidateWorkoutCandidates({
    sessions,
    authorizeMemberContext: scoped.authorizeMemberContext,
    now,
    securityAudit: { record: () => undefined },
    trustedBinding: request.binding,
  })(request);
  return {
    repository: infrastructure.repository,
    authorizeGrant: scoped.authorizeGrant,
    resolveConstraints,
    evaluateCatalogSafety,
    validateCandidates,
    composer: createAiSdkWorkoutComposer({ model: createConfiguredWorkoutGatewayModel(options), timeoutMs: options.providerTimeoutMs }),
    now,
    createId: (kind) => `${kind}:${randomUUID()}`,
  };
}

/** Production entry composition. It is intentionally never imported by request handlers. */
export function createConfiguredWorkoutWorkerComposition(
  environment: Environment = process.env,
  suppliedInfrastructure?: WorkoutServerInfrastructure,
) {
  const options = readConfiguredWorkoutWorkerOptions(environment);
  const infrastructure = suppliedInfrastructure ?? createConfiguredWorkoutServerInfrastructure(environment);
  const runtime = createExecuteWorkoutRun(createCanonicalWorkoutRuntimeDependencies(infrastructure, options));
  const worker = createWorkoutWorkerComposition({
    repository: infrastructure.repository,
    authorization: infrastructure.authorization,
    executeClaimed: runtime,
    workerId: options.workerId,
    now: () => new Date().toISOString(),
    leaseDurationMs: options.leaseDurationMs,
    heartbeatEveryMs: options.heartbeatEveryMs,
    executionTimeoutMs: options.executionTimeoutMs,
  });
  return Object.freeze({ ...worker, close: () => infrastructure.client.close() });
}
