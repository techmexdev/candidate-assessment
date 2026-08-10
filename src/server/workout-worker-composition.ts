import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createAiSdkWorkoutComposer } from "../agents/workout/ai-sdk-composer";
import { createAiSdkWorkoutReviewer } from "../agents/workout/ai-sdk-reviewer";
import { createDeterministicWorkoutComposer, createDeterministicWorkoutReviewer } from "../agents/workout/deterministic-agents";
import { InMemoryCatalogSafetySessionStore } from "../application/ports/catalog-safety-sessions";
import type { WorkerAuthorizationPort } from "../application/ports/worker-authorization";
import type { WorkoutRunRepository } from "../application/ports/workout-run-repository";
import { createClaimWorkoutRun } from "../application/use-cases/claim-workout-run";
import {
  createEvaluateCatalogSafety,
  type CatalogSafetyInjuryApplicability,
  type CatalogSafetyResolutionCertificateClaims,
  type CatalogSafetyResolutionPurpose,
  type CatalogSafetyResolvedMatch,
  type CatalogSafetyResolutionCertificateVerifier,
} from "../application/use-cases/evaluate-catalog-safety";
import {
  createExecuteWorkoutRun,
  type ExecuteWorkoutRunDependencies,
} from "../application/use-cases/execute-workout-run";
import { createRetrieveMemberContext } from "../application/use-cases/retrieve-member-context";
import { resolveMovementConcepts } from "../application/use-cases/resolve-movement-concepts";
import { createValidateWorkoutCandidates } from "../application/use-cases/validate-workout-candidates";
import { findMovementSubstitutes } from "../application/use-cases/find-movement-substitutes";
import type { WorkoutRunId } from "../domain/contracts/workout";
import type { ConceptMention, ConceptResolution } from "../domain/contracts/concept-resolution";
import type { MovementLaterality } from "../domain/contracts/movement-safety";
import type { WorkoutCompositionCandidate } from "../domain/policies/workout-composition";
import { DEFAULT_RESOLUTION_POLICY } from "../domain/policies/concept-resolution";
import { validateWorkoutAdjustment, type WorkoutAdjustment, type WorkoutClarificationField, type WorkoutClarificationFieldKey } from "../domain/contracts/workout-run";
import { MEMBER_CONTEXT_CYPHER } from "../graph/cypher/member-context";
import { MOVEMENT_CYPHER } from "../graph/cypher/movement";
import { canonicalWorkoutDigest } from "../graph/schema/workout-run-schema";
import { canonicalJson } from "../graph/revisions/movement-graph";
import { createWorkoutRunWorker, type WorkoutRunWorkerDependencies } from "../workers/workout-run-worker";
import {
  createConfiguredWorkoutServerInfrastructure,
  workoutRouteSecret,
  type WorkoutServerInfrastructure,
} from "./workout-route-composition";
import {
  aiApiKeyName,
  configuredAiApiKey,
  createConfiguredLanguageModel,
  resolveAiProvider,
  type AiProvider,
} from "./configured-language-model";
import { RAILWAY_DEMO_PROFILE, resolveDeploymentProfile } from "./deployment-profile";

type Environment = Readonly<Record<string, string | undefined>>;

