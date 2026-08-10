import { describe, expect, it } from "vitest";
import { RAILWAY_DEMO_PROFILE, resolveDeploymentProfile } from "../../src/server/deployment-profile";

describe("deployment profile", () => {
  it("keeps the default profile strict", () => {
    expect(resolveDeploymentProfile({ NODE_ENV: "production" })).toEqual({ allowInsecureRailway: false });
  });

  it("derives the Railway private-network allowance only from the exact profile and flag", () => {
    expect(resolveDeploymentProfile({
      NODE_ENV: "production",
      AXON_RUNTIME_PROFILE: RAILWAY_DEMO_PROFILE,
      NEO4J_ALLOW_INSECURE_RAILWAY: "1",
    })).toEqual({ name: RAILWAY_DEMO_PROFILE, allowInsecureRailway: true });
  });

  it.each([
    { label: "unknown profile", environment: { NODE_ENV: "production", AXON_RUNTIME_PROFILE: "demo" } },
    { label: "non-production Railway profile", environment: { NODE_ENV: "development", AXON_RUNTIME_PROFILE: RAILWAY_DEMO_PROFILE } },
    { label: "unknown allowance value", environment: { NODE_ENV: "production", NEO4J_ALLOW_INSECURE_RAILWAY: "true" } },
    { label: "allowance without profile", environment: { NODE_ENV: "production", NEO4J_ALLOW_INSECURE_RAILWAY: "1" } },
  ])("rejects $label", ({ environment }) => {
    expect(() => resolveDeploymentProfile(environment)).toThrow();
  });
});
