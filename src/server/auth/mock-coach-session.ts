import { createHmac, timingSafeEqual } from "node:crypto";

export type MockCoachSession =
  | {
      readonly status: "authorized";
      readonly coachId: string;
      readonly authorizationId: string;
      readonly entitledMemberIds: readonly string[];
    }
  | { readonly status: "unauthorized" | "unavailable" };

type SessionClaims = {
  readonly schemaVersion: "mock-coach-session/v1";
  readonly coachId: string;
  readonly memberIds: readonly string[];
  readonly expiresAt: string;
};

const SESSION_COOKIE = "axon_copilot_session";
const MAX_SESSION_TOKEN_LENGTH = 4_096;

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 200;
}

function signature(secret: string, encoded: string): Buffer {
  return createHmac("sha256", secret).update(encoded).digest();
}

function seal(secret: string, claims: SessionClaims): string {
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${signature(secret, encoded).toString("base64url")}`;
}

function unseal(secret: string, value: string): SessionClaims | undefined {
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
    const claims = parsed as Partial<SessionClaims>;
    if (claims.schemaVersion !== "mock-coach-session/v1"
      || !boundedId(claims.coachId)
      || !Array.isArray(claims.memberIds)
      || claims.memberIds.length === 0
      || claims.memberIds.length > 100
      || !claims.memberIds.every(boundedId)
      || new Set(claims.memberIds).size !== claims.memberIds.length
      || typeof claims.expiresAt !== "string"
      || !Number.isFinite(Date.parse(claims.expiresAt))) return undefined;
    return claims as SessionClaims;
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

/** Synthetic take-home session authority. The browser never supplies trusted coach or grant claims. */
export function createMockCoachSessionAuthority(options: {
  readonly secret: string;
  readonly environment: string;
  readonly now?: () => string;
  readonly localCoachId?: string;
  readonly localMemberIds?: readonly string[];
}) {
  if (Buffer.byteLength(options.secret) < 32) throw new Error("Mock coach session secret must contain at least 32 bytes");
  const now = options.now ?? (() => new Date().toISOString());
  const isLocal = ["development", "test", "local"].includes(options.environment);

  const openAuthorization = (authorizationId: string): SessionClaims | undefined => {
    const prefix = "copilot-scope:";
    if (!authorizationId.startsWith(prefix)) return undefined;
    const claims = unseal(options.secret, authorizationId.slice(prefix.length));
    return claims && Date.parse(claims.expiresAt) > Date.parse(now()) ? claims : undefined;
  };

  return Object.freeze({
    async resolveSession(request: Request): Promise<MockCoachSession> {
      let claims = cookie(request, SESSION_COOKIE)
        ? unseal(options.secret, cookie(request, SESSION_COOKIE)!)
        : undefined;
      if (!claims && isLocal && !cookie(request, SESSION_COOKIE)) {
        const memberIds = options.localMemberIds ?? [
          "mbr_01HX9JORDAN",
          "mbr_02HX9AVERY",
          "mbr_03HX9MORGAN",
        ];
        const candidate: SessionClaims = {
          schemaVersion: "mock-coach-session/v1",
          coachId: options.localCoachId ?? "coach_01HXSAM",
          memberIds,
          expiresAt: new Date(Date.parse(now()) + 8 * 60 * 60 * 1_000).toISOString(),
        };
        claims = memberIds.length > 0 && memberIds.length <= 100 && memberIds.every(boundedId)
          ? candidate
          : undefined;
      }
      if (!claims || Date.parse(claims.expiresAt) <= Date.parse(now())) return { status: "unauthorized" };
      return {
        status: "authorized",
        coachId: claims.coachId,
        authorizationId: `copilot-scope:${seal(options.secret, claims)}`,
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
