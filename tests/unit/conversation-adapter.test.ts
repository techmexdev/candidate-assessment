import { describe, expect, it } from "vitest";

import {
  createCopilotSupportingContextReference,
  createSignedCopilotContinuation,
} from "../../src/domain/contracts/copilot";
import { createFetchDashboardConversationClient } from "../../src/features/coach-dashboard/conversation-adapter";

const reference = createCopilotSupportingContextReference({
  schemaVersion: "copilot-supporting-context/v1",
  memberId: "mbr_jordan",
  contextRevisionId: "revision-1",
  authority: "canonical",
  answerId: "answer:context",
  anchor: { kind: "conversation", evidenceId: "message:anchor" },
  evidenceAsOf: "2026-06-04T23:59:59.999-05:00",
  memberTimezone: "America/Chicago",
  window: { fromInclusive: "2026-05-01T00:00:00.000Z", toExclusive: "2026-07-01T00:00:00.000Z" },
  continuation: createSignedCopilotContinuation({
    claims: {
      schemaVersion: "copilot-continuation-claims/v1",
      coachId: "coach:casey",
      memberId: "mbr_jordan",
      contextRevisionId: "revision-1",
      answerId: "answer:context",
      intentId: "churn-risk",
      selectedEvidenceIds: ["message:anchor"],
      issuedAt: "2026-08-07T10:00:00.000Z",
      expiresAt: "2026-08-07T10:15:00.000Z",
    },
    signature: "test-signature",
  }),
});

function readyTimeline(overrides: Record<string, unknown> = {}) {
  return {
    memberId: reference.memberId,
    contextRevisionId: reference.contextRevisionId,
    authority: reference.authority,
    conversationEvidenceId: "conversation:1",
    anchorEvidenceId: reference.anchor.evidenceId,
    evidenceAsOf: reference.evidenceAsOf,
    memberTimezone: reference.memberTimezone,
    window: reference.window,
    messages: [{
      evidenceId: reference.anchor.evidenceId,
      semanticId: "message:anchor",
      assertionId: "assertion:message:anchor",
      kind: "message",
      source: { locator: "/synthetic/member-context", artifactDigest: `sha256:${"b".repeat(64)}` },
      classification: "source-statement",
      temporal: { precision: "date", effectiveOn: "2026-05-22" },
      senderRole: "member",
      text: "A bounded synthetic message.",
      attachmentEvidenceIds: [],
      attachments: [],
    }],
    ...overrides,
  };
}

describe("dashboard conversation adapter", () => {
  it("sends the signed handoff and accepts only the matching bounded timeline", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ status: "ready", timeline: readyTimeline(), nextCursor: "cursor:1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = createFetchDashboardConversationClient(fetcher);

    const result = await client.load({
      requestId: "conversation:1",
      memberId: reference.memberId,
      contextRevisionId: reference.contextRevisionId,
      window: reference.window,
      supportingContext: reference,
    });

    expect(result).toMatchObject({ status: "ready", requestId: "conversation:1", nextCursor: "cursor:1" });
    expect(calls).toHaveLength(1);
    const params = new URL(calls[0].url, "http://localhost").searchParams;
    expect(params.get("memberId")).toBe(reference.memberId);
    expect(params.get("contextRevisionId")).toBe(reference.contextRevisionId);
    expect(params.get("from")).toBe(reference.window.fromInclusive);
    expect(params.get("to")).toBe(reference.window.toExclusive);
    expect(params.get("answerId")).toBe(reference.answerId);
    expect(params.get("anchorEvidenceId")).toBe(reference.anchor.evidenceId);
    expect(params.get("evidenceAsOf")).toBe(reference.evidenceAsOf);
    expect(params.get("memberTimezone")).toBe(reference.memberTimezone);
    expect(JSON.parse(params.get("continuation") ?? "null")).toMatchObject({
      claims: { answerId: reference.answerId, selectedEvidenceIds: [reference.anchor.evidenceId] },
    });
  });

  it("fails closed for a response from another member or revision", async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      status: "ready",
      timeline: readyTimeline({ memberId: "mbr_foreign" }),
    }), { status: 200 })) as typeof fetch;
    const client = createFetchDashboardConversationClient(fetcher);

    await expect(client.load({
      requestId: "conversation:foreign",
      memberId: reference.memberId,
      contextRevisionId: reference.contextRevisionId,
      window: reference.window,
      supportingContext: reference,
    })).resolves.toMatchObject({ status: "unavailable", requestId: "conversation:foreign" });
  });

  it("returns a typed cancellation when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      return new Response(JSON.stringify({ status: "empty", message: "No conversation." }), { status: 200 });
    }) as typeof fetch;
    const client = createFetchDashboardConversationClient(fetcher);

    await expect(client.load({
      requestId: "conversation:cancelled",
      memberId: reference.memberId,
      window: reference.window,
      signal: controller.signal,
    })).resolves.toMatchObject({ status: "cancelled", requestId: "conversation:cancelled" });
  });
});
