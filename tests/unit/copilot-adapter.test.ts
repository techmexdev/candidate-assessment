import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { createCopilotPin, type CopilotAnswerPacket, type CopilotOutcome } from "../../src/domain/contracts/copilot";
import { createFetchDashboardCopilotClient } from "../../src/features/coach-dashboard/production-adapter";
import { syntheticDashboardBase } from "../../src/features/coach-dashboard/synthetic-dashboard-base";
import {
  createInitialDashboardState,
  dashboardReducer,
  selectActiveAthleteState,
} from "../../src/features/coach-dashboard/state";

const continuation = {
  schemaVersion: "signed-copilot-continuation/v1",
  algorithm: "hmac-sha256",
  claims: {
    schemaVersion: "copilot-continuation-claims/v1",
    coachId: "coach:casey",
    memberId: "mbr_01HX9JORDAN",
    contextRevisionId: "member-context:r1",
    answerId: "answer:1",
    intentId: "adherence",
    selectedEvidenceIds: ["evidence:1"],
    issuedAt: "2026-08-07T10:00:00.000Z",
    expiresAt: "2026-08-07T11:00:00.000Z",
  },
  signature: "signed",
} as const;

function readyAnswer(requestId = "request:1", answerId = "answer:1"): CopilotAnswerPacket {
  return {
    schemaVersion: "copilot-answer/v1",
    requestId,
    answerId,
    memberId: "mbr_01HX9JORDAN",
    contextRevisionId: "member-context:r1",
    authority: "canonical",
    intentId: "adherence",
    requestedFor: "2026-07-08",
    evidenceAsOf: "2026-06-04T23:59:59.999-05:00",
    memberTimezone: "America/Chicago",
    briefFreshness: null,
    evidence: {
      memberId: "mbr_01HX9JORDAN",
      contextRevisionId: "member-context:r1",
      authority: "canonical",
      atoms: [{
        atomKind: "fact",
        memberId: "mbr_01HX9JORDAN",
        contextRevisionId: "member-context:r1",
        authority: "canonical",
        evidenceId: "evidence:1",
        evidenceKind: "observation",
        source: { locator: "/adherence/0", artifactDigest: "sha256:source" },
        classification: "observation",
        temporal: { precision: "date", effectiveOn: "2026-06-04" },
        unit: "percent",
        value: 50,
      }],
    },
    sections: [{ sectionId: "answer", clauses: [{ clauseId: "clause:1", text: "Completion was 50%.", evidenceIds: ["evidence:1"] }] }],
    chart: null,
    citations: [{
      memberId: "mbr_01HX9JORDAN",
      contextRevisionId: "member-context:r1",
      authority: "canonical",
      citationId: "citation:1",
      evidenceId: "evidence:1",
      label: "Weekly completion",
      source: { locator: "/adherence/0", artifactDigest: "sha256:source" },
      classification: "observation",
      temporal: { precision: "date", effectiveOn: "2026-06-04" },
      unit: "percent",
    }],
    churn: null,
    continuation: { ...continuation, claims: { ...continuation.claims, answerId } },
  };
}

const readyOutcome = (requestId = "request:1", answerId = "answer:1") => ({
  status: "ready",
  requestId,
  answer: readyAnswer(requestId, answerId),
  controls: { retry: false, refresh: false, keepLastReadyAnswer: false },
}) as const;

