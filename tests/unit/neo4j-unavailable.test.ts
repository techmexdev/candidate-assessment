import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createNeo4jClient, type Neo4jClient } from "../../src/graph/neo4j/client";
import { createNeo4jMovementGraphReadProvider } from "../../src/graph/repositories/neo4j-movement-graph";

const TEST_DRIVER_TIMEOUTS = Object.freeze({
  connectionMs: 50,
  connectionAcquisitionMs: 100,
  maxTransactionRetryMs: 50,
});

describe("Neo4j outage handling", () => {
  const sockets = new Set<Socket>();
  let client: Neo4jClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  });

  it("returns graph_unavailable within the configured bound when Bolt never responds", async () => {
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test address");
      client = createNeo4jClient({
        uri: `bolt://127.0.0.1:${address.port}`,
        username: "neo4j",
        password: "test",
        environment: "test",
        driverTimeouts: TEST_DRIVER_TIMEOUTS,
      });
      const provider = createNeo4jMovementGraphReadProvider(client);
      const startedAt = performance.now();

      const result = await provider.openActive();
      const elapsedMs = performance.now() - startedAt;

      expect(result).toMatchObject({
        status: "unavailable",
        failure: { code: "graph_unavailable" },
      });
      expect(elapsedMs).toBeLessThan(TEST_DRIVER_TIMEOUTS.connectionAcquisitionMs + 1_000);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        for (const socket of sockets) socket.destroy();
      });
    }
  }, TEST_DRIVER_TIMEOUTS.connectionAcquisitionMs + 2_000);
});
