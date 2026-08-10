import type { SubmitWorkoutRunInput, SubmitWorkoutRunResult } from "../../../application/use-cases/submit-workout-run";
import { configuredWorkoutRouteComposition } from "../../../server/workout-route-composition";
import { isSameOriginMutation as hasSameOriginMutation } from "../../../server/http/same-origin";

export type WorkoutRouteSession =
  | { readonly status: "authorized"; readonly coachId: string; readonly authorizationId: string }
  | { readonly status: "unauthorized" | "unavailable" };

export type ResolveWorkoutRouteSession = (request: Request) => Promise<WorkoutRouteSession>;
export type WorkoutRouteContext = { readonly params: Promise<{ readonly runId: string }> | { readonly runId: string } };

export function isSameOriginMutation(request: Request): boolean {
  return hasSameOriginMutation(request);
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

export const noStoreHeaders = {
  "cache-control": "private, no-store, max-age=0",
  pragma: "no-cache",
} as const;

export function jsonResponse(value: unknown, status: number, headers: HeadersInit = {}) {
  return Response.json(value, { status, headers: { ...noStoreHeaders, ...headers } });
}

/** Builds an authorization-scoped link that can be followed without reconstructing request context. */
export function workoutRunResourceUrl(runId: string, memberId: string): string {
  const query = new URLSearchParams({ memberId });
  return `/api/workout-runs/${encodeURIComponent(runId)}?${query.toString()}`;
}

export function createWorkoutRunPostHandler(dependencies: {
  readonly resolveSession: ResolveWorkoutRouteSession;
  readonly submit: (input: SubmitWorkoutRunInput) => Promise<SubmitWorkoutRunResult>;
}) {
  return async (request: Request): Promise<Response> => {
    if (!isSameOriginMutation(request)) return jsonResponse({ status: "forbidden" }, 403);
    const session = await dependencies.resolveSession(request);
    if (session.status !== "authorized") return session.status === "unavailable"
      ? jsonResponse({ status: "unavailable" }, 503)
      : jsonResponse({ status: "not-found" }, 404);
    const body = await readJsonObject(request);
    if (!body || typeof body.memberId !== "string" || !body.memberId.trim()
      || typeof body.prompt !== "string" || !body.prompt.trim()
      || typeof body.durationMinutes !== "number" || !Number.isInteger(body.durationMinutes)
      || body.durationMinutes < 30 || body.durationMinutes > 60 || body.durationMinutes % 5 !== 0
      || typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim()) {
      return jsonResponse({ status: "invalid-request" }, 400);
    }
    const result = await dependencies.submit({
      coachId: session.coachId,
      memberId: body.memberId,
      sessionAuthorizationId: session.authorizationId,
      prompt: body.prompt,
      durationMinutes: body.durationMinutes,
      idempotencyKey: body.idempotencyKey,
    });
    if (result.status === "created" || result.status === "replayed") {
      return jsonResponse({
        runId: result.runId,
        status: result.status,
        resourceUrl: workoutRunResourceUrl(result.runId, body.memberId),
      }, result.status === "created" ? 202 : 200);
    }
    if (result.status === "invalid-request") return jsonResponse({ status: result.status }, 400);
    if (result.status === "idempotency-conflict") return jsonResponse({ status: result.status }, 409);
    if (result.status === "canonical-state-unavailable") return jsonResponse({ status: "unavailable" }, 503);
    return jsonResponse({ status: "not-found" }, 404);
  };
}

export const POST = createWorkoutRunPostHandler({
  resolveSession: configuredWorkoutRouteComposition.resolveSession,
  submit: configuredWorkoutRouteComposition.submit,
});
