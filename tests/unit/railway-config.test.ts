import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Railway app configuration", () => {
  it("keeps build, supervised start, liveness, and finite restart policy explicit", async () => {
    const config = JSON.parse(await readFile(new URL("../../railway.json", import.meta.url), "utf8")) as {
      build?: Record<string, unknown>;
      deploy?: Record<string, unknown>;
    };

    expect(config.build).toMatchObject({ builder: "RAILPACK", buildCommand: "pnpm build" });
    expect(config.deploy).toMatchObject({
      startCommand: "pnpm railway:start",
      healthcheckPath: "/api/session",
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 3,
    });
    expect(config.deploy?.healthcheckTimeout).toBeGreaterThan(0);
    expect(JSON.stringify(config)).not.toMatch(/NEO4J_PASSWORD|bolt:\/\/|preDeploy/i);
  });
});
