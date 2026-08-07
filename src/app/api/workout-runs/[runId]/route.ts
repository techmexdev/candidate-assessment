import { asWorkoutRunId } from "../../../../domain/contracts/workout";
import type { CancelWorkoutRunResult } from "../../../../application/use-cases/cancel-workout-run";
import type { RetrieveWorkoutRunResult } from "../../../../application/use-cases/retrieve-workout-run";
import { configuredWorkoutRouteComposition } from "../../../../server/workout-route-composition";
import {
  isSameOriginMutation,
  jsonResponse,
  type ResolveWorkoutRouteSession,
  type WorkoutRouteContext,
} from "../route";

export function createWorkoutRunResourceHandlers(dependencies: {
  readonly resolveSession: ResolveWorkoutRouteSession;
  readonly retrieve: (input: { readonly runId: ReturnType<typeof asWorkoutRunId>; readonly coachId: string; readonly memberId: string }) => Promise<RetrieveWorkoutRunResult>;
  readonly cancel: (input: { readonly runId: ReturnType<typeof asWorkoutRunId>; readonly coachId: string; readonly memberId: string }) => Promise<CancelWorkoutRunResult>;
}) {
  const authorizeRequest = async (request: Request, context: WorkoutRouteContext) => {
    const session = await dependencies.resolveSession(request);
    if (session.status !== "authorized") return { response: session.status === "unavailable" ? jsonResponse({ status: "unavailable" }, 503) : jsonResponse({ status: "not-found" }, 404) } as const;
    const memberId = new URL(request.url).searchParams.get("memberId");
    const { runId } = await context.params;
    if (!memberId || !runId || memberId.length > 200 || runId.length > 300) return { response: jsonResponse({ status: "not-found" }, 404) } as const;
    return { session, memberId, runId: asWorkoutRunId(runId) } as const;
  };

  return {
    async GET(request: Request, context: WorkoutRouteContext): Promise<Response> {
      const access = await authorizeRequest(request, context);
      if ("response" in access && access.response) return access.response;
      const result = await dependencies.retrieve({ runId: access.runId, coachId: access.session.coachId, memberId: access.memberId });
      if (result.status === "ready") return jsonResponse(result.resource, 200);
      return jsonResponse({ status: result.status === "integrity-failure" ? "unavailable" : "not-found" }, result.status === "integrity-failure" ? 409 : 404);
    },
    async DELETE(request: Request, context: WorkoutRouteContext): Promise<Response> {
      if (!isSameOriginMutation(request)) return jsonResponse({ status: "forbidden" }, 403);
      const access = await authorizeRequest(request, context);
      if ("response" in access && access.response) return access.response;
      const result = await dependencies.cancel({ runId: access.runId, coachId: access.session.coachId, memberId: access.memberId });
      if (result.status === "canceled") return jsonResponse(result, 202);
      if (result.status === "already_completed") return jsonResponse(result, 409);
      if (result.status === "already-terminal") return jsonResponse(result, 200);
      return jsonResponse({ status: "not-found" }, 404);
    },
  };
}

const configured = createWorkoutRunResourceHandlers({
  resolveSession: configuredWorkoutRouteComposition.resolveSession,
  retrieve: configuredWorkoutRouteComposition.retrieve,
  cancel: configuredWorkoutRouteComposition.cancel,
});
export const GET = configured.GET;
export const DELETE = configured.DELETE;
