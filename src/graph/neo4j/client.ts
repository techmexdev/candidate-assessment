import neo4j, { type BookmarkManager, type Driver, type ManagedTransaction } from "neo4j-driver";

export const LOCAL_NEO4J_DEFAULTS = Object.freeze({
  uri: "neo4j://127.0.0.1:7687",
  username: "neo4j",
  password: "movement-graph-local-test",
  database: "neo4j",
});

/**
 * Driver-level guardrails for schema and publication transactions. Member
 * retrieval applies its stricter, query-specific 5 second maximum separately.
 */
export const NEO4J_TRANSACTION_TIMEOUTS = Object.freeze({
  defaultMs: 30_000,
  maxMs: 120_000,
});

export type Neo4jClientConfig = {
  readonly uri?: string;
  readonly username?: string;
  readonly password?: string;
  readonly database?: string;
  readonly environment?: string;
};

export type Neo4jRecord = { readonly get: (key: string) => unknown };
export type Neo4jQueryResult = { readonly records: readonly Neo4jRecord[] };
export type Neo4jTransaction = {
  readonly run: (query: string, parameters?: Readonly<Record<string, unknown>>) => Promise<Neo4jQueryResult>;
};
export type Neo4jExecutionOptions = { readonly timeoutMs?: number };
export type Neo4jClient = {
  readonly executeRead: <T>(work: (transaction: Neo4jTransaction) => Promise<T>, options?: Neo4jExecutionOptions) => Promise<T>;
  readonly executeWrite: <T>(work: (transaction: Neo4jTransaction) => Promise<T>, options?: Neo4jExecutionOptions) => Promise<T>;
  readonly verifyConnectivity: () => Promise<void>;
  readonly close: () => Promise<void>;
};

function isLocalHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function resolveTransactionTimeout(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? NEO4J_TRANSACTION_TIMEOUTS.defaultMs;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > NEO4J_TRANSACTION_TIMEOUTS.maxMs) {
    throw new Error(
      `Neo4j transaction timeout must be an integer between 1 and ${NEO4J_TRANSACTION_TIMEOUTS.maxMs} milliseconds`,
    );
  }
  return resolved;
}

function resolvedConfig(config: Neo4jClientConfig) {
  const environment = config.environment ?? process.env.NODE_ENV ?? "production";
  const allowsSyntheticDefaults = ["test", "development", "local"].includes(environment);
  const uri = config.uri ?? (allowsSyntheticDefaults ? LOCAL_NEO4J_DEFAULTS.uri : undefined);
  const username = config.username ?? (allowsSyntheticDefaults ? LOCAL_NEO4J_DEFAULTS.username : undefined);
  const password = config.password ?? (allowsSyntheticDefaults ? LOCAL_NEO4J_DEFAULTS.password : undefined);
  const database = config.database ?? LOCAL_NEO4J_DEFAULTS.database;
  if (!uri || !username || !password) throw new Error("Neo4j credentials and URI must be explicitly configured outside test/local environments");
  if (!allowsSyntheticDefaults && password === LOCAL_NEO4J_DEFAULTS.password) throw new Error("Synthetic local Neo4j credentials are forbidden outside test/local environments");

  let parsed: URL;
  try { parsed = new URL(uri); } catch { throw new Error("Neo4j URI is invalid"); }
  if (!isLocalHost(parsed.hostname) && !["neo4j+s:", "bolt+s:"].includes(parsed.protocol)) {
    throw new Error("Non-local Neo4j hosts require an encrypted neo4j+s or bolt+s URI");
  }
  return { uri, username, password, database };
}

class DriverNeo4jClient implements Neo4jClient {
  constructor(
    private readonly driver: Driver,
    private readonly database: string,
    private readonly bookmarks: BookmarkManager,
  ) {}

  private async withSession<T>(
    mode: "read" | "write",
    work: (transaction: Neo4jTransaction) => Promise<T>,
    options: Neo4jExecutionOptions = {},
  ) {
    const timeout = resolveTransactionTimeout(options.timeoutMs);
    const session = this.driver.session({
      database: this.database,
      defaultAccessMode: mode === "read" ? neo4j.session.READ : neo4j.session.WRITE,
      bookmarkManager: this.bookmarks,
    });
    try {
      const callback = (transaction: ManagedTransaction) => work(transaction as unknown as Neo4jTransaction);
      const transactionConfig = { timeout };
      return mode === "read"
        ? await session.executeRead(callback, transactionConfig)
        : await session.executeWrite(callback, transactionConfig);
    } finally {
      await session.close();
    }
  }

  executeRead<T>(work: (transaction: Neo4jTransaction) => Promise<T>, options?: Neo4jExecutionOptions) { return this.withSession("read", work, options); }
  executeWrite<T>(work: (transaction: Neo4jTransaction) => Promise<T>, options?: Neo4jExecutionOptions) { return this.withSession("write", work, options); }
  async verifyConnectivity() { await this.driver.verifyConnectivity(); }
  async close() { await this.driver.close(); }
}

export function createNeo4jClient(config: Neo4jClientConfig = {}): Neo4jClient {
  const resolved = resolvedConfig(config);
  const driver = neo4j.driver(resolved.uri, neo4j.auth.basic(resolved.username, resolved.password), {
    disableLosslessIntegers: true,
  });
  return new DriverNeo4jClient(driver, resolved.database, neo4j.bookmarkManager());
}
