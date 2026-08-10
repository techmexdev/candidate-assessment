import { spawn, type SpawnOptions } from "node:child_process";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { isDemoPlaceholder, isRailwayPrivateDomain, RAILWAY_DEMO_PROFILE, resolveDeploymentProfile } from "../src/server/deployment-profile";

const ROOT = process.cwd();
const DEFAULT_MAX_WORKER_RESTARTS = 3;
const DEFAULT_WORKER_BACKOFF_MS = Object.freeze([1_000, 2_000, 4_000]);
const DEFAULT_WORKER_HEALTHY_INTERVAL_MS = 60_000;
const SECRET_ENV_NAMES = Object.freeze([
  "WORKOUT_ROUTE_SECRET",
  "COPILOT_SESSION_SECRET",
  "COPILOT_CONTINUATION_SECRET",
  "NEO4J_PASSWORD",
] as const);

type Environment = Readonly<Record<string, string | undefined>>;

export type RailwayDemoPreflightReport = Readonly<{
  readonly status: "ready";
  readonly checks: readonly string[];
}>;

export type RailwayDemoChild = {
  readonly once: {
    (event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    (event: "error", listener: (error: Error) => void): unknown;
  };
  readonly kill: (signal?: NodeJS.Signals) => boolean;
  readonly stdout?: NodeJS.ReadableStream | null;
  readonly stderr?: NodeJS.ReadableStream | null;
};

type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => RailwayDemoChild;

export type RailwayDemoSupervisorOptions = {
  readonly environment?: Environment;
  readonly spawnProcess?: SpawnProcess;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly log?: (line: string) => void;
  readonly maxWorkerRestarts?: number;
  readonly workerBackoffMs?: readonly number[];
  readonly workerHealthyIntervalMs?: number;
  readonly now?: () => number;
  readonly installSignalHandlers?: boolean;
};

function value(environment: Environment, name: string) {
  const configured = environment[name]?.trim();
  return configured || undefined;
}

function isExactSecret(secret: string | undefined) {
  return Boolean(secret && Buffer.byteLength(secret) === 32);
}

function validPrivateBoltUri(uri: string | undefined, expectedDomain: string | undefined) {
  if (!uri || !expectedDomain || !isRailwayPrivateDomain(expectedDomain)) return false;
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "bolt:"
      && parsed.hostname === expectedDomain.toLowerCase()
      && parsed.port === "7687"
      && !parsed.username
      && !parsed.password
      && parsed.pathname === ""
      && parsed.search === ""
      && parsed.hash === "";
  } catch {
    return false;
  }
}

