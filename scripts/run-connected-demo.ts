import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { totalmem } from "node:os";
import { createConnection } from "node:net";
import process from "node:process";

const ROOT = process.cwd();
const WEB_PORT = Number(process.env.DEMO_WEB_PORT ?? 3000);
const NEO4J_BOLT_PORT = Number(process.env.NEO4J_BOLT_PORT ?? 7687);
const NEO4J_HTTP_PORT = Number(process.env.NEO4J_HTTP_PORT ?? 7474);

export type DemoPrerequisiteReport = {
  readonly status: "ready" | "failed";
  readonly checks: readonly { readonly name: string; readonly status: "ok" | "failed"; readonly detail: string }[];
};

function commandAvailable(command: string) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function major(version: string) {
  const match = version.match(/v?(\d+)/);
  return match ? Number(match[1]) : NaN;
}

async function portOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.setTimeout(250, () => { socket.destroy(); resolve(false); });
  });
}

export async function validateDemoPrerequisites(): Promise<DemoPrerequisiteReport> {
  const checks: { name: string; status: "ok" | "failed"; detail: string }[] = [];
  const nodeMajor = major(process.version);
  checks.push({ name: "Node.js", status: nodeMajor === 24 ? "ok" : "failed", detail: `v${nodeMajor || "unknown"} (requires 24.x)` });
  const pnpmVersion = spawnSync("pnpm", ["--version"], { encoding: "utf8" }).stdout?.trim() ?? "";
  checks.push({ name: "pnpm", status: major(pnpmVersion) === 11 ? "ok" : "failed", detail: `${pnpmVersion || "not found"} (requires 11.x)` });
  checks.push({ name: "Docker", status: commandAvailable("docker") ? "ok" : "failed", detail: commandAvailable("docker") ? "available" : "install Docker Desktop or Docker Engine" });
  checks.push({ name: "Memory", status: totalmem() >= 4 * 1024 ** 3 ? "ok" : "failed", detail: `${Math.round(totalmem() / 1024 ** 3)} GB (requires at least 4 GB)` });
  const webOccupied = await portOpen(WEB_PORT);
  checks.push({ name: `Web port ${WEB_PORT}`, status: webOccupied ? "failed" : "ok", detail: webOccupied ? "already in use" : "available" });
  checks.push({ name: `Neo4j ports ${NEO4J_HTTP_PORT}/${NEO4J_BOLT_PORT}`, status: "ok", detail: "validated after container health check" });
  return { status: checks.some((check) => check.status === "failed") ? "failed" : "ready", checks };
}

function run(command: string, args: readonly string[], environment: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ readonly code: number; readonly output: string }>((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: ROOT, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

function parseJsonOutput(output: string): Record<string, unknown> | undefined {
  const trimmed = output.trim();
  const lines = trimmed.split("\n");
  const candidates = [trimmed];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "{" || line.startsWith("{\"") || line === "[") candidates.push(lines.slice(index).join("\n"));
    if (line.startsWith("{") && line.endsWith("}")) candidates.push(line);
  }
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch { /* inspect output can include package-manager noise */ }
  }
  return undefined;
}

