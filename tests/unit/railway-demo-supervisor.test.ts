import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { redactRailwayLogLine, runRailwayDemoSupervisor, validateRailwayDemoEnvironment, type RailwayDemoChild } from "../../scripts/run-railway-demo";

const validEnvironment = {
  NODE_ENV: "production",
  AXON_RUNTIME_PROFILE: "railway-demo",
  NEO4J_ALLOW_INSECURE_RAILWAY: "1",
  NEO4J_PRIVATE_DOMAIN: "neo4j.railway.internal",
  NEO4J_URI: "bolt://neo4j.railway.internal:7687",
  NEO4J_USERNAME: "neo4j",
  NEO4J_PASSWORD: "Q7v!pR2#nL8@xZ4$",
  NEO4J_DATABASE: "neo4j",
  WORKOUT_DEMO_MODE: "deterministic",
  WORKOUT_WORKER_ID: "worker:railway-demo",
  WORKOUT_ROUTE_SECRET: "r".repeat(32),
  COPILOT_SESSION_SECRET: "r".repeat(32),
  COPILOT_CONTINUATION_SECRET: "c".repeat(32),
};

class FakeChild extends EventEmitter implements RailwayDemoChild {
  readonly killed: string[] = [];
  kill(signal?: NodeJS.Signals) {
    this.killed.push(signal ?? "SIGTERM");
    queueMicrotask(() => this.emit("exit", null, signal ?? "SIGTERM"));
    return true;
  }
}

describe("Railway demo supervisor", () => {
  it("accepts the documented environment without exposing secret values", () => {
    expect(validateRailwayDemoEnvironment(validEnvironment)).toMatchObject({ status: "ready" });
  });

  it("rejects test bypass and custom roster overrides", () => {
    expect(() => validateRailwayDemoEnvironment({ ...validEnvironment, WORKOUT_TEST_BYPASS: "1" })).toThrow(/WORKOUT_TEST_BYPASS/);
    expect(() => validateRailwayDemoEnvironment({ ...validEnvironment, COPILOT_LOCAL_MEMBER_IDS: "member:custom" })).toThrow(/COPILOT_LOCAL_MEMBER_IDS/);
  });

  it("redacts secrets, multi-word prompts, and private URIs from child output", () => {
    const line = JSON.stringify({
      password: validEnvironment.NEO4J_PASSWORD,
      prompt: "Build a lower-body workout",
      memberIds: ["mbr_01HX9JORDAN"],
      uri: validEnvironment.NEO4J_URI,
    });
    const redacted = redactRailwayLogLine(line, validEnvironment);
    expect(redacted).not.toContain(validEnvironment.NEO4J_PASSWORD);
    expect(redacted).not.toContain("Build a lower-body workout");
    expect(redacted).not.toContain("mbr_01HX9JORDAN");
    expect(redacted).not.toContain(validEnvironment.NEO4J_URI);
    expect(redacted).toContain("[redacted]");
  });

  it("keeps the web service alive in degraded mode after the bounded worker retry count", async () => {
    const children: FakeChild[] = [];
    const logs: string[] = [];
    let webWasAliveWhenDegraded = false;
    const spawnProcess = () => {
      const child = new FakeChild();
      children.push(child);
      if (children.length > 1) queueMicrotask(() => child.emit("exit", 1, null));
      return child;
    };

    await expect(runRailwayDemoSupervisor({
      environment: validEnvironment,
      spawnProcess,
      wait: async () => undefined,
      log: (line) => {
        logs.push(line);
        if (line === "[railway:supervisor] worker-degraded") {
          webWasAliveWhenDegraded = children[0]!.killed.length === 0;
          queueMicrotask(() => children[0]!.emit("exit", 2, null));
        }
      },
      maxWorkerRestarts: 2,
      workerBackoffMs: [1, 1],
      installSignalHandlers: false,
    })).resolves.toBe(1);

    expect(children).toHaveLength(4);
    expect(logs).toContain("[railway:supervisor] restart-count=1");
    expect(logs).toContain("[railway:supervisor] restart-count=2");
    expect(logs).toContain("[railway:supervisor] retry-exhausted");
    expect(logs).toContain("[railway:supervisor] worker-degraded");
    expect(webWasAliveWhenDegraded).toBe(true);
  });

  it("resets the worker restart budget after a sustained healthy interval", async () => {
    const children: FakeChild[] = [];
    const logs: string[] = [];
    let currentTime = 0;
    const spawnProcess = () => {
      const child = new FakeChild();
      children.push(child);
      if (children.length === 2) queueMicrotask(() => child.emit("exit", 1, null));
      if (children.length === 3) queueMicrotask(() => {
        currentTime = 60_000;
        child.emit("exit", 1, null);
      });
      if (children.length === 4) queueMicrotask(() => children[0]!.emit("exit", 2, null));
      return child;
    };

    await expect(runRailwayDemoSupervisor({
      environment: validEnvironment,
      spawnProcess,
      wait: async () => undefined,
      log: (line) => logs.push(line),
      maxWorkerRestarts: 1,
      workerBackoffMs: [1],
      workerHealthyIntervalMs: 60_000,
      now: () => currentTime,
      installSignalHandlers: false,
    })).resolves.toBe(2);

    expect(children).toHaveLength(4);
    expect(logs).toContain("[railway:supervisor] restart-budget-reset");
    expect(logs).not.toContain("[railway:supervisor] retry-exhausted");
  });

  it("maps an unexpected clean web exit to supervisor failure", async () => {
    const children: FakeChild[] = [];
    const spawnProcess = () => {
      const child = new FakeChild();
      children.push(child);
      if (children.length === 1) queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    };

    await expect(runRailwayDemoSupervisor({
      environment: validEnvironment,
      spawnProcess,
      wait: async () => undefined,
      installSignalHandlers: false,
    })).resolves.toBe(1);
  });

  it("maps repeated clean worker exits followed by a clean web exit to supervisor failure", async () => {
    const children: FakeChild[] = [];
    const spawnProcess = () => {
      const child = new FakeChild();
      children.push(child);
      if (children.length > 1) {
        queueMicrotask(() => child.emit("exit", 0, null));
        if (children.length === 3) queueMicrotask(() => children[0]!.emit("exit", 0, null));
      }
      return child;
    };

    await expect(runRailwayDemoSupervisor({
      environment: validEnvironment,
      spawnProcess,
      wait: async () => undefined,
      maxWorkerRestarts: 1,
      workerBackoffMs: [1],
      installSignalHandlers: false,
    })).resolves.toBe(1);
  });

  it("terminates the worker when the web child exits", async () => {
    const children: FakeChild[] = [];
    const spawnProcess = () => {
      const child = new FakeChild();
      children.push(child);
      if (children.length === 1) queueMicrotask(() => child.emit("exit", 2, null));
      return child;
    };

    await expect(runRailwayDemoSupervisor({
      environment: validEnvironment,
      spawnProcess,
      wait: async () => undefined,
      installSignalHandlers: false,
    })).resolves.toBe(2);
    expect(children[1]!.killed).toEqual(["SIGTERM"]);
  });

  it("cleans up the web child when the worker cannot be spawned", async () => {
    const web = new FakeChild();
    let calls = 0;
    const spawnProcess = () => {
      calls += 1;
      if (calls === 1) return web;
      throw new Error("worker executable missing");
    };

    await expect(runRailwayDemoSupervisor({
      environment: validEnvironment,
      spawnProcess,
      installSignalHandlers: false,
    })).rejects.toThrow("worker executable missing");
    expect(web.killed).toEqual(["SIGTERM"]);
  });
});
