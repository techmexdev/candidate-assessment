import { asWorkoutRunId } from "../../../../../domain/contracts/workout";
import type { ReplayWorkoutRunEventsResult } from "../../../../../application/use-cases/retrieve-workout-run";
import { configuredWorkoutRouteComposition } from "../../../../../server/workout-route-composition";
import { jsonResponse, noStoreHeaders, workoutRunResourceUrl, type ResolveWorkoutRouteSession, type WorkoutRouteContext } from "../../route";

export function createWorkoutRunEventsHandler(dependencies: {
  readonly resolveSession: ResolveWorkoutRouteSession;
  readonly replay: (input: {
    readonly runId: ReturnType<typeof asWorkoutRunId>;
    readonly coachId: string;
    readonly memberId: string;
    readonly sessionAuthorizationId: string;
    readonly cursor?: string;
    readonly limit?: number;
  }) => Promise<ReplayWorkoutRunEventsResult>;
}) {
  return async (request: Request, context: WorkoutRouteContext): Promise<Response> => {
    const session = await dependencies.resolveSession(request);
    if (session.status !== "authorized") return session.status === "unavailable"
      ? jsonResponse({ status: "unavailable" }, 503)
      : jsonResponse({ status: "not-found" }, 404);
    const url = new URL(request.url);
    const memberId = url.searchParams.get("memberId");
    const { runId } = await context.params;
    if (!memberId || !runId || memberId.length > 200 || runId.length > 300) return jsonResponse({ status: "not-found" }, 404);
    const cursor = request.headers.get("last-event-id") ?? url.searchParams.get("cursor") ?? undefined;
    const result = await dependencies.replay({
      runId: asWorkoutRunId(runId),
      coachId: session.coachId,
      memberId,
      sessionAuthorizationId: session.authorizationId,
      ...(cursor ? { cursor } : {}),
    });
    if (result.status === "resync_required") {
      return jsonResponse({ status: result.status, snapshotUrl: workoutRunResourceUrl(runId, memberId) }, 409);
    }
    if (result.status === "not-found") return jsonResponse({ status: "not-found" }, 404);
    const body = result.events.map(({ event, cursor: eventCursor }) => [
      `id: ${eventCursor}`,
      `event: ${event.kind}`,
      `data: ${JSON.stringify({
        eventId: event.eventId,
        runId: event.runId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        ...event.safeData,
      })}`,
      "",
    ].join("\n")).join("\n");
    return new Response(body, {
      status: 200,
      headers: {
        ...noStoreHeaders,
        "content-type": "text/event-stream; charset=utf-8",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  };
}

export const GET = createWorkoutRunEventsHandler({
  resolveSession: configuredWorkoutRouteComposition.resolveSession,
  replay: configuredWorkoutRouteComposition.replay,
});