/** Validate the complete public-demo contract without opening a database connection. */
export function validateRailwayDemoEnvironment(environment: Environment = process.env): RailwayDemoPreflightReport {
  const errors: string[] = [];
  const nodeEnvironment = value(environment, "NODE_ENV");
  if (nodeEnvironment !== "production") errors.push("NODE_ENV=production is required");

  let profile: ReturnType<typeof resolveDeploymentProfile> | undefined;
  try {
    profile = resolveDeploymentProfile(environment);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "deployment profile is invalid");
  }
  if (profile?.name !== RAILWAY_DEMO_PROFILE) errors.push("AXON_RUNTIME_PROFILE=railway-demo is required");
  if (profile?.allowInsecureRailway !== true) errors.push("NEO4J_ALLOW_INSECURE_RAILWAY=1 is required");
  if (value(environment, "WORKOUT_DEMO_MODE") !== "deterministic") errors.push("WORKOUT_DEMO_MODE=deterministic is required");

  for (const name of ["NEO4J_URI", "NEO4J_PRIVATE_DOMAIN", "NEO4J_USERNAME", "NEO4J_PASSWORD", "NEO4J_DATABASE", "WORKOUT_WORKER_ID"]) {
    if (!value(environment, name)) errors.push(`${name} is required`);
  }
  const privateDomain = value(environment, "NEO4J_PRIVATE_DOMAIN");
  if (!validPrivateBoltUri(value(environment, "NEO4J_URI"), privateDomain)) {
    errors.push("NEO4J_URI must be the exact private bolt:// hostname on port 7687");
  }

  const password = value(environment, "NEO4J_PASSWORD");
  if (!password || password.length < 8 || isDemoPlaceholder(password)) errors.push("NEO4J_PASSWORD must be a non-placeholder password");

  const routeSecret = value(environment, "WORKOUT_ROUTE_SECRET");
  const sessionSecret = value(environment, "COPILOT_SESSION_SECRET");
  const continuationSecret = value(environment, "COPILOT_CONTINUATION_SECRET");
  if (!isExactSecret(routeSecret)) errors.push("WORKOUT_ROUTE_SECRET must be exactly 32 bytes");
  if (!isExactSecret(sessionSecret) || sessionSecret !== routeSecret) errors.push("COPILOT_SESSION_SECRET must equal the 32-byte WORKOUT_ROUTE_SECRET");
  if (!isExactSecret(continuationSecret) || continuationSecret === routeSecret) errors.push("COPILOT_CONTINUATION_SECRET must be a different 32-byte secret");

  for (const name of ["WORKOUT_LOCAL_COACH_ID", "WORKOUT_LOCAL_MEMBER_IDS", "COPILOT_LOCAL_COACH_ID", "COPILOT_LOCAL_MEMBER_IDS", "WORKOUT_TEST_BYPASS"]) {
    if (value(environment, name)) errors.push(`${name} is not allowed in the public Railway demo`);
  }

  if (errors.length > 0) {
    throw new Error(`Railway demo preflight failed: ${errors.join("; ")}`);
  }
  return Object.freeze({ status: "ready", checks: Object.freeze(["profile", "neo4j", "shared-session-secret", "synthetic-roster", "worker"]) });
}

function defaultSpawn(command: string, args: readonly string[], options: SpawnOptions) {
  return spawn(command, [...args], options);
}

function defaultWait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export function redactRailwayLogLine(line: string, environment: Environment) {
  let redacted = line;
  for (const name of SECRET_ENV_NAMES) {
    const secret = value(environment, name);
    if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted
    .replace(/("?(?:password|secret|token|cookie|prompt|authorization|member(?:id|ids|context)?|payload)"?\s*[:=]\s*)("(?:\\.|[^"\\])*"|\[[^\]]*\]|\{[^}]*\}|[^,}\s]+)/gi, "$1[redacted]")
    .replace(/(neo4j:\/\/|bolt:\/\/|neo4j\+s:\/\/|bolt\+s:\/\/)[^\s]+/gi, "$1[redacted]");
}

function streamLines(
  stream: NodeJS.ReadableStream | null | undefined,
  prefix: string,
  environment: Environment,
  log: (line: string) => void,
) {
  stream?.on("data", (chunk: Buffer | string) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim()) log(`${prefix} ${redactRailwayLogLine(line, environment)}`);
    }
  });
}

function startChild(
  spawnProcess: SpawnProcess,
  command: string,
  args: readonly string[],
  environment: Environment,
  prefix: string,
  log: (line: string) => void,
) {
  const child = spawnProcess(command, args, {
    cwd: ROOT,
    env: { ...environment } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  streamLines(child.stdout, prefix, environment, log);
  streamLines(child.stderr, prefix, environment, log);
  return child;
}

function exited(child: RailwayDemoChild): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: 1, signal: null }));
  });
}

function unexpectedExitCode(code: number | null) {
  return code === null || code === 0 ? 1 : code;
}

function workerCommand() {
  return {
    command: process.execPath,
    args: ["--import", "./scripts/load-dotenv.mjs", "node_modules/tsx/dist/cli.mjs", "scripts/run-workout-worker.ts", "--poll"],
  } as const;
}

function webCommand() {
  return {
    command: process.execPath,
    args: ["--import", "./scripts/load-dotenv.mjs", "node_modules/next/dist/bin/next", "start"],
  } as const;
}

