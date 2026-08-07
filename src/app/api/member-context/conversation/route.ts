import type { RetrieveMemberConversationResult } from "../../../../application/use-cases/retrieve-member-conversation";
import { configuredWorkoutRouteComposition } from "../../../../server/workout-route-composition";

type Session = Awaited<ReturnType<typeof configuredWorkoutRouteComposition.resolveSession>>;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      vary: "cookie",
    },
  });
}

function invalidDate(value: string | null): boolean {
  return !value || !Number.isFinite(Date.parse(value));
}

export function createMemberConversationHandler(dependencies: {
  readonly resolveSession: (request: Request) => Promise<Session>;
  readonly conversation: (input: {
    readonly coachId: string;
    readonly memberId: string;
    readonly sessionAuthorizationId: string;
    readonly contextRevisionId?: string;
    readonly conversationId?: string;
    readonly fromInclusive: string;
    readonly toExclusive: string;
    readonly cursor?: string;
  }) => Promise<RetrieveMemberConversationResult>;
}) {
  return async (request: Request): Promise<Response> => {
    const session = await dependencies.resolveSession(request);
    if (session.status !== "authorized") return response({ status: session.status === "unavailable" ? "unavailable" : "not-found" }, session.status === "unavailable" ? 503 : 404);
    const params = new URL(request.url).searchParams;
    const memberId = params.get("memberId");
    const fromInclusive = params.get("from");
    const toExclusive = params.get("to");
    if (!memberId || memberId.length > 200 || invalidDate(fromInclusive) || invalidDate(toExclusive)
      || Date.parse(fromInclusive!) >= Date.parse(toExclusive!)) return response({ status: "not-found" }, 404);
    const result = await dependencies.conversation({
      coachId: session.coachId,
      memberId,
      sessionAuthorizationId: session.authorizationId,
      ...(params.get("contextRevisionId") ? { contextRevisionId: params.get("contextRevisionId")! } : {}),
      ...(params.get("conversationId") ? { conversationId: params.get("conversationId")! } : {}),
      fromInclusive: fromInclusive!,
      toExclusive: toExclusive!,
      ...(params.get("cursor") ? { cursor: params.get("cursor")! } : {}),
    });
    if (result.status === "ready") return response(result);
    if (result.status === "invalid") return response({ status: "not-found" }, 404);
    if (result.status === "denied" || result.status === "empty" || result.status === "stale") return response({ status: "not-found" }, 404);
    return response({ status: "unavailable" }, 503);
  };
}

export const GET = createMemberConversationHandler({
  resolveSession: configuredWorkoutRouteComposition.resolveSession,
  conversation: configuredWorkoutRouteComposition.conversation!,
});
