import { describe, expect, it, vi } from "vitest";
import {
  CATALOG_SAFETY_MAX_ACTIVE_SESSIONS_PER_SCOPE,
  InMemoryCatalogSafetySessionStore,
  type CatalogSafetySessionRecord,
} from "../../src/application/ports/catalog-safety-sessions";
import { createInvalidateCatalogSafetySession } from "../../src/application/use-cases/invalidate-catalog-safety-session";
import {
  createValidateWorkoutCandidates,
  type WorkoutCandidateValidationBinding,
} from "../../src/application/use-cases/validate-workout-candidates";
import {
  CATALOG_SAFETY_MAX_EXERCISES,
  type CatalogSafetyDecision,
  type CatalogSafetyReadyResult,
} from "../../src/domain/contracts/catalog-safety";

const NOW = "2026-08-06T12:00:00.000Z";
const LATER = "2026-08-06T12:11:00.000Z";

function decision(exerciseConceptId: string, classification: CatalogSafetyDecision["classification"]): CatalogSafetyDecision {
  return {
    movementGraphRevisionId: "movement:1",
    memberContextRevisionId: "member:1",
    exerciseConceptId,
    exerciseAssertionId: `assertion:${exerciseConceptId}`,
    classification,
    loadedLaterality: "unknown",
    preferenceRank: 0,
    contributions: [],
    assertionIds: [`assertion:${exerciseConceptId}`],
    evidenceIds: [],
  };
}

function readyResult(customDecisions?: readonly CatalogSafetyDecision[]): CatalogSafetyReadyResult {
  const decisions = customDecisions ?? [decision("exercise:allowed", "allowed"), decision("exercise:excluded", "excluded")];
  return {
    status: "ready",
    movementGraphRevisionId: "movement:1",
    memberContextRevisionId: "member:1",
    authority: "canonical",
    decisions,
    excluded: decisions.filter((item) => item.classification === "excluded"),
    caution: [],
    downranked: [],
    allowed: decisions.filter((item) => item.classification === "allowed"),
    assertionIds: decisions.flatMap((item) => item.assertionIds),
    evidenceIds: [],
  };
}

function record(index = 0, overrides: Partial<CatalogSafetySessionRecord> = {}): CatalogSafetySessionRecord {
  return {
    token: `token:${index}`,
    evaluationSessionId: `evaluation-session:${index}`,
    runId: `run:${index}`,
    claims: { coachId: "coach:1", memberId: "member:1", authorizationId: "grant:1" },
    movementGraphRevisionId: "movement:1",
    memberContextRevisionId: "member:1",
    constraintDigest: `sha256:${index}`,
    result: readyResult(),
    createdAt: NOW,
    expiresAt: "2026-08-06T12:10:00.000Z",
    ...overrides,
  };
}

function validationRequest(overrides: Record<string, unknown> = {}) {
  return {
    coachId: "coach:1",
    memberId: "member:1",
    authorizationId: "grant:1",
    evaluationToken: "token:0",
    exerciseConceptIds: ["exercise:allowed"],
    ...overrides,
  };
}

function trustedBinding(overrides: Partial<WorkoutCandidateValidationBinding> = {}): WorkoutCandidateValidationBinding {
  return {
    runId: "run:0",
    expectedEvaluationSessionId: "evaluation-session:0",
    movementGraphRevisionId: "movement:1",
    memberContextRevisionId: "member:1",
    constraintDigest: "sha256:0",
    ...overrides,
  };
}