export type ConfiguredWorkoutWorkerOptions = {
  readonly workerId: string;
  readonly modelId: string;
  readonly gatewayApiKey: string;
  readonly provider?: AiProvider;
  readonly providerApiKey?: string;
  readonly leaseDurationMs: number;
  readonly heartbeatEveryMs: number;
  readonly executionTimeoutMs: number;
  readonly providerTimeoutMs: number;
  readonly mode?: "provider" | "deterministic";
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
  const rawMode = environment.WORKOUT_DEMO_MODE?.trim();
  if (rawMode && rawMode !== "deterministic" && rawMode !== "provider") throw new Error("WORKOUT_DEMO_MODE is unsupported");
  const mode = rawMode === "deterministic" ? "deterministic" : "provider";
  const deploymentProfile = resolveDeploymentProfile(environment);
  if (runtimeEnvironment === "production" && mode === "deterministic" && deploymentProfile.name !== RAILWAY_DEMO_PROFILE) {
    throw new Error("WORKOUT_DEMO_MODE=deterministic is limited to the railway-demo profile in production");
  }
  workoutRouteSecret(runtimeEnvironment, environment.WORKOUT_ROUTE_SECRET);
  if (runtimeEnvironment === "production") {
    required(environment, "NEO4J_URI");
    required(environment, "NEO4J_USERNAME");
    required(environment, "NEO4J_PASSWORD");
    if (deploymentProfile.name === RAILWAY_DEMO_PROFILE) {
      required(environment, "NEO4J_PRIVATE_DOMAIN");
      if (!deploymentProfile.allowInsecureRailway) throw new Error("NEO4J_ALLOW_INSECURE_RAILWAY=1 is required for the Railway demo");
    }
  }
  const workerId = required(environment, "WORKOUT_WORKER_ID");
  const modelId = mode === "deterministic" ? environment.WORKOUT_MODEL_ID?.trim() || "demo:deterministic" : required(environment, "WORKOUT_MODEL_ID");
  const provider = resolveAiProvider(environment);
  const providerApiKey = mode === "deterministic"
    ? configuredAiApiKey(environment, provider) || "demo:no-provider-key"
    : required(environment, aiApiKeyName(provider));
  const gatewayApiKey = provider === "gateway" ? providerApiKey : "";
  const leaseDurationMs = positiveInteger(environment, "WORKOUT_LEASE_DURATION_MS", 60_000);
  const heartbeatEveryMs = positiveInteger(environment, "WORKOUT_HEARTBEAT_INTERVAL_MS", 15_000);
  const executionTimeoutMs = positiveInteger(environment, "WORKOUT_EXECUTION_TIMEOUT_MS", 45_000);
  const providerTimeoutMs = positiveInteger(environment, "WORKOUT_PROVIDER_TIMEOUT_MS", 15_000);
  if (heartbeatEveryMs >= leaseDurationMs) {
    throw new Error("WORKOUT_HEARTBEAT_INTERVAL_MS must be shorter than WORKOUT_LEASE_DURATION_MS");
  }
  return Object.freeze({ workerId, modelId, gatewayApiKey, provider, providerApiKey, leaseDurationMs, heartbeatEveryMs, executionTimeoutMs, providerTimeoutMs, mode });
}

export function createConfiguredWorkoutGatewayModel(options: Pick<ConfiguredWorkoutWorkerOptions, "gatewayApiKey" | "modelId">) {
  return createConfiguredLanguageModel({ provider: "gateway", apiKey: options.gatewayApiKey, modelId: options.modelId });
}

