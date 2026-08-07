import { asWorkoutRunId } from "../../../../../domain/contracts/workout";
import type { RetryWorkoutRunResult } from "../../../../../application/use-cases/retry-workout-run";
import {
  isSameOriginMutation,
  jsonResponse,
  readJsonObject,
  type ResolveWorkoutRouteSession,
  type WorkoutRouteContext,
} from "../../route";

export function createWorkoutRetryHandler(dependencies: {
  readonly resolveSession: ResolveWorkoutRouteSession;
  readonly retry: (input: {
    readonly runId: ReturnType<typeof asWorkoutRunId>;
    readonly coachId: string;
    readonly memberId: string;
    readonly sessionAuthorizationId: string;
    readonly idempotencyKey: string;
  }) => Promise<RetryWorkoutRunResult>;
}) {
  return async (request: Request, context: WorkoutRouteContext): Promise<Response> => {
    if (!isSameOriginMutation(request)) return jsonResponse({ status: "forbidden" }, 403);
    const session = await dependencies.resolveSession(request);
    if (session.status !== "authorized") return session.status === "unavailable"
      ? jsonResponse({ status: "unavailable" }, 503)
      : jsonResponse({ status: "not-found" }, 404);
    const body = await readJsonObject(request);
    const { runId } = await context.params;
    if (!body || typeof body.memberId !== "string" || typeof body.idempotencyKey !== "string" || !runId) return jsonResponse({ status: "invalid-request" }, 400);
    const result = await dependencies.retry({
      runId: asWorkoutRunId(runId),
      coachId: session.coachId,
      memberId: body.memberId,
      sessionAuthorizationId: session.authorizationId,
      idempotencyKey: body.idempotencyKey,
    });
    if (result.status === "created" || result.status === "replayed") {
      return jsonResponse({ ...result, resourceUrl: `/api/workout-runs/${encodeURIComponent(result.runId)}` }, result.status === "created" ? 202 : 200);
    }
    if (result.status === "invalid-request") return jsonResponse(result, 400);
    if (result.status === "not-retryable" || result.status === "idempotency-conflict") return jsonResponse(result, 409);
    return jsonResponse({ status: "not-found" }, 404);
  };
}

export const POST = createWorkoutRetryHandler({
  resolveSession: async () => ({ status: "unavailable" }),
  retry: async () => ({ status: "not-found" }),
});