describe("catalog safety application boundary", () => {
  it("validates only candidates from the exact retained result and rejects widening", async () => {
    const sessions = new InMemoryCatalogSafetySessionStore();
    sessions.retain(record(), NOW);
    const audit = vi.fn(async () => undefined);
    const validate = createValidateWorkoutCandidates({
      sessions,
      authorizeMemberContext: () => true,
      now: () => NOW,
      securityAudit: { record: audit },
      trustedBinding: trustedBinding(),
    });

    await expect(validate(validationRequest())).resolves.toMatchObject({
      status: "accepted",
      decisions: [{ exerciseConceptId: "exercise:allowed" }],
    });
    await expect(validate(validationRequest({
      exerciseConceptIds: ["exercise:allowed", "exercise:allowed", "exercise:excluded", "exercise:unknown"],
    }))).resolves.toEqual({
      status: "violations",
      accepted: [expect.objectContaining({ exerciseConceptId: "exercise:allowed" })],
      violations: [
        { candidateIndex: 1, exerciseConceptId: "exercise:allowed", reasonCode: "duplicate-candidate" },
        { candidateIndex: 2, exerciseConceptId: "exercise:excluded", reasonCode: "excluded-candidate" },
        { candidateIndex: 3, reasonCode: "unknown-candidate" },
      ],
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    ["runId", { runId: "run:other" }],
    ["evaluation session", { expectedEvaluationSessionId: "evaluation-session:other" }],
    ["movement revision", { movementGraphRevisionId: "movement:other" }],
    ["member revision", { memberContextRevisionId: "member:other" }],
    ["constraint digest", { constraintDigest: "sha256:other" }],
  ] as const)("rejects a trusted %s binding mismatch without exposing decisions", async (_label, mismatch) => {
    const sessions = new InMemoryCatalogSafetySessionStore();
    sessions.retain(record(), NOW);
    const audit = vi.fn(async () => undefined);
    const validate = createValidateWorkoutCandidates({
      sessions,
      authorizeMemberContext: () => true,
      now: () => NOW,
      securityAudit: { record: audit },
      trustedBinding: trustedBinding(mismatch),
    });

    const result = await validate(validationRequest({
      expectedEvaluationSessionId: "evaluation-session:0",
      movementGraphRevisionId: "movement:1",
      memberContextRevisionId: "member:1",
      constraintDigest: "sha256:0",
      runId: "run:0",
    }));
    expect(result).toEqual({ status: "evaluation-unavailable", reasonCode: "evaluation-binding-mismatch" });
    expect(result).not.toHaveProperty("decisions");
    expect(audit).toHaveBeenCalledOnce();
    expect(JSON.stringify(audit.mock.calls)).not.toContain("exercise:allowed");
  });

  it("invalidates on revoked authorization and explicit completion with one redacted event", async () => {
    const sessions = new InMemoryCatalogSafetySessionStore();
    sessions.retain(record(), NOW);
    const audit = vi.fn(async () => undefined);
    const validate = createValidateWorkoutCandidates({
      sessions,
      authorizeMemberContext: () => false,
      now: () => NOW,
      securityAudit: { record: audit },
      trustedBinding: trustedBinding(),
    });
    await expect(validate(validationRequest())).resolves.toEqual({ status: "denied", reasonCode: "authorization-denied" });
    expect(sessions.lookup("token:0", NOW)).toEqual({ status: "absent" });
    expect(audit).toHaveBeenCalledOnce();

    sessions.retain(record(1), NOW);
    audit.mockClear();
    const invalidate = createInvalidateCatalogSafetySession({
      sessions,
      authorizeMemberContext: () => true,
      now: () => NOW,
      securityAudit: { record: audit },
    });
    await expect(invalidate({
      coachId: "coach:1",
      memberId: "member:1",
      authorizationId: "grant:1",
      evaluationToken: "token:1",
      expectedEvaluationSessionId: "evaluation-session:1",
    })).resolves.toEqual({ status: "invalidated", evaluationSessionId: "evaluation-session:1" });
    expect(sessions.lookup("token:1", NOW)).toEqual({ status: "absent" });
    expect(audit).toHaveBeenCalledOnce();
  });

  it("redacts unknown and malformed candidate values, including duplicates", async () => {
    const sessions = new InMemoryCatalogSafetySessionStore();
    sessions.retain(record(), NOW);
    const validate = createValidateWorkoutCandidates({
      sessions,
      authorizeMemberContext: () => true,
      now: () => NOW,
      securityAudit: { record: vi.fn(async () => undefined) },
      trustedBinding: trustedBinding(),
    });
    const secret = "raw prompt injury value";

    const result = await validate(validationRequest({
      exerciseConceptIds: [secret, secret, { arbitrary: secret }],
    }));

    expect(result).toEqual({
      status: "violations",
      accepted: [],
      violations: [
        { candidateIndex: 0, reasonCode: "unknown-candidate" },
        { candidateIndex: 1, reasonCode: "duplicate-candidate" },
        { candidateIndex: 2, reasonCode: "unknown-candidate" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("accepts 100 candidates and rejects 0 or 101 before candidate iteration with a redacted audit", async () => {
    const catalog = Array.from({ length: CATALOG_SAFETY_MAX_EXERCISES }, (_, index) => (
      decision(`exercise:${index}`, "allowed")
    ));
    const sessions = new InMemoryCatalogSafetySessionStore();
    sessions.retain(record(0, { result: readyResult(catalog) }), NOW);
    const audit = vi.fn(async () => undefined);
    const validate = createValidateWorkoutCandidates({
      sessions,
      authorizeMemberContext: () => true,
      now: () => NOW,
      securityAudit: { record: audit },
      trustedBinding: trustedBinding(),
    });

    await expect(validate(validationRequest({
      exerciseConceptIds: catalog.map((item) => item.exerciseConceptId),
    }))).resolves.toMatchObject({ status: "accepted", decisions: { length: 100 } });
    expect(audit).not.toHaveBeenCalled();

    for (const exerciseConceptIds of [[], [...catalog.map((item) => item.exerciseConceptId), "raw secret overflow"]]) {
      audit.mockClear();
      const result = await validate(validationRequest({ exerciseConceptIds }));
      expect(result).toEqual({
        status: "violations",
        accepted: [],
        violations: [{ reasonCode: "invalid-candidate-count" }],
      });
      expect(audit).toHaveBeenCalledOnce();
      expect(JSON.stringify([result, audit.mock.calls])).not.toContain("raw secret overflow");
    }
  });

  it("expires sessions, supersedes the same run, and rejects capacity without eviction", () => {
    const sessions = new InMemoryCatalogSafetySessionStore();
    sessions.retain(record(), NOW);
    expect(sessions.lookup("token:0", LATER)).toEqual({ status: "expired" });

    sessions.retain(record(1, { runId: "run:same" }), NOW);
    const replacement = sessions.retain(record(2, { runId: "run:same" }), NOW);
    expect(replacement).toMatchObject({ status: "stored", superseded: [{ token: "token:1" }] });
    expect(sessions.lookup("token:1", NOW)).toEqual({ status: "absent" });

    const capped = new InMemoryCatalogSafetySessionStore();
    for (let index = 0; index < CATALOG_SAFETY_MAX_ACTIVE_SESSIONS_PER_SCOPE; index += 1) {
      expect(capped.retain(record(index), NOW).status).toBe("stored");
    }
    expect(capped.retain(record(999), NOW)).toEqual({ status: "capacity" });
    expect(capped.lookup("token:0", NOW).status).toBe("found");
    expect(capped.retain(record(1_000, {
      claims: { coachId: "coach:2", memberId: "member:2", authorizationId: "grant:2" },
    }), NOW).status).toBe("stored");
  });

  it("keeps retention and supersession isolated across many coach/member scopes", () => {
    const sessions = new InMemoryCatalogSafetySessionStore();
    const unrelated = Array.from({ length: 40 }, (_, index) => record(index, {
      token: `token:scope:${index}`,
      runId: `run:scope:${index}`,
      claims: {
        coachId: `coach:${index}`,
        memberId: `member:${index}`,
        authorizationId: `grant:${index}`,
      },
    }));
    for (const scopedRecord of unrelated) {
      expect(sessions.retain(scopedRecord, NOW).status).toBe("stored");
    }

    const original = record(100, { runId: "run:replace" });
    const replacement = record(101, { runId: "run:replace" });
    expect(sessions.retain(original, NOW).status).toBe("stored");
    expect(sessions.retain(replacement, NOW)).toMatchObject({
      status: "stored",
      superseded: [{ token: original.token }],
    });
    expect(sessions.lookup(original.token, NOW)).toEqual({ status: "absent" });
    expect(sessions.lookup(replacement.token, NOW).status).toBe("found");
    for (const scopedRecord of unrelated) {
      expect(sessions.lookup(scopedRecord.token, NOW).status).toBe("found");
    }
  });

  it("keeps the scope index consistent after expiry, invalidation, and supersession", () => {
    const sessions = new InMemoryCatalogSafetySessionStore();
    const expired = record(200, { expiresAt: "2026-08-06T11:59:00.000Z" });
    expect(sessions.retain(expired, "2026-08-06T11:58:00.000Z").status).toBe("stored");
    expect(sessions.retain(record(201), NOW).status).toBe("stored");
    expect(sessions.lookup(expired.token, NOW)).toEqual({ status: "absent" });

    expect(sessions.invalidate("token:201")?.token).toBe("token:201");
    expect(sessions.lookup("token:201", NOW)).toEqual({ status: "absent" });

    expect(sessions.retain(record(202, { runId: "run:same" }), NOW).status).toBe("stored");
    expect(sessions.retain(record(203, { runId: "run:same" }), NOW)).toMatchObject({
      status: "stored",
      superseded: [{ token: "token:202" }],
    });
    expect(sessions.lookup("token:202", NOW)).toEqual({ status: "absent" });

    for (let index = 0; index < CATALOG_SAFETY_MAX_ACTIVE_SESSIONS_PER_SCOPE - 1; index += 1) {
      expect(sessions.retain(record(300 + index), NOW).status).toBe("stored");
    }
    expect(sessions.retain(record(999), NOW)).toEqual({ status: "capacity" });
    expect(sessions.invalidate("token:203")?.token).toBe("token:203");
    expect(sessions.retain(record(999), NOW).status).toBe("stored");
  });

  it("treats invalid current and expiry timestamps as expired and unavailable", () => {
    const sessions = new InMemoryCatalogSafetySessionStore();
    expect(sessions.retain(record(400), NOW).status).toBe("stored");
    expect(sessions.lookup("token:400", "not-a-timestamp")).toEqual({ status: "expired" });
    expect(sessions.lookup("token:400", NOW)).toEqual({ status: "absent" });

    expect(sessions.retain(record(401, { expiresAt: "not-a-timestamp" }), NOW).status).toBe("stored");
    expect(sessions.lookup("token:401", NOW)).toEqual({ status: "expired" });
    expect(sessions.lookup("token:401", NOW)).toEqual({ status: "absent" });

    expect(sessions.retain(record(402, { expiresAt: "not-a-timestamp" }), NOW).status).toBe("stored");
    expect(sessions.retain(record(403), NOW).status).toBe("stored");
    expect(sessions.lookup("token:402", NOW)).toEqual({ status: "absent" });
    expect(sessions.lookup("token:403", NOW).status).toBe("found");
  });
});
