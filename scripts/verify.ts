import { spawn } from "node:child_process";

type Gate = {
  readonly name: string;
  readonly args: readonly string[];
};

const MAX_CAPTURED_OUTPUT = 256_000;
const GATE_TIMEOUT_MS = Number.isFinite(Number(process.env.WORKOUT_VERIFY_GATE_TIMEOUT_MS))
  && Number(process.env.WORKOUT_VERIFY_GATE_TIMEOUT_MS) > 0
  ? Number(process.env.WORKOUT_VERIFY_GATE_TIMEOUT_MS)
  : 10 * 60_000;
const INFRASTRUCTURE_PATTERN = /infrastructure|ECONNREFUSED|Neo4j unavailable|Docker|web app did not become ready|browser server|timed out waiting for connected run|verification gate timed out/i;

const gates: readonly Gate[] = [
  { name: "lint", args: ["lint"] },
  { name: "types", args: ["typecheck"] },
  { name: "unit", args: ["test"] },
  { name: "connected acceptance", args: ["test:connected"] },
  { name: "connected evidence", args: ["verify:evidence"] },
  { name: "component evaluation", args: ["eval:workout-runtime"] },
  { name: "Neo4j integration", args: ["test:integration"] },
  { name: "browser", args: ["test:e2e"] },
  { name: "build", args: ["build"] },
];

function runGate(gate: Gate): Promise<{ readonly code: number; readonly output: string }> {
  return new Promise((resolve) => {
    const child = spawn("pnpm", gate.args, {
      cwd: process.cwd(),
      env: { ...process.env, CI: process.env.CI ?? "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "";
    let infrastructureHint = false;
    let settled = false;
    let timedOut = false;
    const handles: { timeout?: NodeJS.Timeout; kill?: NodeJS.Timeout } = {};
    const capture = (chunk: Buffer | string) => {
      const text = chunk.toString();
      infrastructureHint ||= INFRASTRUCTURE_PATTERN.test(text);
      output = `${output}${text}`.slice(-MAX_CAPTURED_OUTPUT);
      return text;
    };
    const terminate = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* process may have exited between timeout and termination */ }
    };
    const finish = (code: number, extra = "") => {
      if (settled) return;
      settled = true;
      if (handles.timeout) clearTimeout(handles.timeout);
      if (handles.kill) clearTimeout(handles.kill);
      const suffix = [extra, infrastructureHint ? "infrastructure" : ""].filter(Boolean).join("\n");
      resolve({ code, output: suffix ? `${output}\n${suffix}` : output });
    };
    child.stdout.on("data", (chunk: Buffer) => { process.stdout.write(capture(chunk)); });
    child.stderr.on("data", (chunk: Buffer) => { process.stderr.write(capture(chunk)); });
    child.once("error", (error) => {
      const text = capture(error.message);
      finish(1, text);
    });
    child.once("close", (code) => finish(timedOut ? 124 : code ?? 1));
    handles.timeout = setTimeout(() => {
      timedOut = true;
      const message = `verification gate timed out after ${GATE_TIMEOUT_MS}ms`;
      process.stderr.write(`[INFRASTRUCTURE] ${gate.name}: ${message}\n`);
      capture(message);
      terminate("SIGTERM");
      handles.kill = setTimeout(() => terminate("SIGKILL"), 5_000);
    }, GATE_TIMEOUT_MS);
  });
}

function failureKind(output: string): "INFRASTRUCTURE" | "ASSERTION" {
  if (INFRASTRUCTURE_PATTERN.test(output)) {
    return "INFRASTRUCTURE";
  }
  return "ASSERTION";
}

const failures: string[] = [];
for (const gate of gates) {
  process.stdout.write(`\n[GATE] ${gate.name}\n`);
  const result = await runGate(gate);
  if (result.code === 0) {
    process.stdout.write(`[PASS] ${gate.name}\n`);
  } else {
    const kind = failureKind(result.output);
    failures.push(`${kind}: ${gate.name}`);
    process.stderr.write(`[${kind}] ${gate.name} failed (exit ${result.code})\n`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`\nVerification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("\n[PASS] verify: all gates green\n");
}
