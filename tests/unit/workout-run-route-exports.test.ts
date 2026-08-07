import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as submitWorkoutRun } from "../../src/app/api/workout-runs/route";
import { DELETE as cancelWorkoutRun, GET as readWorkoutRun } from "../../src/app/api/workout-runs/[runId]/route";
import { GET as replayWorkoutRunEvents } from "../../src/app/api/workout-runs/[runId]/events/route";
import { POST as answerWorkoutClarification } from "../../src/app/api/workout-runs/[runId]/clarification/route";
import { POST as retryWorkoutRun } from "../../src/app/api/workout-runs/[runId]/retry/route";
import {
  installWorkoutRouteCompositionForTesting,
  type WorkoutRouteComposition,
} from "../../src/server/workout-route-composition";
import { asWorkoutRunId } from "../../src/domain/contracts/workout";

const runId = asWorkoutRunId("workout-run:exported");
const context = { params: Promise.resolve({ runId }) };

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://axon.test${path}`, {
    ...init,
    headers: { origin: "https://axon.test", "content-type": "application/json", ...init.headers },
  });
}

function composition(): WorkoutRouteComposition {
  return {
    resolveSession: vi.fn(async () => ({ status: "authorized" as const, coachId: "coach:exported", authorizationId: "session:exported" })),
    submit: vi.fn(async () => ({ status: "created" as const, runId })),
    retrieve: vi.fn(async () => ({
      status: "ready" as const,
      resource: {
        runId,
        state: "queued" as const,
        requestedDurationMinutes: 45,
        movementGraphRevisionId: "movement:one",
        memberContextRevisionId: "member:one",
      },
    })),
    cancel: vi.fn(async () => ({ status: "canceled" as const })),
    replay: vi.fn(async () => ({ status: "ready" as const, events: [], nextCursor: "cursor:one", highWaterSequence: 1 })),
    answer: vi.fn(async () => ({ status: "requeued" as const, revision: 2 })),
    retry: vi.fn(async () => ({ status: "created" as const, runId: asWorkoutRunId("workout-run:retry") })),
  };
}

afterEach(() => installWorkoutRouteCompositionForTesting(undefined));

describe("production workout route exports", () => {
  it("delegate every exported handler to the configured server composition", async () => {
    const configured = composition();
    installWorkoutRouteCompositionForTesting(configured);

    const submitted = await submitWorkoutRun(request("/api/workout-runs", {
      method: "POST",
      body: JSON.stringify({ memberId: "member:one", prompt: "Knee-safe strength", durationMinutes: 45, idempotencyKey: "export-1" }),
    }));
    const read = await readWorkoutRun(request(`/api/workout-runs/${runId}?memberId=member%3Aone`), context);
    const canceled = await cancelWorkoutRun(request(`/api/workout-runs/${runId}?memberId=member%3Aone`, { method: "DELETE" }), context);
    const replayed = await replayWorkoutRunEvents(request(`/api/workout-runs/${runId}/events?memberId=member%3Aone`), context);
    const clarified = await answerWorkoutClarification(request(`/api/workout-runs/${runId}/clarification`, {
      method: "POST",
      body: JSON.stringify({ memberId: "member:one", answer: "Avoid deep knee flexion" }),
    }), context);
    const retried = await retryWorkoutRun(request(`/api/workout-runs/${runId}/retry`, {
      method: "POST",
      body: JSON.stringify({ memberId: "member:one", idempotencyKey: "retry-export-1" }),
    }), context);

    expect([submitted.status, read.status, canceled.status, replayed.status, clarified.status, retried.status])
      .toEqual([202, 200, 202, 200, 202, 202]);
    expect(configured.submit).toHaveBeenCalledWith(expect.objectContaining({ coachId: "coach:exported" }));
    expect(configured.retrieve).toHaveBeenCalledOnce();
    expect(configured.cancel).toHaveBeenCalledOnce();
    expect(configured.replay).toHaveBeenCalledOnce();
    expect(configured.answer).toHaveBeenCalledOnce();
    expect(configured.retry).toHaveBeenCalledOnce();
  });

  it("fails closed only when required production composition is unavailable", async () => {
    installWorkoutRouteCompositionForTesting(undefined);
    const environment = process.env as Record<string, string | undefined>;
    const previousEnvironment = environment.NODE_ENV;
    const previousSecret = environment.WORKOUT_ROUTE_SECRET;
    try {
      environment.NODE_ENV = "production";
      delete environment.WORKOUT_ROUTE_SECRET;

      const response = await submitWorkoutRun(request("/api/workout-runs", {
        method: "POST",
        body: JSON.stringify({ memberId: "member:one", prompt: "Knee-safe strength", durationMinutes: 45, idempotencyKey: "export-2" }),
      }));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "unavailable" });
    } finally {
      if (previousEnvironment === undefined) delete environment.NODE_ENV;
      else environment.NODE_ENV = previousEnvironment;
      if (previousSecret === undefined) delete environment.WORKOUT_ROUTE_SECRET;
      else environment.WORKOUT_ROUTE_SECRET = previousSecret;
    }
  });
});
