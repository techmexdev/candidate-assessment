import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createAnswerWorkoutClarification } from "../application/use-cases/answer-workout-clarification";
import { createCancelWorkoutRun } from "../application/use-cases/cancel-workout-run";
import { createRetrieveMemberContext } from "../application/use-cases/retrieve-member-context";
import { createRetrieveFullGraph, type RetrieveFullGraph } from "../application/use-cases/retrieve-full-graph";
import { createReplayWorkoutRunEvents, createRetrieveWorkoutRun } from "../application/use-cases/retrieve-workout-run";
import { createRetryWorkoutRun } from "../application/use-cases/retry-workout-run";
import { createSubmitWorkoutRun } from "../application/use-cases/submit-workout-run";
import { createSubmitWorkoutAdjustment } from "../application/use-cases/submit-workout-adjustment";
import { createRetrieveMemberConversation, type RetrieveMemberConversationResult } from "../application/use-cases/retrieve-member-conversation";
import { createVerifyHistoricalWorkoutTrace } from "../application/use-cases/verify-historical-workout-trace";
import type { WorkerAuthorizationPort } from "../application/ports/worker-authorization";
import { createNeo4jClient } from "../graph/neo4j/client";
import { createNeo4jMemberContextReadProvider } from "../graph/repositories/neo4j-member-context";
import { createNeo4jMovementGraphReadProvider } from "../graph/repositories/neo4j-movement-graph";
import { createNeo4jWorkoutRunRepository } from "../graph/repositories/neo4j-workout-runs";
import type { Neo4jClient } from "../graph/neo4j/client";
import type { MemberContextFullReadProvider } from "../domain/contracts/full-graph-view";
import type { MovementGraphFullReadProvider } from "../domain/contracts/full-graph-view";
import type { WorkoutRunRepository } from "../application/ports/workout-run-repository";
import { MEMBER_CONTEXT_CYPHER } from "../graph/cypher/member-context";
import { MOVEMENT_CYPHER } from "../graph/cypher/movement";
import { MEMBER_CONTEXT_QUERY_MAXIMA } from "../graph/repositories/member-context";
import { MOVEMENT_GRAPH_QUERY_LIMITS } from "../graph/schema/movement-schema";
import type { WorkoutRevisionSealArtifact } from "../domain/contracts/workout-run";
import { createProtectedWorkoutInputVault } from "./workout-protected-input";
import { SYNTHETIC_MEMBER_ASSET_ALLOWLIST } from "./member-context-assets";
import {
  DEFAULT_MOCK_COACH_ID,
  DEFAULT_MOCK_MEMBER_IDS,
  MOCK_COACH_SESSION_TTL_MS,
  mockCoachSessionClaims,
  parseMockCoachSession,
  readMockCoachSessionCookie,
  sealMockCoachSession,
  type MockCoachSessionClaims,
} from "./auth/mock-coach-session";

type WorkoutRouteSession =
  | { readonly status: "authorized"; readonly coachId: string; readonly authorizationId: string }
  | { readonly status: "unauthorized" | "unavailable" };

export type WorkoutRouteComposition = {
  readonly resolveSession: (request: Request) => Promise<WorkoutRouteSession>;
  readonly submit: ReturnType<typeof createSubmitWorkoutRun>;
  readonly adjust?: ReturnType<typeof createSubmitWorkoutAdjustment>;
  readonly conversation?: (input: {
    readonly coachId: string;
    readonly memberId: string;
    readonly sessionAuthorizationId: string;
    readonly contextRevisionId?: string;
    readonly conversationId?: string;
    readonly fromInclusive: string;
    readonly toExclusive: string;
    readonly cursor?: string;
  }) => Promise<RetrieveMemberConversationResult>;
  readonly retrieve: ReturnType<typeof createRetrieveWorkoutRun>;
  readonly cancel: ReturnType<typeof createCancelWorkoutRun>;
  readonly replay: ReturnType<typeof createReplayWorkoutRunEvents>;
  readonly answer: ReturnType<typeof createAnswerWorkoutClarification>;
  readonly retry: ReturnType<typeof createRetryWorkoutRun>;
  /** Optional for existing route test doubles; present in production composition. */
  readonly fullGraph?: RetrieveFullGraph;
};

