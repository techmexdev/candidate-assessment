import { afterEach, describe, expect, it } from "vitest";
import { DELETE, GET, POST } from "../../src/app/api/session/route";
import { createMockCoachSessionAuthority, parseMockCoachSession, readMockCoachSessionCookie, sealMockCoachSession, mockCoachSessionClaims } from "../../src/server/auth/mock-coach-session";

const environment = process.env as Record<string, string | undefined>;
const previousNodeEnvironment = environment.NODE_ENV;
const previousSecret = environment.WORKOUT_ROUTE_SECRET;

afterEach(() => {
  if (previousNodeEnvironment === undefined) delete environment.NODE_ENV;
  else environment.NODE_ENV = previousNodeEnvironment;
  if (previousSecret === undefined) delete environment.WORKOUT_ROUTE_SECRET;
  else environment.WORKOUT_ROUTE_SECRET = previousSecret;
});

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://axon.test${path}`, {
    ...init,
    headers: { origin: "https://axon.test", ...init.headers },
  });
}

describe("explicit mock coach session", () => {
  it("rotates an HttpOnly same-origin cookie and recovers the current session", async () => {
    environment.NODE_ENV = "test";
    const signedIn = await POST(request("/api/session", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.get("set-cookie");
    expect(cookie).toMatch(/axon_coach_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/Max-Age=1800/);
    const token = cookie!.split(";")[0]!.split("=").slice(1).join("=");
    expect(parseMockCoachSession("axon-local-workout-route-secret-change-before-production", decodeURIComponent(token))).toMatchObject({ coachId: "coach_01HXSAM" });

    const current = await GET(request("/api/session", { headers: { cookie: cookie!.split(";")[0]! } }));
    expect(await current.json()).toMatchObject({ status: "authenticated", coachId: "coach_01HXSAM" });

    const signedOut = await DELETE(request("/api/session", { method: "DELETE" }));
    expect(signedOut.status).toBe(200);
    expect(signedOut.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect(signedOut.headers.get("set-cookie")).toMatch(/HttpOnly/i);
  });

  it("uses one non-enumerating signed-out result for missing or tampered cookies", async () => {
    environment.NODE_ENV = "test";
    const missing = await GET(request("/api/session"));
    const tampered = await GET(request("/api/session", { headers: { cookie: "axon_coach_session=tampered" } }));
    expect(await missing.json()).toEqual({ status: "signed_out" });
    expect(await tampered.json()).toEqual({ status: "signed_out" });
  });

  it("requires same-origin mutation and keeps test bypass explicit and production-inert", async () => {
    environment.NODE_ENV = "test";
    expect((await POST(new Request("https://axon.test/api/session", { method: "POST", body: "{}" }))).status).toBe(403);
    const secret = "mock-session-authority-secret-with-more-than-32-bytes";
    const noBypass = createMockCoachSessionAuthority({ secret, environment: "development" });
    expect(await noBypass.resolveSession(new Request("http://localhost/api"))).toEqual({ status: "unauthorized" });
    const bypass = createMockCoachSessionAuthority({ secret, environment: "development", testBypass: true });
    expect(await bypass.resolveSession(new Request("http://localhost/api"))).toMatchObject({ status: "authorized" });
    const production = createMockCoachSessionAuthority({ secret, environment: "production", testBypass: true });
    expect(await production.resolveSession(new Request("https://axon.test/api"))).toEqual({ status: "unauthorized" });
  });

  it("does not trust a browser-supplied coach roster", () => {
    const secret = "mock-session-authority-secret-with-more-than-32-bytes";
    const now = new Date().toISOString();
    const claims = mockCoachSessionClaims({ now, coachId: "coach:one", memberIds: ["member:one"] });
    expect(claims).toBeDefined();
    const token = sealMockCoachSession(secret, claims!);
    const authority = createMockCoachSessionAuthority({ secret, environment: "production", now: () => now });
    const cookie = readMockCoachSessionCookie(new Request("https://axon.test/api", { headers: { cookie: `axon_coach_session=${token}` } }));
    expect(cookie).toBe(token);
    return expect(authority.resolveSession(new Request("https://axon.test/api", { headers: { cookie: `axon_coach_session=${token}` } }))).resolves.toMatchObject({ coachId: "coach:one", entitledMemberIds: ["member:one"] });
  });
});
