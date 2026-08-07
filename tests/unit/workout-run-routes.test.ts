import { describe, expect, it, vi } from "vitest";
import { asWorkoutRunId } from "../../src/domain/contracts/workout";
import { createWorkoutRunPostHandler } from "../../src/app/api/workout-runs/route";
import { createWorkoutRunResourceHandlers } from "../../src/app/api/workout-runs/[runId]/route";
import { createWorkoutRunEventsHandler } from "../../src/app/api/workout-runs/[runId]/events/route";
import { createWorkoutClarificationHandler } from "../../src/app/api/workout-runs/[runId]/clarification/route";
import { createWorkoutRetryHandler } from "../../src/app/api/workout-runs/[runId]/retry/route";
import type { RetrieveWorkoutRunResult } from "../../src/application/use-cases/retrieve-workout-run";
import type { CancelWorkoutRunResult } from "../../src/application/use-cases/cancel-workout-run";

const session = { status: "authorized" as const, coachId: "coach:server", authorizationId: "session:opaque" };
const context = { params: Promise.resolve({ runId: "workout-run:one" }) };

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://axon.test${path}`, {
    ...init,
    headers: { origin: "https://axon.test", "content-type": "application/json", ...init.headers },
  });
}

describe("workout run route adapters", () => {
  it("derives the coach from the server session and rejects cross-origin or invalid submissions", async () => {
    const submit = vi.fn(async (input: unknown) => {
      void input;
      return { status: "created" as const, runId: asWorkoutRunId("workout-run:one") };
    });
    const handler = createWorkoutRunPostHandler({ resolveSession: async () => session, submit });

    const accepted = await handler(request("/api/workout-runs", {
      method: "POST",
      body: JSON.stringify({ coachId: "coach:forged", memberId: "member:one", prompt: "A knee-safe strength day", durationMinutes: 45, idempotencyKey: "submit-1" }),
    }));

    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ runId: "workout-run:one", status: "created", resourceUrl: "/api/workout-runs/workout-run%3Aone" });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ coachId: "coach:server", sessionAuthorizationId: "session:opaque", memberId: "member:one" }));
    expect(submit.mock.calls[0]![0]).not.toHaveProperty("coachId", "coach:forged");

    const crossOrigin = await handler(new Request("https://axon.test/api/workout-runs", {
      method: "POST",
      headers: { origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ memberId: "member:one", prompt: "Workout", durationMinutes: 45, idempotencyKey: "submit-2" }),
    }));
    expect(crossOrigin.status).toBe(403);

    const invalid = await handler(request("/api/workout-runs", {
      method: "POST",
      body: JSON.stringify({ memberId: "member:one", prompt: "   ", durationMinutes: 41, idempotencyKey: "submit-3" }),
    }));
    expect(invalid.status).toBe(400);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("returns no-cache authoritative projections and maps foreign resources to not found", async () => {
    const retrieve = vi.fn(async (input: unknown): Promise<RetrieveWorkoutRunResult> => {
      void input;
      return {
        status: "ready" as const,
        resource: {
          runId: asWorkoutRunId("workout-run:one"), state: "running" as const, requestedDurationMinutes: 45,
          movementGraphRevisionId: "movement:one", memberContextRevisionId: "member:one", startedAt: "2026-08-07T10:00:00.000Z",
        },
      };
    });
    const cancel = vi.fn(async (): Promise<CancelWorkoutRunResult> => ({ status: "canceled" }));
    const handlers = createWorkoutRunResourceHandlers({ resolveSession: async () => session, retrieve, cancel });

    const response = await handlers.GET(request("/api/workout-runs/workout-run:one?memberId=member%3Aone"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(JSON.stringify(await response.json())).not.toMatch(/authorization|grant|prompt|cookie/i);

    retrieve.mockResolvedValueOnce({ status: "not-found" });
    expect((await handlers.GET(request("/api/workout-runs/workout-run:foreign?memberId=member%3Aone"), context)).status).toBe(404);

    const canceled = await handlers.DELETE(request("/api/workout-runs/workout-run:one?memberId=member%3Aone", { method: "DELETE" }), context);
    expect(canceled.status).toBe(202);
    cancel.mockResolvedValueOnce({ status: "already_completed" });
    expect((await handlers.DELETE(request("/api/workout-runs/workout-run:one?memberId=member%3Aone", { method: "DELETE" }), context)).status).toBe(409);

    const crossOrigin = await handlers.DELETE(new Request("https://axon.test/api/workout-runs/workout-run:one?memberId=member%3Aone", {
      method: "DELETE", headers: { origin: "https://evil.test" },
    }), context);
    expect(crossOrigin.status).toBe(403);
  });

  it("streams only allowlisted replay events and uses the opaque cursor as the SSE id", async () => {
    const replay = vi.fn(async () => ({
      status: "ready" as const,
      events: [{
        cursor: "opaque.cursor",
        event: {
          eventId: "event:2", schemaVersion: "workout-run-event/v1" as const, runId: asWorkoutRunId("workout-run:one"),
          sequence: 2, kind: "stage" as const, occurredAt: "2026-08-07T10:00:01.000Z", safeData: { stage: "catalog", candidateCount: 12 },
        },
      }],
      nextCursor: "opaque.cursor",
      highWaterSequence: 2,
    }));
    const handler = createWorkoutRunEventsHandler({ resolveSession: async () => session, replay });
    const response = await handler(request("/api/workout-runs/workout-run:one/events?memberId=member%3Aone", { headers: { origin: "https://axon.test", "last-event-id": "prior.cursor" } }), context);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("id: opaque.cursor");
    expect(body).toContain("event: stage");
    expect(body).not.toMatch(/prompt|evidence|authorization|grant/i);
    expect(replay).toHaveBeenCalledWith(expect.objectContaining({ cursor: "prior.cursor", coachId: "coach:server" }));
  });

  it("keeps clarification and retry as same-origin server-authorized mutations", async () => {
    const answer = vi.fn(async () => ({ status: "requeued" as const, revision: 2 }));
    const retry = vi.fn(async () => ({ status: "created" as const, runId: asWorkoutRunId("workout-run:retry") }));
    const clarificationHandler = createWorkoutClarificationHandler({ resolveSession: async () => session, answer });
    const retryHandler = createWorkoutRetryHandler({ resolveSession: async () => session, retry });

    const clarification = await clarificationHandler(request("/api/workout-runs/workout-run:one/clarification", {
      method: "POST", body: JSON.stringify({ memberId: "member:one", answer: "Use the patellofemoral restriction" }),
    }), context);
    const retried = await retryHandler(request("/api/workout-runs/workout-run:one/retry", {
      method: "POST", body: JSON.stringify({ memberId: "member:one", idempotencyKey: "retry-1" }),
    }), context);

    expect(clarification.status).toBe(202);
    expect(retried.status).toBe(202);
    expect(answer).toHaveBeenCalledWith(expect.objectContaining({ coachId: "coach:server", sessionAuthorizationId: "session:opaque" }));
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ coachId: "coach:server", sessionAuthorizationId: "session:opaque" }));
  });
});
