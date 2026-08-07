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

/**
 * Fail-fast driver limits for the local-first graph service. These bound the
 * time spent connecting, waiting for a pooled connection, and retrying a
 * managed transaction before repository adapters return an unavailable result.
 */
export type Neo4jDriverTimeouts = {
  readonly connectionMs: number;
  readonly connectionAcquisitionMs: number;
  readonly maxTransactionRetryMs: number;
};

export const NEO4J_DRIVER_TIMEOUTS: Neo4jDriverTimeouts = Object.freeze({
  connectionMs: 5_000,
  connectionAcquisitionMs: 10_000,
  maxTransactionRetryMs: 5_000,
});

export type Neo4jClientConfig = {
  readonly uri?: string;
  readonly username?: string;
  readonly password?: string;
  readonly database?: string;
  readonly environment?: string;
  readonly driverTimeouts?: Partial<Neo4jDriverTimeouts>;
};

export type Neo4jRecord = { readonly get: (key: string) => unknown };
export type Neo4jQueryResult = { readonly records: readonly Neo4jRecord[] };
export type Neo4jTransaction = {
  readonly run: (query: string, parameters?: Readonly<Record<string, unknown>>) => Promise<Neo4jQueryResult>;
};
export type Neo4jExecutionOptions = { readonly timeoutMs?: number; readonly signal?: AbortSignal };
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

function resolveDriverTimeouts(overrides: Partial<Neo4jDriverTimeouts> | undefined): Neo4jDriverTimeouts {
  const resolved = { ...NEO4J_DRIVER_TIMEOUTS, ...overrides };
  for (const [name, timeoutMs] of Object.entries(resolved)) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error(`Neo4j driver ${name} must be a positive integer number of milliseconds`);
    }
  }
  if (resolved.connectionAcquisitionMs < resolved.connectionMs) {
    throw new Error("Neo4j connection acquisition timeout must be at least the connection timeout");
  }
  return Object.freeze(resolved);
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
  return { uri, username, password, database, driverTimeouts: resolveDriverTimeouts(config.driverTimeouts) };
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
    options.signal?.throwIfAborted();
    const session = this.driver.session({
      database: this.database,
      defaultAccessMode: mode === "read" ? neo4j.session.READ : neo4j.session.WRITE,
      bookmarkManager: this.bookmarks,
    });
    let aborted = false;
    let abortReason: unknown;
    let closePromise: Promise<void> | undefined;
    const closeSession = () => closePromise ??= session.close();
    let rejectAborted!: (reason?: unknown) => void;
    const abortedExecution = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
    const abort = () => {
      aborted = true;
      abortReason = options.signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
      void closeSession().then(
        () => rejectAborted(abortReason),
        () => rejectAborted(abortReason),
      );
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const callback = (transaction: ManagedTransaction) => work(transaction as unknown as Neo4jTransaction);
      const transactionConfig = { timeout };
      const execution = mode === "read"
        ? session.executeRead(callback, transactionConfig)
        : session.executeWrite(callback, transactionConfig);
      const result = options.signal ? await Promise.race([execution, abortedExecution]) : await execution;
      if (aborted) {
        await closeSession().catch(() => undefined);
        throw abortReason;
      }
      return result;
    } catch (error) {
      if (aborted) {
        await closeSession().catch(() => undefined);
        throw abortReason;
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      if (!aborted) await closeSession();
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
    connectionTimeout: resolved.driverTimeouts.connectionMs,
    connectionAcquisitionTimeout: resolved.driverTimeouts.connectionAcquisitionMs,
    maxTransactionRetryTime: resolved.driverTimeouts.maxTransactionRetryMs,
  });
  return new DriverNeo4jClient(driver, resolved.database, neo4j.bookmarkManager());
}
