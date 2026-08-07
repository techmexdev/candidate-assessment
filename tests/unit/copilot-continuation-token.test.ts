import { describe, expect, it } from "vitest";
import type { CopilotContinuationClaims } from "../../src/domain/contracts/copilot";
import {
  COPILOT_CONTINUATION_MAX_TTL_MS,
  copilotContinuationSecret,
  createCopilotContinuationAuthority,
} from "../../src/server/copilot/continuation-token";

const SECRET = "unit-test-copilot-continuation-secret-32-bytes";
const NOW = "2026-08-07T10:00:00.000Z";

function claims(overrides: Partial<CopilotContinuationClaims> = {}): CopilotContinuationClaims {
  return {
    schemaVersion: "copilot-continuation-claims/v1",
    coachId: "coach:casey",
    memberId: "mbr_01HX9JORDAN",
    contextRevisionId: `member-context:sha256:${"a".repeat(64)}`,
    answerId: "answer:one",
    intentId: "adherence",
    selectedEvidenceIds: ["assertion:one", "assertion:two"],
    issuedAt: NOW,
    expiresAt: new Date(Date.parse(NOW) + COPILOT_CONTINUATION_MAX_TTL_MS).toISOString(),
    ...overrides,
  };
}

describe("Copilot continuation token authority", () => {
  it("round-trips the exact bounded claims with a versioned HMAC", async () => {
    const authority = createCopilotContinuationAuthority({ secret: SECRET, now: () => NOW });
    const token = await authority.sign(claims());

    await expect(authority.verify(token)).resolves.toEqual(claims());
    expect(token).toMatchObject({
      schemaVersion: "signed-copilot-continuation/v1",
      algorithm: "hmac-sha256",
    });
    expect(Object.keys(token.claims).sort()).toEqual([
      "answerId", "coachId", "contextRevisionId", "expiresAt", "intentId", "issuedAt",
      "memberId", "schemaVersion", "selectedEvidenceIds",
    ].sort());
    expect(JSON.stringify(token)).not.toMatch(/question|prompt|message|biomarker|lab|answerText/i);
  });

  it("rejects tampering, expiry, unknown versions, and excessive lifetimes", async () => {
    const authority = createCopilotContinuationAuthority({ secret: SECRET, now: () => NOW });
    const token = await authority.sign(claims());

    await expect(authority.verify({ ...token, claims: { ...token.claims, memberId: "mbr_foreign" } }))
      .resolves.toBeNull();
    await expect(authority.verify({ ...token, schemaVersion: "signed-copilot-continuation/v2" as never }))
      .resolves.toBeNull();

    const afterExpiry = createCopilotContinuationAuthority({
      secret: SECRET,
      now: () => new Date(Date.parse(token.claims.expiresAt) + 1).toISOString(),
    });
    await expect(afterExpiry.verify(token)).resolves.toBeNull();

    await expect(authority.sign(claims({
      expiresAt: new Date(Date.parse(NOW) + COPILOT_CONTINUATION_MAX_TTL_MS + 1).toISOString(),
    }))).rejects.toThrow(/lifetime/i);
  });

  it("requires a production secret and permits the synthetic local fallback only locally", () => {
    expect(() => copilotContinuationSecret("production", undefined)).toThrow(/COPILOT_CONTINUATION_SECRET/);
    expect(copilotContinuationSecret("test", undefined)).toHaveLength(48);
    expect(copilotContinuationSecret("production", SECRET)).toBe(SECRET);
  });
});
