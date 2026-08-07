import { describe, expect, it, vi } from "vitest";
import { inspectAuthorizedMemberContextScope } from "../../src/application/use-cases/retrieve-member-context";
import { createRetrieveFullGraph } from "../../src/application/use-cases/retrieve-full-graph";
import type { FullGraphProjection } from "../../src/domain/contracts/full-graph-view";
import type { AuthorizedMemberContextScope } from "../../src/domain/contracts/member-context-queries";

const projection: FullGraphProjection = {
  domain: "member-context",
  revisionId: "context:one",
  memberId: "member:one",
  authority: "canonical",
  counts: { nodes: 1, relationships: 0 },
  nodes: [],
  relationships: [],
};

const movementProjection: FullGraphProjection = {
  domain: "movement-clinical",
  revisionId: "movement:one",
  authority: "canonical",
  counts: { nodes: 1, relationships: 0 },
  nodes: [],
  relationships: [],
};

const movementUnavailable = {
  status: "unavailable" as const,
  domain: "movement-clinical" as const,
  message: "Movement graph is unavailable.",
};

const memberUnavailable = {
  status: "unavailable" as const,
  domain: "member-context" as const,
  message: "Member context is unavailable.",
};

describe("retrieve full graph", () => {
  it("reauthorizes and mints an opaque scope for every member snapshot read", async () => {
    const authorize = vi.fn(async () => true);
    const readFullActive = vi.fn(async (scope: AuthorizedMemberContextScope) => {
      expect(inspectAuthorizedMemberContextScope(scope)).toEqual({
        coachId: "coach:one",
        memberId: "member:one",
        authorizationId: "session:one",
      });
      return { status: "ready" as const, data: projection };
    });
    const provider = {
      movement: {
        readFullActive: vi.fn(async () => ({ status: "ready" as const, data: movementProjection })),
        readFullRevision: vi.fn(async () => ({ status: "ready" as const, data: movementProjection })),
      },
      memberContext: {
        readFullActive,
        readFullRevision: vi.fn(async () => ({ status: "ready" as const, data: projection })),
      },
    };
    const retrieve = createRetrieveFullGraph({
      ...provider,
      authorizeMemberContext: authorize,
    });

    const first = await retrieve.readMemberContext({ coachId: "coach:one", memberId: "member:one", authorizationId: "session:one" });
    const second = await retrieve.readMemberContext({ coachId: "coach:one", memberId: "member:one", authorizationId: "session:one" });

    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(readFullActive).toHaveBeenCalledTimes(2);
    expect(readFullActive.mock.calls[0]?.[0]).not.toBe(readFullActive.mock.calls[1]?.[0]);
  });

  it("fails closed before touching the member provider when authorization is denied", async () => {
    const readFullActive = vi.fn();
    const retrieve = createRetrieveFullGraph({
      movement: {
        readFullActive: vi.fn(async () => movementUnavailable),
        readFullRevision: vi.fn(async () => movementUnavailable),
      },
      memberContext: {
        readFullActive,
        readFullRevision: vi.fn(async () => memberUnavailable),
      },
      authorizeMemberContext: vi.fn(async () => false),
    });

    await expect(retrieve.readMemberContext({
      coachId: "coach:one",
      memberId: "member:other",
      authorizationId: "session:one",
    })).resolves.toEqual({
      status: "denied",
      domain: "member-context",
      message: "Member context is unavailable.",
    });
    expect(readFullActive).not.toHaveBeenCalled();
  });

  it("selects the requested movement revision and maps provider failures to unavailable", async () => {
    const readFullRevision = vi.fn(async () => ({ status: "ready" as const, data: movementProjection }));
    const retrieve = createRetrieveFullGraph({
      movement: {
        readFullActive: vi.fn(async () => { throw new Error("neo4j down"); }),
        readFullRevision,
      },
      memberContext: {
        readFullActive: vi.fn(async () => memberUnavailable),
        readFullRevision: vi.fn(async () => memberUnavailable),
      },
      authorizeMemberContext: vi.fn(),
    });

    await expect(retrieve.readMovement({ revisionId: "movement:one" })).resolves.toEqual({ status: "ready", data: movementProjection });
    await expect(retrieve.readMovement()).resolves.toEqual({
      status: "unavailable",
      domain: "movement-clinical",
      message: "Movement graph is unavailable.",
    });
    expect(readFullRevision).toHaveBeenCalledWith("movement:one");
  });
});
