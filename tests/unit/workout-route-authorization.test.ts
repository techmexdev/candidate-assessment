import { describe, expect, it } from "vitest";
import { asWorkoutRunId } from "../../src/domain/contracts/workout";
import { mockCoachSessionClaims, sealMockCoachSession } from "../../src/server/auth/mock-coach-session";
import { createWorkoutGrantAuthorization } from "../../src/server/workout-route-composition";

const SECRET = "unit-test-workout-route-secret-32-bytes-minimum";

function routeScope(memberIds: readonly string[], expiresAt = new Date(Date.now() + 60_000).toISOString()) {
  const expiresTimestamp = Date.parse(expiresAt);
  const now = new Date(Math.min(Date.now(), expiresTimestamp - 1_000)).toISOString();
  const claims = mockCoachSessionClaims({
    now,
    coachId: "coach:one",
    sessionId: `session:test:${expiresTimestamp}`,
    memberIds,
    ttlMs: expiresTimestamp - Date.parse(now),
  });
  if (!claims) throw new Error("session claims missing");
  return `route-scope:${sealMockCoachSession(SECRET, claims)}`;
}

describe("workout route current-session authorization", () => {
  it("revalidates current member scope independently from the historical durable grant", async () => {
    const authorization = createWorkoutGrantAuthorization(SECRET);
    const runId = asWorkoutRunId("workout-run:one");
    const initialSession = routeScope(["member:one"]);
    const grant = await authorization.createReference({
      coachId: "coach:one",
      memberId: "member:one",
      runId,
      sessionAuthorizationId: initialSession,
      provisioningKey: "workout-run-creation:one",
      provisionedAt: new Date().toISOString(),
    });
    if (grant.status !== "authorized") throw new Error("grant missing");

    await expect(authorization.authorize({
      authorizationReferenceId: grant.authorizationReferenceId,
      coachId: "coach:one",
      memberId: "member:one",
      runId,
      stage: "read",
    })).resolves.toMatchObject({ status: "authorized" });
    await expect(authorization.authorizeSession({
      sessionAuthorizationId: routeScope(["member:two"]),
      coachId: "coach:one",
      memberId: "member:one",
      stage: "read",
    })).resolves.toEqual({ status: "denied" });
    await expect(authorization.authorizeSession({
      sessionAuthorizationId: routeScope(["member:one"]),
      coachId: "coach:one",
      memberId: "member:one",
      stage: "read",
    })).resolves.toMatchObject({ status: "authorized" });
    await expect(authorization.authorizeSession({
      sessionAuthorizationId: routeScope(["member:one"], new Date(Date.now() - 1_000).toISOString()),
      coachId: "coach:one",
      memberId: "member:one",
      stage: "read",
    })).resolves.toEqual({ status: "denied" });
  });
});
