import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createAnswerWorkoutClarification } from "../application/use-cases/answer-workout-clarification";
import { createCancelWorkoutRun } from "../application/use-cases/cancel-workout-run";
import { createRetrieveMemberContext } from "../application/use-cases/retrieve-member-context";
import { createReplayWorkoutRunEvents, createRetrieveWorkoutRun } from "../application/use-cases/retrieve-workout-run";
import { createRetryWorkoutRun } from "../application/use-cases/retry-workout-run";
import { createSubmitWorkoutRun } from "../application/use-cases/submit-workout-run";
import type { WorkerAuthorizationPort } from "../application/ports/worker-authorization";
import { createNeo4jClient } from "../graph/neo4j/client";
import { createNeo4jMemberContextReadProvider } from "../graph/repositories/neo4j-member-context";
import { createNeo4jMovementGraphReadProvider } from "../graph/repositories/neo4j-movement-graph";
import { createNeo4jWorkoutRunRepository } from "../graph/repositories/neo4j-workout-runs";
import type { Neo4jClient } from "../graph/neo4j/client";
import type { MemberContextReadProvider } from "../domain/contracts/member-context-queries";
import type { MovementGraphReadProvider } from "../domain/contracts/movement-clinical-queries";
import type { WorkoutRunRepository } from "../application/ports/workout-run-repository";

type WorkoutRouteSession =
  | { readonly status: "authorized"; readonly coachId: string; readonly authorizationId: string }
  | { readonly status: "unauthorized" | "unavailable" };

export type WorkoutRouteComposition = {
  readonly resolveSession: (request: Request) => Promise<WorkoutRouteSession>;
  readonly submit: ReturnType<typeof createSubmitWorkoutRun>;
  readonly retrieve: ReturnType<typeof createRetrieveWorkoutRun>;
  readonly cancel: ReturnType<typeof createCancelWorkoutRun>;
  readonly replay: ReturnType<typeof createReplayWorkoutRunEvents>;
  readonly answer: ReturnType<typeof createAnswerWorkoutClarification>;
  readonly retry: ReturnType<typeof createRetryWorkoutRun>;
};

type SessionPayload = {
  readonly coachId: string;
  readonly memberIds: readonly string[];
  readonly expiresAt: string;
};

type GrantPayload = {
  readonly coachId: string;
  readonly memberId: string;
  readonly runId: string;
  readonly expiresAt: string;
};

const LOCAL_SECRET = "axon-local-workout-route-secret-change-before-production";
const SESSION_COOKIE = "axon_coach_session";
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

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return undefined; }
  }
  return undefined;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_ID_LENGTH;
}

function validSessionPayload(value: SessionPayload | undefined): value is SessionPayload {
  return Boolean(value
    && validId(value.coachId)
    && Array.isArray(value.memberIds)
    && value.memberIds.length > 0
    && value.memberIds.length <= 100
    && value.memberIds.every(validId)
    && Number.isFinite(Date.parse(value.expiresAt))
    && Date.parse(value.expiresAt) > Date.now());
}

function sessionAuthorization(secret: string, payload: SessionPayload): string {
  return `route-scope:${seal(secret, payload)}`;
}

function openSessionAuthorization(secret: string, authorizationId: string): SessionPayload | undefined {
  const prefix = "route-scope:";
  if (!authorizationId.startsWith(prefix)) return undefined;
  const payload = unseal<SessionPayload>(secret, authorizationId.slice(prefix.length));
  return validSessionPayload(payload) ? payload : undefined;
}

export function workoutRouteSecret(environment: string, configured?: string): string {
  const value = arguments.length > 1 ? configured : process.env.WORKOUT_ROUTE_SECRET;
  if (value && Buffer.byteLength(value) >= 32) return value;
  if (environment === "development" || environment === "test" || environment === "local") return LOCAL_SECRET;
  throw new Error("WORKOUT_ROUTE_SECRET must contain at least 32 bytes");
}

function createSessionResolver(secret: string, environment: string): WorkoutRouteComposition["resolveSession"] {
  return async (request) => {
    const token = cookie(request, SESSION_COOKIE);
    if (!token && (environment === "development" || environment === "test" || environment === "local")) {
      const coachId = process.env.WORKOUT_LOCAL_COACH_ID?.trim() || "coach:local";
      const memberIds = (process.env.WORKOUT_LOCAL_MEMBER_IDS ?? "mbr_01HX9JORDAN,mbr_02HX9AVERY,mbr_03HX9MORGAN")
        .split(",")
        .map((memberId) => memberId.trim())
        .filter(Boolean);
      const payload = {
        coachId,
        memberIds,
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1_000).toISOString(),
      };
      if (!validSessionPayload(payload)) return { status: "unavailable" };
      return {
        status: "authorized",
        coachId,
        authorizationId: sessionAuthorization(secret, payload),
      };
    }
    if (!token) return { status: "unauthorized" };
    const payload = unseal<SessionPayload>(secret, token);
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
  readonly movement: MovementGraphReadProvider;
  readonly memberContext: MemberContextReadProvider;
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
  return Object.freeze({
    environment,
    secret,
    client,
    repository: createNeo4jWorkoutRunRepository(client, { cursorSecret: secret }),
    authorization: createWorkoutGrantAuthorization(secret),
    movement: createNeo4jMovementGraphReadProvider(client),
    memberContext: createNeo4jMemberContextReadProvider(client),
  });
}

export function createConfiguredWorkoutRouteComposition(): WorkoutRouteComposition {
  const { environment, secret, repository, authorization, movement, memberContext } = createConfiguredWorkoutServerInfrastructure(process.env);
  const retrieveMemberContext = createRetrieveMemberContext({
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
  const protectPrompt = async (input: { readonly coachId: string; readonly memberId: string; readonly runId: string; readonly prompt: string; readonly provisioningKey?: string }) => ({
    status: "stored" as const,
    protectedPromptSnapshotId: `protected-prompt:${createHmac("sha256", secret)
      .update(JSON.stringify([input.coachId, input.memberId, input.runId, input.provisioningKey ?? "clarification", input.prompt]))
      .digest("base64url")}`,
  });

  return Object.freeze({
    resolveSession: createSessionResolver(secret, environment),
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
    retrieve: createRetrieveWorkoutRun({ repository, authorization }),
    cancel: createCancelWorkoutRun({ repository, authorization, now }),
    replay: createReplayWorkoutRunEvents({ repository, authorization }),
    answer: createAnswerWorkoutClarification({ repository, authorization, protectPrompt, createId, now }),
    retry: createRetryWorkoutRun({ repository, authorization, createId, now, modelConfigurationId, policyRevision }),
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
};