type GrantPayload = {
  readonly coachId: string;
  readonly memberId: string;
  readonly runId: string;
  readonly expiresAt: string;
};

const LOCAL_SECRET = "axon-local-workout-route-secret-change-before-production";
const MAX_ID_LENGTH = 200;

function signature(secret: string, encoded: string): Buffer {
  return createHmac("sha256", secret).update(encoded).digest();
}

function seal(secret: string, payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signature(secret, encoded).toString("base64url")}`;
}

function unseal<Payload extends object>(secret: string, token: string): Payload | undefined {
  const [encoded, supplied, extra] = token.split(".");
  if (!encoded || !supplied || extra || encoded.length > 2_000 || supplied.length > 200) return undefined;
  let received: Buffer;
  try { received = Buffer.from(supplied, "base64url"); } catch { return undefined; }
  const expected = signature(secret, encoded);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Payload : undefined;
  } catch { return undefined; }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_ID_LENGTH;
}

function validSessionPayload(value: MockCoachSessionClaims | undefined, now = Date.now()): value is MockCoachSessionClaims {
  return Boolean(value
    && validId(value.coachId)
    && validId(value.sessionId)
    && Array.isArray(value.memberIds)
    && value.memberIds.length > 0
    && value.memberIds.length <= 100
    && value.memberIds.every(validId)
    && Number.isFinite(Date.parse(value.issuedAt))
    && Number.isFinite(Date.parse(value.expiresAt))
    && Date.parse(value.issuedAt) < Date.parse(value.expiresAt)
    && Date.parse(value.expiresAt) > now);
}

function sessionAuthorization(secret: string, payload: MockCoachSessionClaims): string {
  return `route-scope:${sealMockCoachSession(secret, payload)}`;
}

function openSessionAuthorization(secret: string, authorizationId: string): MockCoachSessionClaims | undefined {
  const prefix = "route-scope:";
  if (!authorizationId.startsWith(prefix)) return undefined;
  const payload = parseMockCoachSession(secret, authorizationId.slice(prefix.length));
  return validSessionPayload(payload) ? payload : undefined;
}

export function workoutRouteSecret(environment: string, configured?: string): string {
  const value = arguments.length > 1 ? configured : process.env.WORKOUT_ROUTE_SECRET;
  if (value && Buffer.byteLength(value) >= 32) return value;
  if (environment === "development" || environment === "test" || environment === "local") return LOCAL_SECRET;
  throw new Error("WORKOUT_ROUTE_SECRET must contain at least 32 bytes");
}

function createSessionResolver(secret: string, environment: string, testBypass = false): WorkoutRouteComposition["resolveSession"] {
  return async (request) => {
    const token = readMockCoachSessionCookie(request);
    let payload = token ? parseMockCoachSession(secret, token) : undefined;
    if (!payload && testBypass && environment !== "production" && !token) {
      payload = mockCoachSessionClaims({
        now: new Date().toISOString(),
        sessionId: "mock-session:test-bypass",
        coachId: process.env.WORKOUT_LOCAL_COACH_ID?.trim() || DEFAULT_MOCK_COACH_ID,
        memberIds: (process.env.WORKOUT_LOCAL_MEMBER_IDS ?? DEFAULT_MOCK_MEMBER_IDS.join(",")).split(",").map((memberId) => memberId.trim()).filter(Boolean),
        ttlMs: MOCK_COACH_SESSION_TTL_MS,
      });
    }
    if (!validSessionPayload(payload)) return { status: "unauthorized" };
    return {
      status: "authorized",
      coachId: payload.coachId,
      authorizationId: sessionAuthorization(secret, payload),
    };
  };
}

export function createWorkoutGrantAuthorization(secret: string): WorkerAuthorizationPort {
  const lifetimeMs = 24 * 60 * 60 * 1_000;
  return {
    async authorizeSession(input) {
      const session = openSessionAuthorization(secret, input.sessionAuthorizationId);
      return session && session.coachId === input.coachId && session.memberIds.includes(input.memberId)
        ? { status: "authorized", authorizationId: `session:${createHmac("sha256", secret).update(input.sessionAuthorizationId).digest("base64url")}` }
        : { status: "denied" };
    },
    async createReference(input) {
      const session = openSessionAuthorization(secret, input.sessionAuthorizationId);
      const provisionedAt = Date.parse(input.provisionedAt);
      if (!validId(input.coachId) || !validId(input.memberId) || !validId(input.runId)
        || !validId(input.provisioningKey) || !Number.isFinite(provisionedAt)
        || !session || session.coachId !== input.coachId || !session.memberIds.includes(input.memberId)) return { status: "denied" };
      return {
        status: "authorized",
        authorizationReferenceId: seal(secret, {
          coachId: input.coachId,
          memberId: input.memberId,
          runId: input.runId,
          expiresAt: new Date(Math.min(Date.parse(session.expiresAt), provisionedAt + lifetimeMs)).toISOString(),
        } satisfies GrantPayload),
      };
    },
    async authorize(input) {
      const payload = unseal<GrantPayload>(secret, input.authorizationReferenceId);
      return payload
        && payload.coachId === input.coachId
        && payload.memberId === input.memberId
        && payload.runId === input.runId
        && Number.isFinite(Date.parse(payload.expiresAt))
        && Date.parse(payload.expiresAt) > Date.now()
        ? { status: "authorized", authorizationId: `grant:${createHmac("sha256", secret).update(input.authorizationReferenceId).digest("base64url")}` }
        : { status: "denied" };
    },
  };
}

export type WorkoutServerInfrastructure = {
  readonly environment: string;
  readonly secret: string;
  readonly client: Neo4jClient;
  readonly repository: WorkoutRunRepository;
  readonly authorization: WorkerAuthorizationPort;
  readonly movement: MovementGraphFullReadProvider;
  readonly memberContext: MemberContextFullReadProvider;
  readonly protectedInput: ReturnType<typeof createProtectedWorkoutInputVault>;
};

/** Shared server-only infrastructure used by both HTTP routes and the detached worker. */
export function createConfiguredWorkoutServerInfrastructure(
  configuredEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): WorkoutServerInfrastructure {
  const environment = configuredEnvironment.NODE_ENV ?? "production";
  const secret = workoutRouteSecret(environment, configuredEnvironment.WORKOUT_ROUTE_SECRET);
  const client = createNeo4jClient({
    environment,
    ...(configuredEnvironment.NEO4J_URI ? { uri: configuredEnvironment.NEO4J_URI } : {}),
    ...(configuredEnvironment.NEO4J_USERNAME ? { username: configuredEnvironment.NEO4J_USERNAME } : {}),
    ...(configuredEnvironment.NEO4J_PASSWORD ? { password: configuredEnvironment.NEO4J_PASSWORD } : {}),
    ...(configuredEnvironment.NEO4J_DATABASE ? { database: configuredEnvironment.NEO4J_DATABASE } : {}),
  });
  const protectedInput = createProtectedWorkoutInputVault(secret);
  return Object.freeze({
    environment,
    secret,
    client,
    repository: createNeo4jWorkoutRunRepository(client, { cursorSecret: secret }),
    authorization: createWorkoutGrantAuthorization(secret),
    movement: createNeo4jMovementGraphReadProvider(client),
    memberContext: createNeo4jMemberContextReadProvider(client),
    protectedInput,
  });
}

export function createConfiguredWorkoutRouteComposition(): WorkoutRouteComposition {
  const configuredEnvironment = process.env;
  const { environment, secret, client, repository, authorization, movement, memberContext, protectedInput } = createConfiguredWorkoutServerInfrastructure(configuredEnvironment);
  const retrieveMemberContext = createRetrieveMemberContext({
    memberContext,
    authorizeMemberContext: ({ coachId, memberId, authorizationId }) => {
      const session = openSessionAuthorization(secret, authorizationId);
      return Boolean(session && session.coachId === coachId && session.memberIds.includes(memberId));
    },
  });
  const retrieveFullGraph = createRetrieveFullGraph({
    movement,
    memberContext,
    authorizeMemberContext: ({ coachId, memberId, authorizationId }) => {
      const session = openSessionAuthorization(secret, authorizationId);
      return Boolean(session && session.coachId === coachId && session.memberIds.includes(memberId));
    },
  });
  const now = () => new Date().toISOString();
  const createId = (kind: string) => `${kind}:${randomUUID()}`;
  const modelConfigurationId = process.env.WORKOUT_MODEL_CONFIGURATION_ID?.trim() || "workout-composer:v1";
  const policyRevision = process.env.WORKOUT_POLICY_REVISION?.trim() || "workout-composition/v1";
  const protectPrompt = async (input: {
    readonly coachId: string;
    readonly memberId: string;
    readonly runId: string;
    readonly prompt: string;
    readonly previousProtectedPromptSnapshotId?: string;
  }) => protectedInput.protect(input);
  const verifyHistoricalTrace = createVerifyHistoricalWorkoutTrace({
    async readCanonicalTraceEvidence(input) {
      const uniqueAssertions = [...new Set(input.assertionIds)].sort();
      const uniqueEvidence = [...new Set(input.evidenceIds)].sort();
      const chunks = <Value>(values: readonly Value[], size: number): readonly (readonly Value[])[] => {
        const pages: Value[][] = [];
        for (let index = 0; index < values.length; index += size) pages.push(values.slice(index, index + size));
        return pages;
      };
      try {
        const [movementRevision, memberRevision, revisionSeals] = await Promise.all([
          movement.openRevision(input.movementGraphRevisionId),
          retrieveMemberContext({
            coachId: input.coachId,
            memberId: input.memberId,
            authorizationId: input.sessionAuthorizationId,
            contextRevisionId: input.memberContextRevisionId,
          }),
          client.executeRead(async (transaction): Promise<WorkoutRevisionSealArtifact | undefined> => {
            const movementSeal = (await transaction.run(MOVEMENT_CYPHER.readSealedRevision, {
              revisionId: input.movementGraphRevisionId,
            })).records[0];
            const memberSeal = (await transaction.run(MEMBER_CONTEXT_CYPHER.readSealedRevision, {
              memberId: input.memberId,
              contextRevisionId: input.memberContextRevisionId,
            })).records[0];
            const movementGraphSealId = movementSeal?.get("sealId");
            const movementGraphSealDigest = movementSeal?.get("canonicalDigest");
            const memberContextSealId = memberSeal?.get("sealId");
            const memberContextSealDigest = memberSeal?.get("canonicalDigest");
            if (![movementGraphSealId, movementGraphSealDigest, memberContextSealId, memberContextSealDigest]
              .every((value) => typeof value === "string" && value.length > 0)) return undefined;
            return {
              schemaVersion: "workout-revision-seals/v1",
              movementGraphRevisionId: input.movementGraphRevisionId,
              movementGraphSealId: movementGraphSealId as string,
              movementGraphSealDigest: movementGraphSealDigest as string,
              memberContextRevisionId: input.memberContextRevisionId,
              memberContextSealId: memberContextSealId as string,
              memberContextSealDigest: memberContextSealDigest as string,
            };
          }),
        ]);
        if (movementRevision.status !== "ready" || memberRevision.status !== "ready" || !revisionSeals) return { status: "unavailable" };

        const memberCitations: { evidenceId: string; assertionId: string }[] = [];
        for (const page of chunks(uniqueEvidence, MEMBER_CONTEXT_QUERY_MAXIMA.evidenceIds)) {
          const citations = await memberRevision.handle.getCitations({
            evidenceIds: page,
            limit: page.length,
            timeoutMs: MEMBER_CONTEXT_QUERY_MAXIMA.timeoutMs,
          });
          if (citations.status !== "ready" || citations.data.length !== page.length) return { status: "unavailable" };
          memberCitations.push(...citations.data.map(({ evidenceId, assertionId }) => ({ evidenceId, assertionId })));
        }

        const memberAssertionIds = new Set(memberCitations.map((citation) => citation.assertionId));
        const requestedMovementAssertions = uniqueAssertions.filter((assertionId) => !memberAssertionIds.has(assertionId));
        const movementAssertionIds: string[] = [];
        for (const page of chunks(requestedMovementAssertions, MOVEMENT_GRAPH_QUERY_LIMITS.maxResults)) {
          const assertions = await movementRevision.handle.getAssertions({ assertionIds: page, maxResults: page.length });
          if (assertions.status !== "ok" || assertions.data.length !== page.length) return { status: "unavailable" };
          movementAssertionIds.push(...assertions.data.map((assertion) => assertion.assertionId));
        }
        return { status: "ready", revisionSeals, movementAssertionIds, memberCitations };
      } catch {
        return { status: "unavailable" };
      }
    },
  });

  return Object.freeze({
    resolveSession: createSessionResolver(secret, environment, configuredEnvironment.WORKOUT_TEST_BYPASS === "1"),
    submit: createSubmitWorkoutRun({
      repository,
      authorization,
      async pinRevisions(input) {
        const [movementRevision, memberRevision] = await Promise.all([
          movement.openActive(),
          retrieveMemberContext({
            coachId: input.coachId,
            memberId: input.memberId,
            authorizationId: input.sessionAuthorizationId,
          }),
        ]);
        if (memberRevision.status === "denied") return { status: "denied" };
        if (movementRevision.status !== "ready" || memberRevision.status !== "ready") return { status: "unavailable" };
        return {
          status: "ready",
          movementGraphRevisionId: movementRevision.handle.graphRevisionId,
          memberContextRevisionId: memberRevision.handle.contextRevisionId,
        };
      },
      protectPrompt,
      createId,
      now,
      modelConfigurationId,
      policyRevision,
    }),
    adjust: createSubmitWorkoutAdjustment({
      repository,
      authorization,
      protectPrompt,
      createId,
      now,
      modelConfigurationId,
      policyRevision,
    }),
    conversation: createRetrieveMemberConversation({
      retrieveMemberContext,
      assetAllowlist: SYNTHETIC_MEMBER_ASSET_ALLOWLIST,
    }),
    retrieve: createRetrieveWorkoutRun({ repository, authorization, verifyHistoricalTrace }),
    cancel: createCancelWorkoutRun({ repository, authorization, now }),
    replay: createReplayWorkoutRunEvents({ repository, authorization }),
    answer: createAnswerWorkoutClarification({ repository, authorization, protectPrompt, createId, now }),
    retry: createRetryWorkoutRun({ repository, authorization, createId, now, modelConfigurationId, policyRevision }),
    fullGraph: retrieveFullGraph,
  });
}

let configured: WorkoutRouteComposition | undefined;
let testingOverride: WorkoutRouteComposition | undefined;

function composition(): WorkoutRouteComposition {
  if (testingOverride) return testingOverride;
  configured ??= createConfiguredWorkoutRouteComposition();
  return configured;
}

/** Test-only replacement for exercising the real Next.js route exports. */
export function installWorkoutRouteCompositionForTesting(value: WorkoutRouteComposition | undefined): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Workout route composition overrides are test-only");
  testingOverride = value;
  if (!value) configured = undefined;
}

export const configuredWorkoutRouteComposition: WorkoutRouteComposition = {
  resolveSession: async (request) => {
    try { return await composition().resolveSession(request); } catch { return { status: "unavailable" }; }
  },
  submit: async (input) => {
    try { return await composition().submit(input); } catch { return { status: "canonical-state-unavailable" }; }
  },
  adjust: async (input) => {
    try { return await composition().adjust!(input); } catch { return { status: "canonical-state-unavailable" }; }
  },
  conversation: async (input) => {
    try {
      return await composition().conversation!(input);
    } catch {
      return { status: "unavailable", message: "Member context is unavailable." };
    }
  },
  retrieve: async (input) => {
    try { return await composition().retrieve(input); } catch { return { status: "integrity-failure" }; }
  },
  cancel: async (input) => {
    try { return await composition().cancel(input); } catch { return { status: "not-found" }; }
  },
  replay: async (input) => {
    try { return await composition().replay(input); } catch { return { status: "not-found" }; }
  },
  answer: async (input) => {
    try { return await composition().answer(input); } catch { return { status: "unavailable" }; }
  },
  retry: async (input) => {
    try { return await composition().retry(input); } catch { return { status: "not-found" }; }
  },
  fullGraph: {
    readMovement: async (input) => {
      try {
        const fullGraph = composition().fullGraph;
        return fullGraph
          ? await fullGraph.readMovement(input)
          : { status: "unavailable", domain: "movement-clinical", message: "Movement graph is unavailable." };
      } catch {
        return { status: "unavailable", domain: "movement-clinical", message: "Movement graph is unavailable." };
      }
    },
    readMemberContext: async (input) => {
      try {
        const fullGraph = composition().fullGraph;
        return fullGraph
          ? await fullGraph.readMemberContext(input)
          : { status: "unavailable", domain: "member-context", message: "Member context is unavailable." };
      } catch {
        return { status: "unavailable", domain: "member-context", message: "Member context is unavailable." };
      }
    },
  },
};