export function createConfiguredWorkoutModel(
  options: Pick<ConfiguredWorkoutWorkerOptions, "modelId"> & Partial<Pick<ConfiguredWorkoutWorkerOptions, "gatewayApiKey" | "provider" | "providerApiKey">>,
) {
  return createConfiguredLanguageModel({
    provider: options.provider ?? "gateway",
    apiKey: options.providerApiKey || options.gatewayApiKey,
    modelId: options.modelId,
  });
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
    async runNext(input?: { readonly signal?: AbortSignal }) {
      const claimNext = dependencies.repository.claimNext;
      if (!claimNext) return { status: "not-claimable" as const };
      const now = dependencies.now();
      const claimed = await claimNext.call(dependencies.repository, dependencies.workerId, now, new Date(Date.parse(now) + dependencies.leaseDurationMs).toISOString());
      if (claimed.status !== "claimed") return { status: "not-claimable" as const };
      return worker.runClaimed(claimed, input?.signal);
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

const CERTIFICATE_ISSUER = "workout-worker:canonical-resolution/v1";
const CERTIFICATE_TTL_MS = 5 * 60 * 1_000;

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

/**
 * An explicit exclusion may have low-scoring fuzzy suggestions even when the
 * pinned catalog contains no related exercise family.  Those suggestions are
 * not safe candidates to present as a clarification: below the resolver's
 * clarification floor they are an empty family search and must be attested as
 * such.  Higher-confidence suggestions remain fail-closed and require a
 * typed clarification instead.
 */
function isZeroMatchExclusion(
  resolution: ConceptResolution,
) {
  if (resolution.status === "resolved") return false;
  return resolution.reason === "no-candidate"
    || (resolution.reason === "below-threshold"
      && resolution.candidates.length > 0
      && resolution.candidates.every((candidate) => Math.max(candidate.fuzzyScore, candidate.vectorScore) < DEFAULT_RESOLUTION_POLICY.clarificationFloor));
}

type InjuryAnswer = {
  readonly conditionStatus?: string;
  readonly recoveryStage?: string;
  readonly severityBand?: string;
  readonly affectedLaterality?: MovementLaterality;
};

type ProtectedInputSpec = {
  readonly intent: readonly string[];
  readonly exclusions: readonly string[];
  readonly preferences: readonly string[];
  readonly injuryAnswers: Readonly<Record<string, InjuryAnswer>>;
  readonly adjustment?: WorkoutAdjustment;
};

function clarificationReference(runId: string, evidenceId: string): string {
  return `clarification:${canonicalWorkoutDigest(`${runId}:${evidenceId}`).slice("sha256:".length, "sha256:".length + 20)}`;
}

const promptStopWords = new Set(["a", "an", "and", "build", "for", "focused", "give", "make", "me", "minute", "minutes", "on", "please", "session", "the", "with", "workout"]);

function strings(value: unknown): readonly string[] | undefined {
  const values = typeof value === "string" ? [value] : value;
  return Array.isArray(values) && values.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 200)
    ? values.map((item) => item.trim())
    : undefined;
}

function parseStructuredInput(value: string): Partial<ProtectedInputSpec> | undefined {
  if (!value.trim().startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const input = parsed as Record<string, unknown>;
    const intent = input.intent === undefined ? undefined : strings(input.intent);
    const exclusions = input.exclude === undefined ? undefined : strings(input.exclude);
    const preferences = input.prefer === undefined ? undefined : strings(input.prefer);
    if ((input.intent !== undefined && !intent) || (input.exclude !== undefined && !exclusions)
      || (input.prefer !== undefined && !preferences)) return undefined;
    const adjustmentValue = input.adjustment === undefined ? undefined : validateWorkoutAdjustment(input.adjustment);
    if (input.adjustment !== undefined && adjustmentValue?.status !== "valid") return undefined;
    const injuryAnswers: Record<string, InjuryAnswer> = {};
    const answerPayloads = [input.injuries, input.clarification].filter((payload) => payload !== undefined);
    for (const payload of answerPayloads) {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
      for (const [evidenceId, raw] of Object.entries(payload as Record<string, unknown>)) {
        if (!evidenceId || !raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
        const fields = raw as Record<string, unknown>;
        const allowed = new Set(["conditionStatus", "recoveryStage", "severityBand", "affectedLaterality"]);
        if (Object.keys(fields).some((field) => !allowed.has(field))) return undefined;
        const answer: InjuryAnswer = {};
        for (const field of ["conditionStatus", "recoveryStage", "severityBand"] as const) {
          if (fields[field] !== undefined) {
            if (typeof fields[field] !== "string" || !fields[field].trim() || fields[field].length > 100) return undefined;
            Object.assign(answer, { [field]: fields[field].trim() });
          }
        }
        if (fields.affectedLaterality !== undefined) {
          if (!["left", "right", "bilateral", "unknown"].includes(String(fields.affectedLaterality))) return undefined;
          Object.assign(answer, { affectedLaterality: fields.affectedLaterality as MovementLaterality });
        }
        injuryAnswers[evidenceId] = answer;
      }
    }
    return {
      ...(intent ? { intent } : {}),
      ...(exclusions ? { exclusions } : {}),
      ...(preferences ? { preferences } : {}),
      injuryAnswers,
      ...(adjustmentValue?.status === "valid" ? { adjustment: adjustmentValue.value } : {}),
    };
  } catch {
    return undefined;
  }
}

function markedPhrases(input: string, marker: RegExp): readonly string[] {
  return [...input.matchAll(marker)].flatMap((match) => match[1]?.trim() ? [match[1].trim()] : []);
}

function intentPhrases(input: string): readonly string[] {
  const words = input.toLocaleLowerCase().replace(/[^a-z0-9 -]/g, " ").split(/\s+/).filter((word) => word && !promptStopWords.has(word));
  const phrases: string[] = [input.trim()];
  for (let width = Math.min(3, words.length); width >= 1 && phrases.length < 12; width -= 1) {
    for (let index = 0; index + width <= words.length && phrases.length < 12; index += 1) {
      phrases.push(words.slice(index, index + width).join(" "));
    }
  }
  return [...new Set(phrases.filter(Boolean))];
}

function parseProtectedInput(entries: readonly string[]): ProtectedInputSpec {
  const intent: string[] = [];
  const exclusions: string[] = [];
  const preferences: string[] = [];
  const injuryAnswers: Record<string, InjuryAnswer> = {};
  let adjustment: WorkoutAdjustment | undefined;
  for (const entry of entries) {
    const structured = parseStructuredInput(entry);
    if (structured) {
      intent.push(...(structured.intent ?? []));
      exclusions.push(...(structured.exclusions ?? []));
      preferences.push(...(structured.preferences ?? []));
      Object.assign(injuryAnswers, structured.injuryAnswers);
      if (structured.adjustment) adjustment = structured.adjustment;
      continue;
    }
    exclusions.push(...markedPhrases(entry, /(?:avoid|exclude|without|do not use|don't use)\s+([^,.;]+)/gi));
    preferences.push(...markedPhrases(entry, /(?:prefer|favor|favour)\s+([^,.;]+)/gi));
    intent.push(...intentPhrases(entry));
  }
  return {
    intent: [...new Set(intent)].slice(0, 12),
    exclusions: [...new Set(exclusions)].slice(0, 2),
    preferences: [...new Set(preferences)].slice(0, 2),
    injuryAnswers,
    ...(adjustment ? { adjustment } : {}),
  };
}

function createResolutionCertificateAuthority(secret: string, now: () => string) {
  const retained = new Map<string, CatalogSafetyResolutionCertificateClaims>();
  const issue = (purpose: CatalogSafetyResolutionPurpose, request: Omit<CatalogSafetyResolutionCertificateClaims, "certificateId" | "purpose" | "issuerId" | "policyRevision" | "issuedAt" | "expiresAt">) => {
    const issuedAt = now();
    const expiresAt = new Date(Date.parse(issuedAt) + CERTIFICATE_TTL_MS).toISOString();
    const body = { purpose, ...request, issuerId: CERTIFICATE_ISSUER, policyRevision: "canonical-resolution/v1", issuedAt, expiresAt };
    const certificateId = `resolution-certificate:${createHmac("sha256", secret).update(canonicalJson(body)).digest("base64url")}`;
    const claims: CatalogSafetyResolutionCertificateClaims = { certificateId, ...body };
    retained.set(certificateId, claims);
    return { certificateId } as const;
  };
  const verifier: CatalogSafetyResolutionCertificateVerifier = Object.freeze({
    trustedIssuerId: CERTIFICATE_ISSUER,
    async verify(request) {
      const claims = retained.get(request.certificateId);
      return claims && canonicalJson({
        certificateId: claims.certificateId,
        purpose: claims.purpose,
        runId: claims.runId,
        movementGraphRevisionId: claims.movementGraphRevisionId,
        payloadDigest: claims.payloadDigest,
        ...(claims.emptyResultAttestationId ? { emptyResultAttestationId: claims.emptyResultAttestationId } : {}),
      }) === canonicalJson(request) ? { status: "verified" as const, claims } : { status: "invalid" as const };
    },
  });
  return { issue, verifier };
}

function matchPayloadDigest(input: Omit<CatalogSafetyResolvedMatch, "resolution">) {
  return canonicalWorkoutDigest({
    conceptId: input.conceptId,
    conceptKind: input.conceptKind,
    evidenceId: input.evidenceId,
    zeroMatchAttested: input.zeroMatchAttested === true,
    emptyResultAttestationId: input.emptyResultAttestationId ?? null,
    rankPenalty: input.rankPenalty ?? null,
  });
}

function injuryPayloadDigest(input: Omit<CatalogSafetyInjuryApplicability, "resolution">) {
  return canonicalWorkoutDigest(input);
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
  const certificates = createResolutionCertificateAuthority(infrastructure.secret, now);
  const scoped = createScopedGrantAuthorizer(infrastructure.authorization);
  const retrieveMemberContext = createRetrieveMemberContext({
    memberContext: infrastructure.memberContext,
    authorizeMemberContext: scoped.authorizeMemberContext,
  });
  const resolveConstraints: ExecuteWorkoutRunDependencies["resolveConstraints"] = async ({ run, authorizationId }) => {
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
    const movement = await infrastructure.movement.openRevision(run.movementGraphRevisionId);
    if (movement.status !== "ready" || movement.handle.authority !== "canonical") {
      return { status: "failed", reason: "graph-unavailable" };
    }
    const catalog = await movement.handle.getCatalogExerciseFacts({ maxResults: 100 });
    if (catalog.status !== "ok") return { status: "failed", reason: "graph-unavailable" };
    const activeInput = run.inputRevisions.find((revision) => revision.inputRevisionId === run.activeInputRevisionId);
    if (!activeInput) return { status: "failed", reason: "insufficient-safety-context" };
    const protectedInput = infrastructure.protectedInput.read(activeInput.protectedPromptSnapshotId, {
      coachId: run.coachId,
      memberId: run.memberId,
      runId: run.runId,
    });
    if (protectedInput.status !== "ready") return { status: "failed", reason: "insufficient-safety-context" };
    const inputSpec = parseProtectedInput(protectedInput.entries);
    const adjustment = inputSpec.adjustment;

    const unresolvedEquipment = constraints.data.equipment.flatMap((equipment) => {
      const ids = reviewedReferences([equipment.domainReference]);
      return ids.length === 1 && ids[0]?.startsWith("equipment:")
        ? []
        : [`constraint:equipment:${equipment.evidenceId}:domain-reference`];
    });
    if (unresolvedEquipment.length > 0) {
      return { status: "clarification-required", candidateConceptIds: unresolvedEquipment };
    }

    const mentions: ConceptMention[] = [
      ...inputSpec.intent.map((text) => ({ text, role: "target" as const, safetyCritical: false })),
      ...(adjustment?.prompt ? [{ text: adjustment.prompt, role: "target" as const, safetyCritical: false }] : []),
      ...[...inputSpec.exclusions, ...(adjustment?.exclusions ?? [])].map((text) => ({ text, role: "exclusion" as const, safetyCritical: true })),
      ...inputSpec.preferences.map((text) => ({ text, role: "preference" as const, safetyCritical: false })),
    ].slice(0, 16);
    const promptResolution = mentions.length > 0
      ? await resolveMovementConcepts(infrastructure.movement, { mentions, graphRevisionId: run.movementGraphRevisionId })
      : { status: "resolved" as const, resolutions: [] };
    const hardResolutionFailure = promptResolution.resolutions.some((resolution) => resolution.status !== "resolved"
      && ["graph-unavailable", "non-authoritative", "invalid-input", "deprecated-mapping"].includes(resolution.reason));
    if (hardResolutionFailure) return { status: "failed", reason: "graph-unavailable" };
    const unresolvedExclusions = promptResolution.resolutions.filter((resolution) => resolution.mention.role === "exclusion"
      && (resolution.status !== "resolved"
        || !["exercise", "movement-pattern"].includes(resolution.conceptId.split(":", 1)[0]!)));
    const zeroMatchExclusions = unresolvedExclusions.filter((resolution) => isZeroMatchExclusion(resolution));
    if (unresolvedExclusions.length > zeroMatchExclusions.length) {
      return {
        status: "clarification-required",
        candidateConceptIds: unresolvedExclusions.filter((resolution) => !zeroMatchExclusions.includes(resolution)).flatMap((resolution) => resolution.status === "resolved"
          ? [`constraint:exclusion:${resolution.mention.text}`]
          : resolution.candidates.length > 0
            ? resolution.candidates.map((candidate) => candidate.conceptId)
            : [`constraint:exclusion:${resolution.mention.text}`]).slice(0, 25),
      };
    }

    const resolvedPrompt: Extract<ConceptResolution, { readonly status: "resolved" }>[] = [];
    for (const resolution of promptResolution.resolutions) {
      if (resolution.status === "resolved") resolvedPrompt.push(resolution);
    }
    const focusConceptIds = [...new Set(resolvedPrompt.filter((resolution) => resolution.mention.role === "target")
      .map((resolution) => resolution.conceptId))].sort();
    const promptEvidenceId = activeInput.protectedPromptSnapshotId;
    const makeMatch = (
      purpose: "explicit-exclusion" | "preference",
      conceptId: string,
      evidenceId: string,
      options: {
        readonly rankPenalty?: number;
        readonly emptyResultAttestationId?: string;
      } = {},
    ): CatalogSafetyResolvedMatch => {
      const zeroMatch = options.emptyResultAttestationId;
      const match = {
        conceptId: conceptId as CatalogSafetyResolvedMatch["conceptId"],
        conceptKind: conceptId.startsWith("exercise:") ? "exercise" as const : "movement-pattern" as const,
        evidenceId,
        ...(options.rankPenalty === undefined ? {} : { rankPenalty: options.rankPenalty }),
        ...(zeroMatch ? { zeroMatchAttested: true as const, emptyResultAttestationId: zeroMatch } : {}),
      };
      return {
        ...match,
        resolution: certificates.issue(purpose, {
          runId: run.runId,
          movementGraphRevisionId: run.movementGraphRevisionId,
          payloadDigest: matchPayloadDigest(match),
          maxDepth: 4,
          maxResults: 100,
          ...(zeroMatch ? { emptyResultAttestationId: zeroMatch } : {}),
        }),
      };
    };
    const explicitExclusions = [
      ...resolvedPrompt.filter((resolution) => resolution.mention.role === "exclusion")
        .map((resolution) => makeMatch("explicit-exclusion", resolution.conceptId, promptEvidenceId)),
      ...zeroMatchExclusions.map((resolution) => {
        const queryDigest = canonicalWorkoutDigest({ runId: run.runId, query: resolution.mention.text });
        return makeMatch(
          "explicit-exclusion",
          `movement-pattern:zero-match-${queryDigest.slice("sha256:".length)}`,
          promptEvidenceId,
          { emptyResultAttestationId: `empty-result:${queryDigest}` },
        );
      }),
    ];
    const promptPreferences = resolvedPrompt.filter((resolution) => resolution.mention.role === "preference"
      && (resolution.conceptId.startsWith("exercise:") || resolution.conceptId.startsWith("movement-pattern:")))
      .map((resolution) => makeMatch("preference", resolution.conceptId, promptEvidenceId, { rankPenalty: 1 }));
    const memberPreferences = constraints.data.preferences.flatMap((preference) => reviewedReferences(preference.domainReferences)
      .filter((conceptId) => conceptId.startsWith("exercise:") || conceptId.startsWith("movement-pattern:"))
      .map((conceptId) => makeMatch("preference", conceptId, preference.evidenceId, { rankPenalty: 1 })));

    const injuryApplicability: CatalogSafetyInjuryApplicability[] = [];
    const applicabilityAssertionIds: string[] = [];
    const clarificationFields: WorkoutClarificationField[] = [];
    const addClarificationField = (input: {
      readonly evidenceId: string;
      readonly key: WorkoutClarificationFieldKey;
      readonly label: string;
      readonly allowedValues: readonly string[];
    }) => {
      const reference = clarificationReference(run.runId, input.evidenceId);
      const id = `${reference}:${input.key}`;
      if (clarificationFields.some((field) => field.id === id)) return;
      const values = [...new Set(input.allowedValues.filter((value) => value.trim().length > 0))].slice(0, 32);
      if (values.length === 0) return;
      clarificationFields.push({
        id,
        key: input.key,
        label: input.label,
        allowedValues: values.map((value) => ({ value, label: value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) })),
        evidenceReference: reference,
      });
    };
    for (const injury of constraints.data.injuries) {
      const references = reviewedReferences(injury.domainReferences);
      const conditions = references.filter((id) => id.startsWith("condition:"));
      const anatomy = references.filter((id) => id.startsWith("joint:") || id.startsWith("body-region:"));
      if (conditions.length !== 1) addClarificationField({ evidenceId: injury.evidenceId, key: "conditionStatus", label: "Condition status", allowedValues: ["active", "recovering", "resolved"] });
      if (anatomy.length !== 1) addClarificationField({ evidenceId: injury.evidenceId, key: "affectedLaterality", label: "Affected side", allowedValues: ["left", "right", "bilateral", "unknown"] });
      if (conditions.length !== 1 || anatomy.length !== 1) continue;
      const rules = await movement.handle.getClinicalRuleFacts({ conditionConceptId: conditions[0]!, maxResults: 32 });
      if (rules.status !== "ok") return { status: "failed", reason: "graph-unavailable" };
      if (rules.data.length === 0) {
        addClarificationField({ evidenceId: injury.evidenceId, key: "conditionStatus", label: "Condition status", allowedValues: ["active", "recovering", "resolved"] });
        continue;
      }
      const answer = {
        ...inputSpec.injuryAnswers[injury.evidenceId],
        ...inputSpec.injuryAnswers[clarificationReference(run.runId, injury.evidenceId)],
        ...(adjustment?.injuryApplicability ?? {}),
      };
      const conditionStatus = answer.conditionStatus ?? injury.status.trim();
      const severityBand = answer.severityBand ?? injury.severity.trim();
      const recoveryStage = answer.recoveryStage;
      const affectedLaterality = answer.affectedLaterality;
      if (!conditionStatus || !rules.data.some((rule) => rule.applicability.conditionStatuses.includes(conditionStatus))) {
        addClarificationField({ evidenceId: injury.evidenceId, key: "conditionStatus", label: "Condition status", allowedValues: rules.data.flatMap((rule) => rule.applicability.conditionStatuses) });
      }
      if (!recoveryStage || !rules.data.some((rule) => rule.applicability.recoveryStages.includes(recoveryStage))) {
        addClarificationField({ evidenceId: injury.evidenceId, key: "recoveryStage", label: "Recovery stage", allowedValues: rules.data.flatMap((rule) => rule.applicability.recoveryStages) });
      }
      if (!severityBand || !rules.data.some((rule) => rule.applicability.severityBands.includes(severityBand))) {
        addClarificationField({ evidenceId: injury.evidenceId, key: "severityBand", label: "Severity", allowedValues: rules.data.flatMap((rule) => rule.applicability.severityBands) });
      }
      if (!affectedLaterality) addClarificationField({ evidenceId: injury.evidenceId, key: "affectedLaterality", label: "Affected side", allowedValues: ["left", "right", "bilateral", "unknown"] });
      const combinationVerified = Boolean(recoveryStage && affectedLaterality && rules.data.some((rule) => (
        rule.applicability.conditionStatuses.includes(conditionStatus)
        && rule.applicability.recoveryStages.includes(recoveryStage)
        && rule.applicability.severityBands.includes(severityBand)
      )));
      if (!combinationVerified) continue;
      const resolved = {
        memberEvidenceId: injury.evidenceId,
        conditionConceptId: conditions[0] as `condition:${string}`,
        affectedAnatomyConceptId: anatomy[0] as `joint:${string}` | `body-region:${string}`,
        conditionStatus,
        recoveryStage: recoveryStage!,
        severityBand,
        affectedLaterality: affectedLaterality!,
        evidenceId: injury.evidenceId,
      };
      injuryApplicability.push({
        ...resolved,
        resolution: certificates.issue("injury-applicability", {
          runId: run.runId,
          movementGraphRevisionId: run.movementGraphRevisionId,
          payloadDigest: injuryPayloadDigest(resolved),
          maxDepth: 4,
          maxResults: 100,
        }),
      });
      applicabilityAssertionIds.push(injury.assertionId, ...rules.data.map((rule) => rule.ruleAssertionId));
    }
    if (clarificationFields.length > 0) {
      const fields = clarificationFields.slice(0, 25);
      return {
        status: "clarification-required",
        candidateConceptIds: fields.map((field) => field.id),
        clarification: { schemaVersion: "workout-clarification/v1", fields },
      };
    }
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
      ...constraints.data.preferences.flatMap((preference) => reviewedReferences(preference.domainReferences)),
      ...focusConceptIds,
      ...explicitExclusions.map((match) => match.conceptId),
      ...promptPreferences.map((match) => match.conceptId),
      ...injuryApplicability.flatMap((injury) => [injury.conditionConceptId, injury.affectedAnatomyConceptId]),
    ])].sort();
    const evidenceIds = [...new Set([
      ...constraints.data.equipment.map(({ evidenceId }) => evidenceId),
      ...constraints.data.preferences.map(({ evidenceId }) => evidenceId),
      ...constraints.data.injuries.map(({ evidenceId }) => evidenceId),
      ...(explicitExclusions.length > 0 || promptPreferences.length > 0 ? [promptEvidenceId] : []),
    ])].sort();
    const snapshotBase = {
      schemaVersion: "resolved-constraint-snapshot/v1" as const,
      movementGraphRevisionId: run.movementGraphRevisionId,
      memberContextRevisionId: run.memberContextRevisionId,
      canonicalConstraintIds,
      applicabilityAssertionIds: [...new Set(applicabilityAssertionIds)].sort(),
      evidenceIds,
      zeroMatchCertificates: zeroMatchExclusions.map((resolution) => ({
        resolverId: "resolver:canonical-concept/v1",
        canonicalQuery: resolution.mention.text,
        searchPolicyVersion: "canonical-exact-reference/v1",
        maximumResults: 100,
        emptyResult: true as const,
        evidenceId: promptEvidenceId,
      })),
      resolverVersion: "canonical-protected-input/v1",
      searchPolicyVersion: "canonical-exact-reference/v1",
    };
    // Recompute from the active protected input. A snapshot from an earlier
    // clarification revision must never override the revised input.
    const snapshot = { ...snapshotBase, digest: canonicalWorkoutDigest(snapshotBase) };
    const memberEquipmentConceptIds = [...new Set(constraints.data.equipment.flatMap(({ domainReference }) => reviewedReferences([domainReference])
      .filter((conceptId) => conceptId.startsWith("equipment:"))))];
    const availableEquipmentConceptIds = adjustment?.equipment?.availableEquipmentConceptIds ?? memberEquipmentConceptIds;
    return {
      status: "ready",
      snapshot,
      canonicalIntent: {
        focusConceptIds,
        requestedDurationMinutes: run.requestedDurationMinutes,
      },
      injuryApplicability,
      explicitExclusions,
      preferences: [...memberPreferences, ...promptPreferences],
      ...(availableEquipmentConceptIds.length > 0 ? { availableEquipmentConceptIds } : {}),
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
    resolutionCertificates: certificates.verifier,
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
    findSubstitutes: (request) => findMovementSubstitutes(infrastructure.movement, request),
    validateCandidates,
    composer: options.mode === "deterministic"
      ? createDeterministicWorkoutComposer()
      : createAiSdkWorkoutComposer({ model: createConfiguredWorkoutModel(options), timeoutMs: options.providerTimeoutMs }),
    reviewer: options.mode === "deterministic"
      ? createDeterministicWorkoutReviewer()
      : createAiSdkWorkoutReviewer({ model: createConfiguredWorkoutModel(options), timeoutMs: options.providerTimeoutMs }),
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