describe("dashboard Copilot adapter", () => {
  it("posts one bounded request and retains the signed continuation", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        schemaVersion: "copilot-request/v1",
        requestId: "request:2",
        memberId: "mbr_01HX9JORDAN",
        requestedFor: "2026-07-08",
        input: { kind: "free-text", question: "What changed?" },
        continuation,
      });
      return Response.json({ ...readyOutcome("request:2", "answer:2"), answer: readyAnswer("request:2", "answer:2") });
    });
    const client = createFetchDashboardCopilotClient(fetcher as typeof fetch);

    await expect(client.request({
      requestId: "request:2",
      memberId: "mbr_01HX9JORDAN",
      requestedFor: "2026-07-08",
      input: { kind: "free-text", question: "What changed?" },
      continuation,
    })).resolves.toMatchObject({ status: "ready", requestId: "request:2", answer: { answerId: "answer:2" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the route returns a mismatched request identity", async () => {
    const client = createFetchDashboardCopilotClient(async () => Response.json(readyOutcome("request:foreign")));
    await expect(client.request({
      requestId: "request:expected",
      memberId: "mbr_01HX9JORDAN",
      requestedFor: "2026-07-08",
      input: { kind: "quick-prompt", promptId: "sleep" },
    })).resolves.toMatchObject({
      status: "unavailable",
      requestId: "request:expected",
      controls: { retry: true, refresh: false, keepLastReadyAnswer: true },
    });
  });

  it.each([
    ["missing evidence atoms", { ...readyOutcome(), answer: { ...readyAnswer(), evidence: { ...readyAnswer().evidence, atoms: "not-an-array" } } }],
    ["malformed answer clauses", { ...readyOutcome(), answer: { ...readyAnswer(), sections: [{ sectionId: "answer", clauses: null }] } }],
    ["malformed continuation claims", { ...readyOutcome(), answer: { ...readyAnswer(), continuation: { ...continuation, claims: { ...continuation.claims, selectedEvidenceIds: "evidence:1" } } } }],
    ["unknown unavailable code", { status: "unavailable", requestId: "request:1", code: "raw-provider-secret", retryable: true, message: "Unavailable.", controls: { retry: true, refresh: false, keepLastReadyAnswer: true } }],
    ["wrong retryability", { status: "model-error", requestId: "request:1", code: "provider-unavailable", retryable: false, message: "Unavailable.", controls: { retry: true, refresh: false, keepLastReadyAnswer: true } }],
    ["unknown outcome", { status: "surprise", requestId: "request:1", controls: { retry: false, refresh: false, keepLastReadyAnswer: true } }],
  ])("fails closed for %s payloads", async (_label, payload) => {
    const client = createFetchDashboardCopilotClient(async () => Response.json(payload));
    await expect(client.request({
      requestId: "request:1",
      memberId: "mbr_01HX9JORDAN",
      requestedFor: "2026-07-08",
      input: { kind: "quick-prompt", promptId: "sleep" },
    })).resolves.toMatchObject({
      status: "unavailable",
      requestId: "request:1",
      controls: { retry: true, refresh: false, keepLastReadyAnswer: true },
    });
  });

  it.each([
    ["denied", "request:unavailable", { retry: false, refresh: false, keepLastReadyAnswer: false }],
    ["invalid", "request:invalid", { retry: false, refresh: false, keepLastReadyAnswer: true }],
  ] as const)("accepts the route's safe %s placeholder request ID", async (status, placeholder, responseControls) => {
    const client = createFetchDashboardCopilotClient(async () => Response.json({
      status,
      requestId: placeholder,
      ...(status === "invalid" ? { code: "invalid-body" } : {}),
      message: "Member context is unavailable.",
      controls: responseControls,
    }));
    await expect(client.request({
      requestId: "request:expected",
      memberId: "mbr_01HX9JORDAN",
      requestedFor: "2026-07-08",
      input: { kind: "quick-prompt", promptId: "sleep" },
    })).resolves.toMatchObject({ status, requestId: "request:expected", controls: responseControls });
  });

  it("rejects arbitrary denied request IDs instead of treating them as privacy placeholders", async () => {
    const client = createFetchDashboardCopilotClient(async () => Response.json({
      status: "denied",
      requestId: "request:foreign",
      message: "Member context is unavailable.",
      controls: { retry: false, refresh: false, keepLastReadyAnswer: false },
    }));
    await expect(client.request({
      requestId: "request:expected",
      memberId: "mbr_01HX9JORDAN",
      requestedFor: "2026-07-08",
      input: { kind: "quick-prompt", promptId: "sleep" },
    })).resolves.toMatchObject({ status: "unavailable", requestId: "request:expected" });
  });

  it("keeps production roster and workout data separate from fixture Copilot fields", async () => {
    const source = await readFile(new URL("../../src/features/coach-dashboard/synthetic-dashboard-base.ts", import.meta.url), "utf8");
    expect(syntheticDashboardBase.workspace.athletes.map(({ name }) => name)).toEqual(["Jordan Rivera", "Avery Chen", "Morgan Lee"]);
    expect(source).not.toMatch(/member-context|morningBrief|copilotCards|churn/i);
  });
});

