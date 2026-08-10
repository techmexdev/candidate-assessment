import type {
  FullGraphReadResult,
} from "../../../domain/contracts/full-graph-view";
import type { RetrieveFullGraph } from "../../../application/use-cases/retrieve-full-graph";
import { parseFullGraphQueryParams } from "../full-graph-query";
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
  readonly readMovement: RetrieveFullGraph["readMovement"];
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

    const params = new URL(request.url).searchParams;
    const revisionId = params.get("revisionId");
    if (revisionId !== null && (revisionId.length === 0 || revisionId.length > 200)) {
      return response(invalidResult(), 400);
    }
    const query = parseFullGraphQueryParams(params);
    if (!query) return response(invalidResult(), 400);
    try {
      const result = await dependencies.readMovement({
        ...(revisionId === null ? {} : { revisionId }),
        ...(query.entityId === undefined ? {} : {
          inspection: { entityId: query.entityId, entityKind: query.entityKind },
        }),
        ...(query.page === undefined ? {} : { page: query.page }),
      });
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
