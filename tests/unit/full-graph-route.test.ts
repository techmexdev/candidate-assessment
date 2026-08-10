import { describe, expect, it, vi } from "vitest";
import { createMemberContextGraphHandler } from "../../src/app/api/member-context/graph/route";
import { createMovementGraphHandler } from "../../src/app/api/movement-graph/route";
import { createRetrieveFullGraph } from "../../src/application/use-cases/retrieve-full-graph";
import type { FullGraphProjection } from "../../src/domain/contracts/full-graph-view";

const movementProjection: FullGraphProjection = {
  domain: "movement-clinical",
  revisionId: "movement:one",
  authority: "canonical",
  counts: { nodes: 1, relationships: 0 },
  nodes: [],
  relationships: [],
};

const authorized = {
  status: "authorized" as const,
  coachId: "coach:one",
  authorizationId: "session:one",
};

function request(path: string): Request {
  return new Request(`https://axon.test${path}`, { headers: { cookie: "coach-session=opaque" } });
}

describe("full graph routes", () => {
  it("requires a session and forwards an optional movement revision", async () => {
    const readMovement = vi.fn(async () => ({ status: "ready" as const, data: movementProjection }));
    const handler = createMovementGraphHandler({
      resolveSession: vi.fn(async () => authorized),
      readMovement,
    });

    const response = await handler(request("/api/movement-graph?revisionId=movement%3Aone&entityId=exercise%3Asquat&entityKind=node"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ status: "ready", data: movementProjection });
    expect(readMovement).toHaveBeenCalledWith({
      revisionId: "movement:one",
      inspection: { entityId: "exercise:squat", entityKind: "node" },
    });
  });

  it("returns 422 when the requested movement entity is absent from the retrieved graph", async () => {
    const retrieve = createRetrieveFullGraph({
      movement: {
        readFullActive: vi.fn(async () => ({ status: "ready" as const, data: movementProjection })),
        readFullRevision: vi.fn(async () => ({ status: "ready" as const, data: movementProjection })),
      },
      memberContext: {
        readFullActive: vi.fn(),
        readFullRevision: vi.fn(),
      },
      authorizeMemberContext: vi.fn(),
    });
    const handler = createMovementGraphHandler({
      resolveSession: vi.fn(async () => authorized),
      readMovement: retrieve.readMovement,
    });

    const response = await handler(request("/api/movement-graph?entityId=exercise%3Amissing&entityKind=node"));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      status: "invalid",
      domain: "movement-clinical",
      message: "Movement graph failed integrity validation.",
    });
  });

  it("forwards bounded page coordinates without changing the legacy full-read shape", async () => {
    const readMovement = vi.fn(async () => ({ status: "ready" as const, data: movementProjection }));
    const handler = createMovementGraphHandler({
      resolveSession: vi.fn(async () => authorized),
      readMovement,
    });

    const response = await handler(request("/api/movement-graph?pageSize=24&nodeOffset=24&relationshipOffset=24"));

    expect(response.status).toBe(200);
    expect(readMovement).toHaveBeenCalledWith({
      page: { pageSize: 24, nodeOffset: 24, relationshipOffset: 24 },
    });
  });

  it("does not reveal whether an unauthenticated movement graph exists", async () => {
    const readMovement = vi.fn();
    const handler = createMovementGraphHandler({
      resolveSession: vi.fn(async () => ({ status: "unauthorized" as const })),
      readMovement,
    });

    const response = await handler(request("/api/movement-graph"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      status: "denied",
      domain: "movement-clinical",
      message: "Movement graph is unavailable.",
    });
    expect(readMovement).not.toHaveBeenCalled();
  });

  it("keeps member authorization and read errors non-enumerating", async () => {
    const readMemberContext = vi.fn(async () => ({
      status: "empty" as const,
      domain: "member-context" as const,
      message: "not found",
    }));
    const handler = createMemberContextGraphHandler({
      resolveSession: vi.fn(async () => authorized),
      readMemberContext,
    });

    const response = await handler(request("/api/member-context/graph?memberId=member%3Aother"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      status: "denied",
      domain: "member-context",
      message: "Member context is unavailable.",
    });
    expect(readMemberContext).toHaveBeenCalledWith({
      coachId: "coach:one",
      memberId: "member:other",
      authorizationId: "session:one",
    });
  });

  it("passes the member revision pin and inspection and surfaces stale as a conflict", async () => {
    const readMemberContext = vi.fn(async () => ({
      status: "stale" as const,
      domain: "member-context" as const,
      requestedRevisionId: "context:old",
      activeRevisionId: "context:new",
    }));
    const handler = createMemberContextGraphHandler({
      resolveSession: vi.fn(async () => authorized),
      readMemberContext,
    });

    const response = await handler(request("/api/member-context/graph?memberId=member%3Aone&contextRevisionId=context%3Aold&entityId=assertion%3Aone&entityKind=node"));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      status: "stale",
      domain: "member-context",
      requestedRevisionId: "context:old",
      activeRevisionId: "context:new",
    });
    expect(readMemberContext).toHaveBeenCalledWith({
      coachId: "coach:one",
      memberId: "member:one",
      authorizationId: "session:one",
      contextRevisionId: "context:old",
      inspection: { entityId: "assertion:one", entityKind: "node" },
    });
  });

  it("rejects malformed member requests before the provider", async () => {
    const readMemberContext = vi.fn();
    const handler = createMemberContextGraphHandler({
      resolveSession: vi.fn(async () => authorized),
      readMemberContext,
    });

    const response = await handler(request("/api/member-context/graph?memberId="));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      status: "invalid",
      domain: "member-context",
      message: "Invalid member context graph request.",
    });
    expect(readMemberContext).not.toHaveBeenCalled();
  });

  it("rejects an incomplete entity inspection request before the provider", async () => {
    const readMovement = vi.fn();
    const handler = createMovementGraphHandler({
      resolveSession: vi.fn(async () => authorized),
      readMovement,
    });

    const response = await handler(request("/api/movement-graph?entityId=exercise%3Asquat"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      status: "invalid",
      domain: "movement-clinical",
      message: "Invalid movement graph request.",
    });
    expect(readMovement).not.toHaveBeenCalled();
  });
});
