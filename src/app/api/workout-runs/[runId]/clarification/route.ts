import { asWorkoutRunId } from "../../../../../domain/contracts/workout";
import type { AnswerWorkoutClarificationResult } from "../../../../../application/use-cases/answer-workout-clarification";
import {
  isSameOriginMutation,
  jsonResponse,
  readJsonObject,
  type ResolveWorkoutRouteSession,
  type WorkoutRouteContext,
} from "../../route";

export function createWorkoutClarificationHandler(dependencies: {
  readonly resolveSession: ResolveWorkoutRouteSession;
  readonly answer: (input: {
    readonly runId: ReturnType<typeof asWorkoutRunId>;
    readonly coachId: string;
    readonly memberId: string;
    readonly sessionAuthorizationId: string;
    readonly answer: string;
  }) => Promise<AnswerWorkoutClarificationResult>;
}) {
  return async (request: Request, context: WorkoutRouteContext): Promise<Response> => {
    if (!isSameOriginMutation(request)) return jsonResponse({ status: "forbidden" }, 403);
    const session = await dependencies.resolveSession(request);
    if (session.status !== "authorized") return session.status === "unavailable"
      ? jsonResponse({ status: "unavailable" }, 503)
      : jsonResponse({ status: "not-found" }, 404);
    const body = await readJsonObject(request);
    const { runId } = await context.params;
    if (!body || typeof body.memberId !== "string" || typeof body.answer !== "string" || !runId) return jsonResponse({ status: "invalid-request" }, 400);
    const result = await dependencies.answer({
      runId: asWorkoutRunId(runId),
      coachId: session.coachId,
      memberId: body.memberId,
      sessionAuthorizationId: session.authorizationId,
      answer: body.answer,
    });
    if (result.status === "requeued") return jsonResponse(result, 202);
    if (result.status === "invalid-request") return jsonResponse(result, 400);
    if (result.status === "invalid-state") return jsonResponse(result, 409);
    if (result.status === "unavailable") return jsonResponse(result, 503);
    return jsonResponse({ status: "not-found" }, 404);
  };
}

export const POST = createWorkoutClarificationHandler({
  resolveSession: async () => ({ status: "unavailable" }),
  answer: async () => ({ status: "not-found" }),
});
