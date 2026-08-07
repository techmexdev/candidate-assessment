import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const MOCK_COACH_SESSION_COOKIE = "axon_coach_session";
export const MOCK_COACH_SESSION_SCHEMA = "mock-coach-session/v1" as const;
export const MOCK_COACH_SESSION_TTL_MS = 30 * 60 * 1_000;
export const DEFAULT_MOCK_COACH_ID = "coach_01HXSAM";
export const DEFAULT_MOCK_MEMBER_IDS = Object.freeze([
  "mbr_01HX9JORDAN",
  "mbr_02HX9AVERY",
  "mbr_03HX9MORGAN",
] as const);

export type MockCoachSessionClaims = {
  readonly schemaVersion: typeof MOCK_COACH_SESSION_SCHEMA;
  readonly sessionId: string;
  readonly coachId: string;
  readonly memberIds: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
};

export type MockCoachSession =
  | {
      readonly status: "authorized";
      readonly coachId: string;
      readonly authorizationId: string;
      readonly entitledMemberIds: readonly string[];
    }
  | { readonly status: "unauthorized" | "unavailable" };

const MAX_SESSION_TOKEN_LENGTH = 4_096;

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 200;
}

function signature(secret: string, encoded: string): Buffer {
  return createHmac("sha256", secret).update(encoded).digest();
}

export function sealMockCoachSession(secret: string, claims: MockCoachSessionClaims): string {
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${signature(secret, encoded).toString("base64url")}`;
}

export function parseMockCoachSession(secret: string, value: string): MockCoachSessionClaims | undefined {
  if (value.length > MAX_SESSION_TOKEN_LENGTH) return undefined;
  const [encoded, supplied, extra] = value.split(".");
  if (!encoded || !supplied || extra) return undefined;
  let received: Buffer;
  try { received = Buffer.from(supplied, "base64url"); } catch { return undefined; }
  const expected = signature(secret, encoded);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const claims = parsed as Partial<MockCoachSessionClaims>;
    if (claims.schemaVersion !== MOCK_COACH_SESSION_SCHEMA
      || !boundedId(claims.sessionId)
      || !boundedId(claims.coachId)
      || !Array.isArray(claims.memberIds)
      || claims.memberIds.length === 0
      || claims.memberIds.length > 100
      || !claims.memberIds.every(boundedId)
      || new Set(claims.memberIds).size !== claims.memberIds.length
      || typeof claims.issuedAt !== "string"
      || typeof claims.expiresAt !== "string"
      || !Number.isFinite(Date.parse(claims.issuedAt))
      || !Number.isFinite(Date.parse(claims.expiresAt))
      || Date.parse(claims.issuedAt) >= Date.parse(claims.expiresAt)) return undefined;
    return claims as MockCoachSessionClaims;
  } catch { return undefined; }
}

export function readMockCoachSessionCookie(request: Request): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== MOCK_COACH_SESSION_COOKIE) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return undefined; }
  }
  return undefined;
}

export function mockCoachSessionClaims(input: {
  readonly coachId?: string;
  readonly memberIds?: readonly string[];
  readonly now: string;
  readonly ttlMs?: number;
  readonly sessionId?: string;
}): MockCoachSessionClaims | undefined {
  const ttlMs = input.ttlMs ?? MOCK_COACH_SESSION_TTL_MS;
  const expiresAt = new Date(Date.parse(input.now) + ttlMs).toISOString();
  const claims: MockCoachSessionClaims = {
    schemaVersion: MOCK_COACH_SESSION_SCHEMA,
    sessionId: input.sessionId ?? `mock-session:${randomUUID()}`,
    coachId: input.coachId ?? DEFAULT_MOCK_COACH_ID,
    memberIds: Object.freeze([...(input.memberIds ?? DEFAULT_MOCK_MEMBER_IDS)]),
    issuedAt: input.now,
    expiresAt,
  };
  return parseMockCoachSession("validation-only-secret-ignored", sealMockCoachSession("validation-only-secret-ignored", claims))
    ? claims
    : undefined;
}

function isLocalEnvironment(environment: string) {
  return ["development", "test", "local"].includes(environment);
}

/** Synthetic take-home session authority. Local bypass is explicit and test-only. */
export function createMockCoachSessionAuthority(options: {
  readonly secret: string;
  readonly environment: string;
  readonly now?: () => string;
  readonly localCoachId?: string;
  readonly localMemberIds?: readonly string[];
  readonly testBypass?: boolean;
}) {
  if (Buffer.byteLength(options.secret) < 32) throw new Error("Mock coach session secret must contain at least 32 bytes");
  const now = options.now ?? (() => new Date().toISOString());
  const allowTestBypass = options.testBypass === true && isLocalEnvironment(options.environment) && options.environment !== "production";

  const openAuthorization = (authorizationId: string): MockCoachSessionClaims | undefined => {
    const prefix = "copilot-scope:";
    if (!authorizationId.startsWith(prefix)) return undefined;
    const claims = parseMockCoachSession(options.secret, authorizationId.slice(prefix.length));
    return claims && Date.parse(claims.expiresAt) > Date.parse(now()) ? claims : undefined;
  };

  return Object.freeze({
    async resolveSession(request: Request): Promise<MockCoachSession> {
      const token = readMockCoachSessionCookie(request);
      let claims = token ? parseMockCoachSession(options.secret, token) : undefined;
      if (!claims && allowTestBypass && !token) {
        claims = mockCoachSessionClaims({
          now: now(),
          sessionId: "mock-session:test-bypass",
          coachId: options.localCoachId,
          memberIds: options.localMemberIds,
        });
      }
      if (!claims || Date.parse(claims.expiresAt) <= Date.parse(now())) return { status: "unauthorized" };
      return {
        status: "authorized",
        coachId: claims.coachId,
        authorizationId: `copilot-scope:${sealMockCoachSession(options.secret, claims)}`,
        entitledMemberIds: Object.freeze([...claims.memberIds]),
      };
    },
    authorize(input: Readonly<{ coachId: string; memberId: string; authorizationId: string }>): boolean {
      const claims = openAuthorization(input.authorizationId);
      return Boolean(claims
        && claims.coachId === input.coachId
        && claims.memberIds.includes(input.memberId));
    },
  });
}

