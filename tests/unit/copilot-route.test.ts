import { describe, expect, it, vi } from "vitest";
import type { CopilotOutcome } from "../../src/domain/contracts/copilot";
import { createCopilotPostHandler } from "../../src/app/api/copilot/route";
import { createMockCoachSessionAuthority } from "../../src/server/auth/mock-coach-session";

const session = {
  status: "authorized" as const,
  coachId: "coach:casey",
  authorizationId: "copilot-session:opaque",
  entitledMemberIds: ["mbr_01HX9JORDAN", "mbr_02HX9AVERY", "mbr_03HX9MORGAN"],
};

const validBody = {
  schemaVersion: "copilot-request/v1",
  requestId: "request:one",
  memberId: "mbr_01HX9JORDAN",
  requestedFor: "2026-07-08",
  input: { kind: "quick-prompt", promptId: "adherence" },
};

function request(body: unknown, init: RequestInit = {}) {
  return new Request("https://axon.test/api/copilot", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { origin: "https://axon.test", "content-type": "application/json", ...init.headers },
    signal: init.signal,
  });
}

function outcome(status: CopilotOutcome["status"]): CopilotOutcome {
  switch (status) {
    case "ready": throw new Error("ready fixture not used");
    case "empty": return { status, requestId: "request:one", message: "Member context is not available." };
    case "insufficient-history": return { status, requestId: "request:one", requiredPoints: 2, availablePoints: 1, message: "Not enough history." };
    case "stale": return { status, requestId: "request:one", requestedRevisionId: "secret-old", activeRevisionId: "secret-active", message: "Stale." };
    case "continuation-expired": return { status, requestId: "request:one", message: "Expired." };
    case "denied": return { status, requestId: "request:one", message: "Member context is unavailable." };
    case "invalid": return { status, requestId: "request:one", code: "invalid-context", message: "Invalid." };
    case "unavailable": return { status, requestId: "request:one", code: "graph-unavailable", retryable: true, message: "Unavailable." };
    case "model-error": return { status, requestId: "request:one", code: "provider-unavailable", retryable: true, message: "Unavailable." };
    case "unsupported": return { status, requestId: "request:one", supportedPromptIds: ["adherence"], message: "Unsupported." };
    case "cancelled": return { status, requestId: "request:one" };
  }
}

