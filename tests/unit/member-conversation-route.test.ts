import { describe, expect, it, vi } from "vitest";

import { createMemberConversationHandler } from "../../src/app/api/member-context/conversation/route";
import { createCopilotContinuationAuthority } from "../../src/server/copilot/continuation-token";

const memberId = "mbr_01HX9JORDAN";
const revision = `member-context:sha256:${"1".repeat(64)}`;
const authority = createCopilotContinuationAuthority({
  secret: "unit-test-conversation-continuation-secret-32-bytes",
  now: () => "2026-08-07T10:05:00.000Z",
});

async function signedContinuation(coachId = "coach:casey") {
  return authority.sign({
    schemaVersion: "copilot-continuation-claims/v1",
    coachId,
    memberId,
    contextRevisionId: revision,
    answerId: "answer:context",
    intentId: "churn-risk",
    selectedEvidenceIds: ["message:anchor"],
    issuedAt: "2026-08-07T10:00:00.000Z",
    expiresAt: "2026-08-07T10:15:00.000Z",
  });
}

function request(continuation: unknown, overrides: Record<string, string> = {}) {
  const params = new URLSearchParams({
    memberId,
    contextRevisionId: revision,
    from: "2026-05-01T00:00:00.000Z",
    to: "2026-07-01T00:00:00.000Z",
    answerId: "answer:context",
    anchorEvidenceId: "message:anchor",
    evidenceAsOf: "2026-06-04T23:59:59.999-05:00",
    memberTimezone: "America/Chicago",
    continuation: JSON.stringify(continuation),
    ...overrides,
  });
  return new Request(`https://axon.test/api/member-context/conversation?${params}`);
}

describe("member conversation route", () => {
  it("verifies the signed handoff before passing the bounded scope to the application", async () => {
    const continuation = await signedContinuation();
    const conversation = vi.fn(async () => ({ status: "empty" as const, message: "No conversation." }));
    const handler = createMemberConversationHandler({
      resolveSession: async () => ({ status: "authorized" as const, coachId: "coach:casey", authorizationId: "session:opaque" }),
      verifyCopilotContinuation: authority.verify,
      conversation,
    });

    const response = await handler(request(continuation));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "empty", message: "No conversation." });
    expect(conversation).toHaveBeenCalledWith(expect.objectContaining({
      coachId: "coach:casey",
      memberId,
      sessionAuthorizationId: "session:opaque",
      contextRevisionId: revision,
      fromInclusive: "2026-05-01T00:00:00.000Z",
      toExclusive: "2026-07-01T00:00:00.000Z",
      supportingContext: expect.objectContaining({
        answerId: "answer:context",
        anchor: { kind: "conversation", evidenceId: "message:anchor" },
        contextRevisionId: revision,
      }),
    }));
  });

  it("fails closed for tampered, foreign, and over-bounded handoffs", async () => {
    const continuation = await signedContinuation();
    const conversation = vi.fn(async () => ({ status: "empty" as const, message: "No conversation." }));
    const handler = createMemberConversationHandler({
      resolveSession: async () => ({ status: "authorized" as const, coachId: "coach:casey", authorizationId: "session:opaque" }),
      verifyCopilotContinuation: authority.verify,
      conversation,
    });
    const tampered = { ...continuation, signature: `${continuation.signature.slice(0, -1)}x` };

    expect((await handler(request(tampered))).status).toBe(404);
    expect((await handler(request(await signedContinuation("coach:foreign")))).status).toBe(404);
    expect((await handler(request(continuation, { memberId: "mbr_foreign" }))).status).toBe(404);
    expect((await handler(request(continuation, {
      from: "2025-01-01T00:00:00.000Z",
      to: "2026-07-01T00:00:00.000Z",
    }))).status).toBe(404);
    expect(conversation).not.toHaveBeenCalled();
  });
});
