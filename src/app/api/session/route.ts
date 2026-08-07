import {
  DEFAULT_MOCK_COACH_ID,
  DEFAULT_MOCK_MEMBER_IDS,
  MOCK_COACH_SESSION_COOKIE,
  MOCK_COACH_SESSION_TTL_MS,
  mockCoachSessionClaims,
  parseMockCoachSession,
  readMockCoachSessionCookie,
  sealMockCoachSession,
} from "../../../server/auth/mock-coach-session";
import { workoutRouteSecret } from "../../../server/workout-route-composition";

const MAX_BODY_BYTES = 4_096;
const noStoreHeaders = {
  "cache-control": "private, no-store, max-age=0",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
  vary: "cookie",
} as const;

function environment() {
  return process.env.NODE_ENV ?? "production";
}

function secret() {
  return workoutRouteSecret(environment(), process.env.WORKOUT_ROUTE_SECRET);
}

function response(value: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { ...noStoreHeaders, ...extra } });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}

function secureCookie(request: Request) {
  try {
    const url = new URL(request.url);
    const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    return !localHttp;
  } catch { return true; }
}

function cookieHeader(request: Request, token: string, maxAge: number) {
  return `${MOCK_COACH_SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secureCookie(request) ? "; Secure" : ""}`;
}

function clearCookie(request: Request) {
  return `${MOCK_COACH_SESSION_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax${secureCookie(request) ? "; Secure" : ""}`;
}

function roster() {
  const memberIds = (process.env.WORKOUT_LOCAL_MEMBER_IDS ?? DEFAULT_MOCK_MEMBER_IDS.join(","))
    .split(",").map((memberId) => memberId.trim()).filter(Boolean);
  return {
    coachId: process.env.WORKOUT_LOCAL_COACH_ID?.trim() || DEFAULT_MOCK_COACH_ID,
    memberIds,
  };
}

async function readBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const bytes = Number(contentLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_BODY_BYTES) return undefined;
  }
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return undefined;
    const value: unknown = text ? JSON.parse(text) : {};
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function currentSession(request: Request) {
  const token = readMockCoachSessionCookie(request);
  let claims = token ? parseMockCoachSession(secret(), token) : undefined;
  if (!claims && !token && process.env.WORKOUT_TEST_BYPASS === "1" && environment() !== "production") {
    const configured = roster();
    claims = mockCoachSessionClaims({
      now: new Date().toISOString(),
      sessionId: "mock-session:test-bypass",
      coachId: configured.coachId,
      memberIds: configured.memberIds,
      ttlMs: MOCK_COACH_SESSION_TTL_MS,
    });
  }
  return claims && Date.parse(claims.expiresAt) > Date.now() ? claims : undefined;
}

export async function GET(request: Request) {
  const claims = currentSession(request);
  return claims
    ? response({ status: "authenticated", coachId: claims.coachId, memberIds: claims.memberIds, expiresAt: claims.expiresAt })
    : response({ status: "signed_out" });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return response({ status: "forbidden" }, 403);
  const body = await readBody(request);
  if (!body || Object.keys(body).some((key) => key !== "coachId")
    || (body.coachId !== undefined && typeof body.coachId !== "string")) {
    return response({ status: "invalid" }, 400);
  }
  const configured = roster();
  if (body.coachId !== undefined && body.coachId !== configured.coachId) return response({ status: "denied" }, 404);
  const now = new Date().toISOString();
  const claims = mockCoachSessionClaims({
    now,
    coachId: configured.coachId,
    memberIds: configured.memberIds,
    ttlMs: MOCK_COACH_SESSION_TTL_MS,
  });
  if (!claims) return response({ status: "unavailable" }, 503);
  return response(
    { status: "authenticated", coachId: claims.coachId, memberIds: claims.memberIds, expiresAt: claims.expiresAt },
    200,
    { "set-cookie": cookieHeader(request, sealMockCoachSession(secret(), claims), Math.floor(MOCK_COACH_SESSION_TTL_MS / 1_000)) },
  );
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return response({ status: "forbidden" }, 403);
  return response({ status: "signed_out" }, 200, { "set-cookie": clearCookie(request) });
}
