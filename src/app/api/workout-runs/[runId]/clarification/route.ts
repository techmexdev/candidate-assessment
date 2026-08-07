import { asWorkoutRunId } from "../../../../../domain/contracts/workout";
import type { AnswerWorkoutClarificationResult } from "../../../../../application/use-cases/answer-workout-clarification";
import { configuredWorkoutRouteComposition } from "../../../../../server/workout-route-composition";
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
    readonly answers?: Readonly<Record<string, unknown>>;
    readonly answer?: string;
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
    const typedAnswers = body && typeof body.answers === "object" && body.answers !== null && !Array.isArray(body.answers)
      ? body.answers as Record<string, unknown>
      : undefined;
    const hasValidTypedAnswers = typedAnswers !== undefined
      && Object.keys(typedAnswers).length > 0
      && Object.keys(typedAnswers).length <= 16
      && Object.values(typedAnswers).every((value) => typeof value === "string" && value.trim().length > 0 && value.length <= 100);
    const hasLegacyAnswer = typeof body?.answer === "string" && body.answer.trim().length > 0 && body.answer.length <= 1_000;
    if (!body || typeof body.memberId !== "string" || (!hasValidTypedAnswers && !hasLegacyAnswer) || !runId) return jsonResponse({ status: "invalid-request" }, 400);
    const result = await dependencies.answer({
      runId: asWorkoutRunId(runId),
      coachId: session.coachId,
      memberId: body.memberId,
      sessionAuthorizationId: session.authorizationId,
      ...(hasValidTypedAnswers ? { answers: typedAnswers } : { answer: body.answer as string }),
    });
    if (result.status === "requeued") return jsonResponse(result, 202);
    if (result.status === "invalid-request") return jsonResponse(result, 400);
    if (result.status === "invalid-state") return jsonResponse(result, 409);
    if (result.status === "unavailable") return jsonResponse(result, 503);
    return jsonResponse({ status: "not-found" }, 404);
  };
}

export const POST = createWorkoutClarificationHandler({
  resolveSession: configuredWorkoutRouteComposition.resolveSession,
  answer: configuredWorkoutRouteComposition.answer,
});