describe("dashboard Copilot reducer lifecycle", () => {
  const selected = () => dashboardReducer(
    createInitialDashboardState("2026-07-08"),
    { type: "select-athlete", memberId: "mbr_01HX9JORDAN" },
  );
  const workflow = (state: ReturnType<typeof selected>) => {
    const value = selectActiveAthleteState(state);
    if (!value) throw new Error("missing workflow");
    return value;
  };
  const request = (requestId: string) => ({
    requestId,
    memberId: "mbr_01HX9JORDAN",
    promptLabel: "Sleep",
    input: { kind: "quick-prompt", promptId: "sleep" } as const,
  });

  it("suppresses duplicates and requires exact request identity for completion", () => {
    const pending = dashboardReducer(selected(), { type: "request-copilot", request: request("request:1") });
    expect(dashboardReducer(pending, { type: "request-copilot", request: request("request:duplicate") })).toBe(pending);
    expect(dashboardReducer(pending, { type: "complete-copilot", memberId: "mbr_01HX9JORDAN", requestId: "request:old", outcome: readyOutcome("request:old") })).toBe(pending);

    const completed = dashboardReducer(pending, { type: "complete-copilot", memberId: "mbr_01HX9JORDAN", requestId: "request:1", outcome: readyOutcome() });
    expect(workflow(completed).copilot).toMatchObject({ pending: null, lastReadyAnswer: { answerId: "answer:1" } });
  });

  it("cancels on Back and a resubmission gets a new identity that rejects the late first result", () => {
    const nested = dashboardReducer(selected(), { type: "push-route", route: { id: "copilot", focusKey: "brief-copilot" } });
    const first = dashboardReducer(nested, { type: "request-copilot", request: request("request:1") });
    const brief = dashboardReducer(first, { type: "pop-route" });
    const second = dashboardReducer(brief, { type: "request-copilot", request: request("request:2") });
    const late = dashboardReducer(second, { type: "complete-copilot", memberId: "mbr_01HX9JORDAN", requestId: "request:1", outcome: readyOutcome() });

    expect(late).toBe(second);
    expect(workflow(second).copilot.pending?.requestId).toBe("request:2");
  });

  it("preserves the last ready answer according to response controls", () => {
    const pending = dashboardReducer(selected(), { type: "request-copilot", request: request("request:1") });
    const completed = dashboardReducer(pending, { type: "complete-copilot", memberId: "mbr_01HX9JORDAN", requestId: "request:1", outcome: readyOutcome() });
    const retry = dashboardReducer(completed, { type: "request-copilot", request: request("request:2") });
    const failure: CopilotOutcome & { controls: { retry: boolean; refresh: boolean; keepLastReadyAnswer: boolean } } = {
      status: "model-error",
      requestId: "request:2",
      code: "provider-unavailable",
      retryable: true,
      message: "Model unavailable.",
      controls: { retry: true, refresh: false, keepLastReadyAnswer: true },
    };
    const failed = dashboardReducer(retry, { type: "complete-copilot", memberId: "mbr_01HX9JORDAN", requestId: "request:2", outcome: failure });
    expect(workflow(failed).copilot.lastReadyAnswer?.answerId).toBe("answer:1");
    expect(workflow(failed).copilot.outcome).toMatchObject({ status: "model-error" });
  });

  it("keeps a pinned section bound to its original answer and revision after a newer answer", () => {
    const firstPending = dashboardReducer(selected(), { type: "request-copilot", request: request("request:1") });
    const first = dashboardReducer(firstPending, { type: "complete-copilot", memberId: "mbr_01HX9JORDAN", requestId: "request:1", outcome: readyOutcome() });
    const pin = createCopilotPin({ pinId: "answer:1:answer", answer: readyAnswer(), sectionId: "answer", createdAt: "2026-08-07T10:05:00.000Z" });
    const pinned = dashboardReducer(first, { type: "toggle-copilot-pin", pin });
    const secondPending = dashboardReducer(pinned, { type: "request-copilot", request: request("request:2") });
    const second = dashboardReducer(secondPending, { type: "complete-copilot", memberId: "mbr_01HX9JORDAN", requestId: "request:2", outcome: readyOutcome("request:2", "answer:2") });

    expect(workflow(second).copilot.lastReadyAnswer?.answerId).toBe("answer:2");
    expect(workflow(second).copilot.pins[0]).toMatchObject({ answerId: "answer:1", contextRevisionId: "member-context:r1" });
    expect(workflow(second).copilot.pins[0].renderedSnapshot.section.clauses[0].text).toBe("Completion was 50%.");
  });
});
