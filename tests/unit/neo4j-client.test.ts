import { beforeEach, describe, expect, it, vi } from "vitest";

const driverMocks = vi.hoisted(() => {
  const transaction = { run: vi.fn() };
  const executeRead = vi.fn(async (work: (value: typeof transaction) => Promise<unknown>) => work(transaction));
  const executeWrite = vi.fn(async (work: (value: typeof transaction) => Promise<unknown>) => work(transaction));
  const sessionClose = vi.fn(async () => undefined);
  const session = vi.fn(() => ({ executeRead, executeWrite, close: sessionClose }));
  const verifyConnectivity = vi.fn(async () => undefined);
  const driverClose = vi.fn(async () => undefined);
  const driver = vi.fn(() => ({ session, verifyConnectivity, close: driverClose }));

  return {
    authBasic: vi.fn(() => ({ token: "test" })),
    bookmarkManager: vi.fn(() => ({ kind: "bookmarks" })),
    driver,
    driverClose,
    executeRead,
    executeWrite,
    session,
    sessionClose,
    transaction,
    verifyConnectivity,
  };
});

vi.mock("neo4j-driver", () => ({
  default: {
    auth: { basic: driverMocks.authBasic },
    bookmarkManager: driverMocks.bookmarkManager,
    driver: driverMocks.driver,
    session: { READ: "READ", WRITE: "WRITE" },
  },
}));

import {
  createNeo4jClient,
  NEO4J_DRIVER_TIMEOUTS,
  NEO4J_TRANSACTION_TIMEOUTS,
} from "../../src/graph/neo4j/client";

describe("Neo4j client transaction timeouts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies the bounded publication-safe default to every managed transaction", async () => {
    const client = createNeo4jClient({ environment: "test" });

    expect(driverMocks.driver).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      {
        disableLosslessIntegers: true,
        connectionTimeout: NEO4J_DRIVER_TIMEOUTS.connectionMs,
        connectionAcquisitionTimeout: NEO4J_DRIVER_TIMEOUTS.connectionAcquisitionMs,
        maxTransactionRetryTime: NEO4J_DRIVER_TIMEOUTS.maxTransactionRetryMs,
      },
    );

    await expect(client.executeWrite(async () => "written")).resolves.toBe("written");
    await expect(client.executeRead(async () => "read")).resolves.toBe("read");

    expect(driverMocks.executeWrite).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: NEO4J_TRANSACTION_TIMEOUTS.defaultMs },
    );
    expect(driverMocks.executeRead).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: NEO4J_TRANSACTION_TIMEOUTS.defaultMs },
    );
  });

  it("passes a valid explicit timeout override to the driver", async () => {
    const client = createNeo4jClient({ environment: "test" });

    await client.executeWrite(async () => undefined, { timeoutMs: 5_000 });

    expect(driverMocks.executeWrite).toHaveBeenCalledWith(expect.any(Function), { timeout: 5_000 });
  });

  it("passes validated driver timeout overrides to the driver", () => {
    const driverTimeouts = {
      connectionMs: 50,
      connectionAcquisitionMs: 100,
      maxTransactionRetryMs: 50,
    };

    createNeo4jClient({ environment: "test", driverTimeouts });

    expect(driverMocks.driver).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        connectionTimeout: driverTimeouts.connectionMs,
        connectionAcquisitionTimeout: driverTimeouts.connectionAcquisitionMs,
        maxTransactionRetryTime: driverTimeouts.maxTransactionRetryMs,
      }),
    );
  });

  it("rejects invalid driver timeout overrides before creating the driver", () => {
    expect(() => createNeo4jClient({
      environment: "test",
      driverTimeouts: { connectionMs: 100, connectionAcquisitionMs: 50 },
    })).toThrow(/acquisition timeout/i);

    expect(driverMocks.driver).not.toHaveBeenCalled();
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["non-integer", 1.5],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["above the client maximum", NEO4J_TRANSACTION_TIMEOUTS.maxMs + 1],
  ])("rejects a %s override before opening a session", async (_label, timeoutMs) => {
    const client = createNeo4jClient({ environment: "test" });
    const work = vi.fn(async () => undefined);

    await expect(client.executeWrite(work, { timeoutMs })).rejects.toThrow(/transaction timeout/i);

    expect(driverMocks.session).not.toHaveBeenCalled();
    expect(driverMocks.executeWrite).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });
});
