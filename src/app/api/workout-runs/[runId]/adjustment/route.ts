import { asWorkoutRunId } from "../../../../../domain/contracts/workout";
import type { SubmitWorkoutAdjustmentResult } from "../../../../../application/use-cases/submit-workout-adjustment";
import { WORKOUT_ADJUSTMENT_KEYS } from "../../../../../domain/contracts/workout-run";
import { configuredWorkoutRouteComposition } from "../../../../../server/workout-route-composition";
import {
  isSameOriginMutation,
  jsonResponse,
  readJsonObject,
  workoutRunResourceUrl,
  type ResolveWorkoutRouteSession,
  type WorkoutRouteContext,
} from "../../route";

const requiredKeys = new Set(["memberId", "predecessorWorkoutVersionId", "idempotencyKey"]);
const adjustmentKeys: ReadonlySet<string> = new Set(WORKOUT_ADJUSTMENT_KEYS);

function adjustmentFromBody(body: Record<string, unknown>): unknown {
  if (body.adjustment !== undefined) {
    if (Object.keys(body).some((key) => adjustmentKeys.has(key))) return undefined;
    return body.adjustment;
  }
  const controls = Object.fromEntries(Object.entries(body).filter(([key]) => adjustmentKeys.has(key)));
  return Object.keys(controls).length > 0 ? controls : undefined;
}

export function createWorkoutAdjustmentHandler(dependencies: {
  readonly resolveSession: ResolveWorkoutRouteSession;
  readonly adjust: (input: {
    readonly predecessorRunId: ReturnType<typeof asWorkoutRunId>;
    readonly predecessorWorkoutVersionId: string;
    readonly coachId: string;
    readonly memberId: string;
    readonly sessionAuthorizationId: string;
    readonly adjustment: unknown;
    readonly idempotencyKey: string;
  }) => Promise<SubmitWorkoutAdjustmentResult>;
}) {
  return async (request: Request, context: WorkoutRouteContext): Promise<Response> => {
    if (!isSameOriginMutation(request)) return jsonResponse({ status: "forbidden" }, 403);
    const session = await dependencies.resolveSession(request);
    if (session.status !== "authorized") return session.status === "unavailable"
      ? jsonResponse({ status: "unavailable" }, 503)
      : jsonResponse({ status: "not-found" }, 404);
    const body = await readJsonObject(request);
    const { runId } = await context.params;
    if (!body || !runId || runId.length > 300
      || typeof body.memberId !== "string" || body.memberId.length > 200
      || typeof body.predecessorWorkoutVersionId !== "string" || body.predecessorWorkoutVersionId.length > 300
      || typeof body.idempotencyKey !== "string" || body.idempotencyKey.length > 200
      || Object.keys(body).some((key) => !requiredKeys.has(key) && key !== "adjustment" && !adjustmentKeys.has(key))) {
      return jsonResponse({ status: "invalid-request" }, 400);
    }
    const adjustment = adjustmentFromBody(body);
    if (adjustment === undefined) return jsonResponse({ status: "invalid-request" }, 400);
    const result = await dependencies.adjust({
      predecessorRunId: asWorkoutRunId(runId),
      predecessorWorkoutVersionId: body.predecessorWorkoutVersionId,
      coachId: session.coachId,
      memberId: body.memberId,
      sessionAuthorizationId: session.authorizationId,
      adjustment,
      idempotencyKey: body.idempotencyKey,
    });
    if (result.status === "created" || result.status === "replayed") {
      return jsonResponse({ ...result, resourceUrl: workoutRunResourceUrl(result.runId, body.memberId) }, result.status === "created" ? 202 : 200);
    }
    if (result.status === "invalid-request") return jsonResponse(result, 400);
    if (result.status === "stale-predecessor" || result.status === "idempotency-conflict") return jsonResponse(result, 409);
    if (result.status === "canonical-state-unavailable") return jsonResponse({ status: "unavailable" }, 503);
    return jsonResponse({ status: "not-found" }, 404);
  };
}

export const POST = createWorkoutAdjustmentHandler({
  resolveSession: configuredWorkoutRouteComposition.resolveSession,
  adjust: configuredWorkoutRouteComposition.adjust!,
});