/** Run Next.js and the detached worker as one Railway service. */
export async function runRailwayDemoSupervisor(options: RailwayDemoSupervisorOptions = {}): Promise<number> {
  const environment = options.environment ?? process.env;
  validateRailwayDemoEnvironment(environment);
  const spawnProcess = options.spawnProcess ?? defaultSpawn;
  const wait = options.wait ?? defaultWait;
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const maxWorkerRestarts = options.maxWorkerRestarts ?? DEFAULT_MAX_WORKER_RESTARTS;
  const backoff = options.workerBackoffMs ?? DEFAULT_WORKER_BACKOFF_MS;
  const workerHealthyIntervalMs = options.workerHealthyIntervalMs ?? DEFAULT_WORKER_HEALTHY_INTERVAL_MS;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(maxWorkerRestarts) || maxWorkerRestarts < 0) throw new Error("maxWorkerRestarts must be a non-negative integer");
  if (!Number.isSafeInteger(workerHealthyIntervalMs) || workerHealthyIntervalMs < 0) throw new Error("workerHealthyIntervalMs must be a non-negative integer");

  let web: RailwayDemoChild | undefined;
  let worker: RailwayDemoChild | undefined;
  let stopping = false;
  let firstFailure = 0;
  const terminated = new Set<RailwayDemoChild>();
  const terminateChild = (child: RailwayDemoChild | undefined) => {
    if (!child || terminated.has(child)) return;
    terminated.add(child);
    try { child.kill("SIGTERM"); } catch { /* child may have exited between checks */ }
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log("[railway:supervisor] intentional-shutdown");
    terminateChild(web);
    terminateChild(worker);
  };
  const installSignals = options.installSignalHandlers !== false;
  if (installSignals) {
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }

  try {
    log("[railway:supervisor] starting");
    const webSpec = webCommand();
    web = startChild(spawnProcess, webSpec.command, webSpec.args, environment, "[railway:web]", log);
    const webExit = exited(web);
    log("[railway:supervisor] web-started");

    let restartCount = 0;
    let workerStartedAt = 0;
    const startWorker = () => {
      const workerSpec = workerCommand();
      worker = startChild(spawnProcess, workerSpec.command, workerSpec.args, environment, "[railway:worker]", log);
      workerStartedAt = now();
      return exited(worker);
    };
    let workerExit = startWorker();
    log("[railway:supervisor] worker-started");

    while (!stopping) {
      const event = await Promise.race([
        webExit.then((result) => ({ kind: "web" as const, result })),
        workerExit.then((result) => ({ kind: "worker" as const, result })),
      ]);
      if (stopping) break;
      if (event.kind === "web") {
        firstFailure ||= unexpectedExitCode(event.result.code);
        log("[railway:supervisor] web-exited");
        terminateChild(worker);
        break;
      }
      if (now() - workerStartedAt >= workerHealthyIntervalMs && restartCount > 0) {
        restartCount = 0;
        log("[railway:supervisor] restart-budget-reset");
      }
      if (restartCount >= maxWorkerRestarts) {
        firstFailure ||= unexpectedExitCode(event.result.code);
        log("[railway:supervisor] retry-exhausted");
        log("[railway:supervisor] worker-degraded");
        worker = undefined;
        const result = await webExit;
        if (!stopping) {
          firstFailure ||= unexpectedExitCode(result.code);
          log("[railway:supervisor] web-exited");
        }
        break;
      }
      restartCount += 1;
      log(`[railway:supervisor] restart-count=${restartCount}`);
      await wait(backoff[Math.min(restartCount - 1, backoff.length - 1)] ?? 1_000);
      if (stopping) break;
      workerExit = startWorker();
    }

    terminateChild(web);
    terminateChild(worker);
    await Promise.all([webExit, workerExit]);
    log(stopping ? "[railway:supervisor] stopped" : "[railway:supervisor] exited");
    return firstFailure;
  } finally {
    terminateChild(web);
    terminateChild(worker);
    if (installSignals) {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
}

async function main() {
  const exitCode = await runRailwayDemoSupervisor();
  if (exitCode !== 0) process.exitCode = exitCode;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`railway_supervisor_error=${error instanceof Error ? error.name : "UnknownError"}\n`);
    process.exitCode = 1;
  });
}
