import { describe, expect, it, vi } from "vitest";
import {
  CATALOG_SAFETY_MAX_ACTIVE_SESSIONS_PER_SCOPE,
  InMemoryCatalogSafetySessionStore,
  type CatalogSafetySessionRecord,
} from "../../src/application/ports/catalog-safety-sessions";
import { createInvalidateCatalogSafetySession } from "../../src/application/use-cases/invalidate-catalog-safety-session";
import { createValidateWorkoutCandidates } from "../../src/application/use-cases/validate-workout-candidates";
import type { CatalogSafetyDecision, CatalogSafetyReadyResult } from "../../src/domain/contracts/catalog-safety";

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

function readyResult(): CatalogSafetyReadyResult {
  const decisions = [decision("exercise:allowed", "allowed"), decision("exercise:excluded", "excluded")];
  return {
    status: "ready",
    movementGraphRevisionId: "movement:1",
    memberContextRevisionId: "member:1",
    authority: "canonical",
    decisions,
    excluded: [decisions[1]!],
    caution: [],
    downranked: [],
    allowed: [decisions[0]!],
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
    expectedEvaluationSessionId: "evaluation-session:0",
    movementGraphRevisionId: "movement:1",
    memberContextRevisionId: "member:1",
    constraintDigest: "sha256:0",
    exerciseConceptIds: ["exercise:allowed"],
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
        { exerciseConceptId: "exercise:allowed", reasonCode: "duplicate-candidate" },
        { exerciseConceptId: "exercise:excluded", reasonCode: "excluded-candidate" },
        { exerciseConceptId: "exercise:unknown", reasonCode: "unknown-candidate" },
      ],
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it("rejects a token swap without exposing decisions and audits exactly once", async () => {
    const sessions = new InMemoryCatalogSafetySessionStore();
    sessions.retain(record(), NOW);
    const audit = vi.fn(async () => undefined);
    const validate = createValidateWorkoutCandidates({
      sessions,
      authorizeMemberContext: () => true,
      now: () => NOW,
      securityAudit: { record: audit },
    });

    const result = await validate(validationRequest({ expectedEvaluationSessionId: "evaluation-session:other" }));
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
});
