export const RAILWAY_DEMO_PROFILE = "railway-demo" as const;
const railwayPrivateDomainPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.railway\.internal$/;

type Environment = Readonly<Record<string, string | undefined>>;

export type DeploymentProfile = Readonly<{
  readonly name?: typeof RAILWAY_DEMO_PROFILE;
  readonly allowInsecureRailway: boolean;
}>;

export function isRailwayPrivateDomain(value: string | undefined): value is string {
  return Boolean(value && railwayPrivateDomainPattern.test(value.toLowerCase()));
}

export function isDemoPlaceholder(value: string) {
  return /(?:replace|change|example|placeholder|password|secret|local|demo)/i.test(value);
}

function trimmed(environment: Environment, name: string) {
  const value = environment[name]?.trim();
  return value || undefined;
}

/**
 * Resolve the narrow deployment exception used by the hosted synthetic demo.
 * The graph client receives the result explicitly; it never reads process.env
 * or decides that a production connection is safe on its own.
 */
export function resolveDeploymentProfile(environment: Environment = process.env): DeploymentProfile {
  const runtimeEnvironment = trimmed(environment, "NODE_ENV") ?? "production";
  const name = trimmed(environment, "AXON_RUNTIME_PROFILE");
  const insecureRailwayFlag = trimmed(environment, "NEO4J_ALLOW_INSECURE_RAILWAY");

  if (name && name !== RAILWAY_DEMO_PROFILE) {
    throw new Error("AXON_RUNTIME_PROFILE is unsupported");
  }
  if (insecureRailwayFlag && insecureRailwayFlag !== "1") {
    throw new Error("NEO4J_ALLOW_INSECURE_RAILWAY must be exactly 1 when configured");
  }
  if (name === RAILWAY_DEMO_PROFILE && runtimeEnvironment !== "production") {
    throw new Error("AXON_RUNTIME_PROFILE=railway-demo requires NODE_ENV=production");
  }
  if (insecureRailwayFlag === "1" && name !== RAILWAY_DEMO_PROFILE) {
    throw new Error("NEO4J_ALLOW_INSECURE_RAILWAY requires AXON_RUNTIME_PROFILE=railway-demo");
  }

  return Object.freeze({
    ...(name ? { name: RAILWAY_DEMO_PROFILE } : {}),
    allowInsecureRailway: insecureRailwayFlag === "1",
  });
}