describe("Copilot route", () => {
  it("derives the coach and opaque authorization from the server session", async () => {
    const answer = vi.fn(async () => outcome("empty"));
    const handler = createCopilotPostHandler({ resolveSession: async () => session, answer });
    const response = await handler(request({ ...validBody, coachId: "coach:forged", input: validBody.input }));

    expect(response.status).toBe(400);
    expect(answer).not.toHaveBeenCalled();

    const accepted = await handler(request(validBody));
    expect(accepted.status).toBe(200);
    expect(answer).toHaveBeenCalledWith({
      coachId: session.coachId,
      authorizationId: session.authorizationId,
      request: validBody,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("mints a server-only synthetic local grant and rechecks member entitlement", async () => {
    const authority = createMockCoachSessionAuthority({
      secret: "unit-test-copilot-session-secret-32-bytes---",
      environment: "test",
      now: () => "2026-08-07T10:00:00.000Z",
      localCoachId: "coach:casey",
      localMemberIds: ["mbr_01HX9JORDAN"],
      testBypass: true,
    });
    const resolved = await authority.resolveSession(request(validBody));
    expect(resolved).toMatchObject({ status: "authorized", coachId: "coach:casey", entitledMemberIds: ["mbr_01HX9JORDAN"] });
    if (resolved.status !== "authorized") throw new Error("expected local session");
    expect(authority.authorize({ coachId: resolved.coachId, memberId: "mbr_01HX9JORDAN", authorizationId: resolved.authorizationId })).toBe(true);
    expect(authority.authorize({ coachId: resolved.coachId, memberId: "mbr_foreign", authorizationId: resolved.authorizationId })).toBe(false);
    expect(authority.authorize({ coachId: "coach:foreign", memberId: "mbr_01HX9JORDAN", authorizationId: resolved.authorizationId })).toBe(false);
  });

  it("rejects bounded-input violations before resolving the session or calling the application", async () => {
    const resolveSession = vi.fn(async () => session);
    const answer = vi.fn(async () => outcome("empty"));
    const handler = createCopilotPostHandler({ resolveSession, answer });
    const invalidBodies = [
      { ...validBody, input: { kind: "free-text", question: "x".repeat(501) } },
      { ...validBody, input: { kind: "quick-prompt", promptId: "raw-cypher" } },
      { ...validBody, requestedFor: "2026-99-99" },
      { ...validBody, history: new Array(13).fill({ role: "user", text: "foreign" }) },
      { ...validBody, windowDays: 10_000 },
      { ...validBody, continuation: { schemaVersion: "signed-copilot-continuation/v1", algorithm: "hmac-sha256", claims: { contextRevisionId: "MATCH (n)" }, signature: "x" } },
    ];
    for (const body of invalidBodies) {
      const response = await handler(request(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ status: "invalid", controls: { retry: false, refresh: false, keepLastReadyAnswer: true } });
    }

    const oversized = await handler(request("x".repeat(17_000), { headers: { "content-length": "17000" } }));
    expect(oversized.status).toBe(413);
    expect(resolveSession).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
  });

  it("cancels an incrementally streamed body as soon as it crosses the byte limit", async () => {
    const cancel = vi.fn();
    let chunk = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunk += 1;
        if (chunk === 1) controller.enqueue(new Uint8Array(16_000));
        else controller.enqueue(new Uint8Array(500));
      },
      cancel,
    });
    const streamed = new Request("https://axon.test/api/copilot", {
      method: "POST",
      body,
      headers: { origin: "https://axon.test", "content-type": "application/json" },
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const resolveSession = vi.fn(async () => session);
    const answer = vi.fn(async () => outcome("empty"));
    const response = await createCopilotPostHandler({ resolveSession, answer })(streamed);

    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(resolveSession).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
  });

  it("accepts valid JSON split across byte-stream chunks", async () => {
    const encoded = new TextEncoder().encode(JSON.stringify({
      ...validBody,
      input: { kind: "free-text", question: "How is sleep trending? 💤" },
    }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, encoded.length - 2));
        controller.enqueue(encoded.slice(encoded.length - 2));
        controller.close();
      },
    });
    const streamed = new Request("https://axon.test/api/copilot", {
      method: "POST",
      body,
      headers: { origin: "https://axon.test", "content-type": "application/json" },
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const answer = vi.fn(async () => outcome("empty"));
    const response = await createCopilotPostHandler({ resolveSession: async () => session, answer })(streamed);

    expect(response.status).toBe(200);
    expect(answer).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ input: { kind: "free-text", question: "How is sleep trending? 💤" } }),
    }), expect.anything());
  });

  it("applies the route deadline while an incomplete body stream remains open", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"schemaVersion":"copilot-request/v1"'));
      },
      cancel,
    });
    const streamed = new Request("https://axon.test/api/copilot", {
      method: "POST",
      body,
      headers: { origin: "https://axon.test", "content-type": "application/json" },
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const resolveSession = vi.fn(async () => session);
    const answer = vi.fn(async () => outcome("empty"));
    const response = await createCopilotPostHandler({ resolveSession, answer, deadlineMs: 20 })(streamed);

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      status: "unavailable",
      code: "graph-timeout",
      retryable: true,
      controls: { retry: true, refresh: false, keepLastReadyAnswer: true },
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(resolveSession).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
  }, 500);

  it("applies the route deadline while session resolution is stalled", async () => {
    const resolveSession = vi.fn(() => new Promise<typeof session>(() => undefined));
    const answer = vi.fn(async () => outcome("empty"));
    const response = await createCopilotPostHandler({ resolveSession, answer, deadlineMs: 20 })(request(validBody));

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      status: "unavailable",
      requestId: validBody.requestId,
      code: "graph-timeout",
      retryable: true,
      controls: { retry: true, refresh: false, keepLastReadyAnswer: true },
    });
    expect(resolveSession).toHaveBeenCalledOnce();
    expect(answer).not.toHaveBeenCalled();
  }, 500);

  it("preserves caller cancellation while session resolution is stalled", async () => {
    let markSessionStarted: () => void = () => undefined;
    const sessionStarted = new Promise<void>((resolve) => { markSessionStarted = resolve; });
    const resolveSession = vi.fn(() => {
      markSessionStarted();
      return new Promise<typeof session>(() => undefined);
    });
    const answer = vi.fn(async () => outcome("empty"));
    const controller = new AbortController();
    const pending = createCopilotPostHandler({ resolveSession, answer })(request(validBody, { signal: controller.signal }));
    await sessionStarted;
    controller.abort();
    const response = await pending;

    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({ status: "cancelled", requestId: validBody.requestId });
    expect(answer).not.toHaveBeenCalled();
  });

  it("uses one non-enumerating denial for missing sessions, guessed members, and wrong grants", async () => {
    const deniedAnswer = vi.fn(async () => outcome("denied"));
    const wrongGrant = createCopilotPostHandler({ resolveSession: async () => session, answer: deniedAnswer });
    const guessed = await wrongGrant(request({ ...validBody, memberId: "mbr_guessed" }));
    const denied = await wrongGrant(request(validBody));
    const noSession = await createCopilotPostHandler({
      resolveSession: async () => ({ status: "unauthorized" as const }),
      answer: deniedAnswer,
    })(request(validBody));

    const guessedPayload = await guessed.json();
    const deniedPayload = await denied.json();
    const noSessionPayload = await noSession.json();
    expect(guessed.status).toBe(404);
    expect(guessedPayload).toEqual(deniedPayload);
    expect(noSessionPayload).toEqual(deniedPayload);
    expect(deniedAnswer).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(noSessionPayload)).not.toMatch(/revision|evidence|coach|grant|exist/i);
  });

  it.each([
    ["invalid", 400, false, false, true],
    ["denied", 404, false, false, false],
    ["empty", 200, false, true, true],
    ["insufficient-history", 200, false, false, true],
    ["continuation-expired", 409, false, true, true],
    ["stale", 409, false, true, true],
    ["unavailable", 503, true, false, true],
    ["model-error", 503, true, false, true],
    ["unsupported", 200, false, false, true],
    ["cancelled", 499, false, false, true],
  ] as const)("maps %s to privacy-safe controls", async (status, http, retry, refresh, keepLastReadyAnswer) => {
    const handler = createCopilotPostHandler({ resolveSession: async () => session, answer: async () => outcome(status) });
    const response = await handler(request(validBody));
    const payload = await response.json();

    expect(response.status).toBe(http);
    expect(payload).toMatchObject({ status, controls: { retry, refresh, keepLastReadyAnswer } });
    if (status === "stale") expect(JSON.stringify(payload)).not.toMatch(/secret-old|secret-active|RevisionId/);
  });

  it.each([
    [{ status: "unavailable", requestId: "request:one", code: "graph-unavailable", retryable: true, message: "Unavailable." } as const, 503],
    [{ status: "unavailable", requestId: "request:one", code: "graph-timeout", retryable: true, message: "Timed out." } as const, 504],
    [{ status: "model-error", requestId: "request:one", code: "provider-unavailable", retryable: true, message: "Unavailable." } as const, 503],
    [{ status: "model-error", requestId: "request:one", code: "provider-timeout", retryable: true, message: "Timed out." } as const, 504],
    [{ status: "model-error", requestId: "request:one", code: "malformed-selection", retryable: true, message: "Malformed." } as const, 503],
    [{ status: "model-error", requestId: "request:one", code: "grounding-rejected", retryable: true, message: "Rejected." } as const, 503],
  ])("preserves the safe typed subcode for %s", async (typed, http) => {
    const handler = createCopilotPostHandler({ resolveSession: async () => session, answer: async () => typed });
    const response = await handler(request(validBody));
    expect(response.status).toBe(http);
    expect(await response.json()).toMatchObject({ status: typed.status, code: typed.code, controls: { retry: true, refresh: false, keepLastReadyAnswer: true } });
  });

  it("passes client cancellation through and never echoes raw input in failure payloads", async () => {
    const answer = vi.fn(async (_input, options: { readonly signal?: AbortSignal } = {}) => {
      await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return outcome("cancelled");
    });
    const handler = createCopilotPostHandler({ resolveSession: async () => session, answer });
    const controller = new AbortController();
    const pending = handler(request({ ...validBody, input: { kind: "free-text", question: "private seeded message" } }, { signal: controller.signal }));
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(499);
    expect(JSON.stringify(await response.json())).not.toContain("private seeded message");
  });
});
