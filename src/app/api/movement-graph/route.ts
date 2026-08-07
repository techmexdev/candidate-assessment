import type { FullGraphReadResult } from "../../../domain/contracts/full-graph-view";
import { configuredWorkoutRouteComposition } from "../../../server/workout-route-composition";

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

function invalidResult(): FullGraphReadResult {
  return { status: "invalid", domain: "movement-clinical", message: "Invalid movement graph request." };
}

function unavailableResult(): FullGraphReadResult {
  return { status: "unavailable", domain: "movement-clinical", message: "Movement graph is unavailable." };
}

function externalResult(result: FullGraphReadResult): { readonly body: FullGraphReadResult; readonly status: number } {
  switch (result.status) {
    case "ready": return { body: result, status: 200 };
    case "stale": return { body: result, status: 409 };
    case "invalid": return { body: { ...result, message: "Movement graph failed integrity validation." }, status: 422 };
    case "empty":
    case "denied": return { body: { status: "denied", domain: "movement-clinical", message: "Movement graph is unavailable." }, status: 404 };
    case "unavailable": return { body: unavailableResult(), status: 503 };
  }
}

export function createMovementGraphHandler(dependencies: {
  readonly resolveSession: (request: Request) => Promise<Session>;
  readonly readMovement: (input?: { readonly revisionId?: string }) => Promise<FullGraphReadResult>;
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
        session.status === "unavailable"
          ? unavailableResult()
          : { status: "denied", domain: "movement-clinical", message: "Movement graph is unavailable." },
        session.status === "unavailable" ? 503 : 404,
      );
    }

    const revisionId = new URL(request.url).searchParams.get("revisionId");
    if (revisionId !== null && (revisionId.length === 0 || revisionId.length > 200)) {
      return response(invalidResult(), 400);
    }
    try {
      const result = await dependencies.readMovement(revisionId === null ? undefined : { revisionId });
      const external = externalResult(result);
      return response(external.body, external.status);
    } catch {
      return response(unavailableResult(), 503);
    }
  };
}

export const GET = createMovementGraphHandler({
  resolveSession: configuredWorkoutRouteComposition.resolveSession,
  readMovement: (input) => configuredWorkoutRouteComposition.fullGraph
    ? configuredWorkoutRouteComposition.fullGraph.readMovement(input)
    : Promise.resolve(unavailableResult()),
});