async function seedCanonicalGraphs(environment: NodeJS.ProcessEnv) {
  const movementDryRun = await run("pnpm", ["graph:seed", "--", "--dry-run"], environment);
  if (movementDryRun.code !== 0) throw new Error("Movement graph validation failed.");
  const movement = parseJsonOutput(movementDryRun.output);
  const movementRevision = typeof movement?.graphRevisionId === "string" ? movement.graphRevisionId : undefined;
  if (!movementRevision) throw new Error("Movement graph dry-run did not return a revision.");
  const movementInspect = await run("pnpm", ["graph:inspect"], environment);
  if (movementInspect.code !== 0) throw new Error("Movement graph inspection failed.");
  const movementActive = parseJsonOutput(movementInspect.output)?.activeRevisionId;
  if (typeof movementActive === "string" && movementActive !== movementRevision) {
    throw new Error("A different active movement graph revision is present; inspect/recover it before replacing the demo graph.");
  }
  if (movementActive !== movementRevision) {
    const activated = await run("pnpm", ["graph:seed", "--", "--activate", "--expected-prior", movementActive === null ? "null" : String(movementActive ?? "null")], environment);
    if (activated.code !== 0) throw new Error("Movement graph activation failed.");
  }

  const memberInspect = await run("pnpm", ["graph:seed:member", "--", "--inspect"], environment);
  if (memberInspect.code !== 0) throw new Error("Member Context inspection failed.");
  const member = parseJsonOutput(memberInspect.output);
  const memberReports = Array.isArray(member?.reports)
    ? member.reports.filter((report): report is Record<string, unknown> => Boolean(report && typeof report === "object" && !Array.isArray(report)))
    : member ? [member] : [];
  if (memberReports.length !== 3) throw new Error("Member Context inspection did not return all roster members.");
  let memberNeedsActivation = false;
  for (const report of memberReports) {
    const memberRevision = typeof report.contextRevisionId === "string" ? report.contextRevisionId : undefined;
    const memberActive = report.activeRevisionBefore;
    if (!memberRevision) throw new Error("Member Context inspection did not return a revision for every roster member.");
    if (typeof memberActive === "string" && memberActive !== memberRevision) {
      throw new Error("A different active Member Context revision is present; inspect/recover it before replacing the demo context.");
    }
    if (memberActive !== memberRevision) memberNeedsActivation = true;
  }
  if (memberNeedsActivation) {
    const activated = await run("pnpm", ["graph:seed:member"], environment);
    if (activated.code !== 0) throw new Error("Member Context activation failed.");
  }
}

function child(command: string, args: readonly string[], environment: NodeJS.ProcessEnv) {
  return spawn(command, [...args], { cwd: ROOT, env: environment, stdio: "inherit" });
}

async function waitForWeb(url: string, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.status < 500) return;
    } catch { /* keep waiting */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Web app did not become ready within 30 seconds.");
}

async function main() {
  const prerequisites = await validateDemoPrerequisites();
  for (const check of prerequisites.checks) process.stdout.write(`[${check.status.toUpperCase()}] ${check.name}: ${check.detail}\n`);
  if (prerequisites.status !== "ready") process.exit(1);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "development",
    WORKOUT_DEMO_MODE: "deterministic",
    WORKOUT_WORKER_ID: process.env.WORKOUT_WORKER_ID ?? "worker:connected-demo",
    WORKOUT_ROUTE_SECRET: process.env.WORKOUT_ROUTE_SECRET ?? "axon-local-workout-route-secret-change-before-production",
    NEO4J_URI: process.env.NEO4J_URI ?? "neo4j://127.0.0.1:7687",
    NEO4J_USERNAME: process.env.NEO4J_USERNAME ?? "neo4j",
    NEO4J_PASSWORD: process.env.NEO4J_PASSWORD ?? "movement-graph-local-test",
  };
  const children: ChildProcess[] = [];
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const process_ of children) process_.kill("SIGTERM");
    const compose = spawn("docker", ["compose", "stop", "neo4j"], { cwd: ROOT, env: environment, stdio: "inherit" });
    compose.once("close", () => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const started = await run("docker", ["compose", "up", "-d", "--wait", "neo4j"], environment);
    if (started.code !== 0) throw new Error("Neo4j container could not start.");
    const healthy = await run("docker", ["compose", "ps", "--status", "running", "neo4j"], environment);
    if (healthy.code !== 0) throw new Error("Neo4j container is not running.");
    await seedCanonicalGraphs(environment);
    children.push(child(process.execPath, ["--import", "./scripts/load-dotenv.mjs", "node_modules/next/dist/bin/next", "dev", "-p", String(WEB_PORT)], environment));
    children.push(child("pnpm", ["worker:workout-run", "--", "--poll"], environment));
    await waitForWeb(`http://127.0.0.1:${WEB_PORT}`);
    process.stdout.write(`READY http://127.0.0.1:${WEB_PORT} mode=deterministic worker=queue\n`);
    await new Promise<void>((resolve) => {
      for (const process_ of children) process_.once("exit", () => { if (!stopped) resolve(); });
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (!stopped) stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Connected demo failed."}\n`);
    process.exitCode = 1;
  });
}
