import type { FullGraphReadResult } from "../../../../domain/contracts/full-graph-view";
import { configuredWorkoutRouteComposition } from "../../../../server/workout-route-composition";

type Session = Awaited<ReturnType<typeof configuredWorkoutRouteComposition.resolveSession>>;

const noStoreHeaders = {
  "cache-control": "private, no-store, max-age=0",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
  vary: "cookie",
} as const;

function response(value: unknown, status: number): Response {
  return Response.json(value, { status, headers: noStoreHeaders });
}

function deniedResult(): FullGraphReadResult {
  return { status: "denied", domain: "member-context", message: "Member context is unavailable." };
}

function unavailableResult(): FullGraphReadResult {
  return { status: "unavailable", domain: "member-context", message: "Member context is unavailable." };
}

function invalidResult(): FullGraphReadResult {
  return { status: "invalid", domain: "member-context", message: "Invalid member context graph request." };
}

function externalResult(result: FullGraphReadResult): { readonly body: FullGraphReadResult; readonly status: number } {
  switch (result.status) {
    case "ready": return { body: result, status: 200 };
    case "stale": return { body: result, status: 409 };
    case "invalid": return { body: { ...result, message: "Member context failed integrity validation." }, status: 422 };
    case "empty":
    case "denied": return { body: deniedResult(), status: 404 };
    case "unavailable": return { body: unavailableResult(), status: 503 };
  }
}

export function createMemberContextGraphHandler(dependencies: {
  readonly resolveSession: (request: Request) => Promise<Session>;
  readonly readMemberContext: (input: {
    readonly coachId: string;
    readonly memberId: string;
    readonly authorizationId: string;
    readonly contextRevisionId?: string;
  }) => Promise<FullGraphReadResult>;
}) {
  return async (request: Request): Promise<Response> => {
    let session: Session;
    try {
      session = await dependencies.resolveSession(request);
    } catch {
      return response(unavailableResult(), 503);
    }
    if (session.status !== "authorized") {
      return response(
        session.status === "unavailable" ? unavailableResult() : deniedResult(),
        session.status === "unavailable" ? 503 : 404,
      );
    }

    const params = new URL(request.url).searchParams;
    const memberId = params.get("memberId");
    const contextRevisionId = params.get("contextRevisionId");
    if (!memberId || memberId.length > 200
      || (contextRevisionId !== null && (contextRevisionId.length === 0 || contextRevisionId.length > 200))) {
      return response(invalidResult(), 400);
    }
    try {
      const result = await dependencies.readMemberContext({
        coachId: session.coachId,
        memberId,
        authorizationId: session.authorizationId,
        ...(contextRevisionId === null ? {} : { contextRevisionId }),
      });
      const external = externalResult(result);
      return response(external.body, external.status);
    } catch {
      return response(unavailableResult(), 503);
    }
  };
}

export const GET = createMemberContextGraphHandler({
  resolveSession: configuredWorkoutRouteComposition.resolveSession,
  readMemberContext: (input) => configuredWorkoutRouteComposition.fullGraph
    ? configuredWorkoutRouteComposition.fullGraph.readMemberContext(input)
    : Promise.resolve(unavailableResult()),
});
