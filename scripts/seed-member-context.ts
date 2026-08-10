import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import type { MemberContextGraphSnapshot } from "../src/domain/contracts/member-context";
import type { MemberContextPublisher } from "../src/domain/contracts/member-context-publication";
import { compileMemberContextGraph } from "../src/graph/ingest/member-context";
import { createNeo4jClient, type Neo4jClientConfig } from "../src/graph/neo4j/client";
import { setupMemberContextNeo4jSchema } from "../src/graph/neo4j/member-context-schema";
import { createNeo4jMemberContextPublisher } from "../src/graph/publication/neo4j-member-context-publisher";
import { canonicalMemberContextDigest } from "../src/graph/revisions/member-context";
import { resolveDeploymentProfile } from "../src/server/deployment-profile";
import {
  MemberContextValidationError,
  validateMemberContextGraph,
} from "../src/graph/validation/member-context";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
export const MEMBER_CONTEXT_SEED_SOURCE = "data/member-context.json";
export const MEMBER_CONTEXT_SEED_TARGETS = [
  { fixtureId: "jordan", memberId: "mbr_01HX9JORDAN", sourcePath: MEMBER_CONTEXT_SEED_SOURCE },
  { fixtureId: "avery", memberId: "mbr_02HX9AVERY", sourcePath: "data/member-context-avery.json" },
  { fixtureId: "morgan", memberId: "mbr_03HX9MORGAN", sourcePath: "data/member-context-morgan.json" },
] as const;
export type MemberContextSeedSource = (typeof MEMBER_CONTEXT_SEED_TARGETS)[number]["sourcePath"];

export function memberContextNeo4jClientConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Neo4jClientConfig {
  const deploymentProfile = resolveDeploymentProfile(environment);
  return {
    uri: environment.NEO4J_URI,
    username: environment.NEO4J_USERNAME,
    password: environment.NEO4J_PASSWORD,
    database: environment.NEO4J_DATABASE,
    environment: environment.NODE_ENV ?? "development",
    runtimeProfile: deploymentProfile.name,
    allowInsecureRailway: deploymentProfile.allowInsecureRailway,
    expectedPrivateDomain: environment.NEO4J_PRIVATE_DOMAIN,
  };
}

export type MemberContextSeedMode = "dry-run" | "stage" | "publish" | "inspect";

export type MemberContextSeedOptions = {
  readonly mode: MemberContextSeedMode;
  readonly expectedActiveRevisionId?: string | null;
  readonly sourcePath?: MemberContextSeedSource;
  /** Integration seam; the command-line entry always compiles the tracked source. */
  readonly snapshot?: MemberContextGraphSnapshot;
};

export type MemberContextSeedBatchOptions = {
  readonly mode: MemberContextSeedMode;
  readonly expectedActiveRevisionId?: string | null;
};

export type MemberContextSeedBatchReport = {
  readonly outcome:
    | "validated"
    | "staged"
    | "activated"
    | "already-active"
    | "active"
    | "missing"
    | "validation-failed"
    | "publication-failed";
  readonly reports: readonly MemberContextSeedReport[];
};

export type MemberContextSeedReport = {
  readonly outcome:
    | "validated"
    | "staged"
    | "activated"
    | "already-active"
    | "active"
    | "missing"
    | "validation-failed"
    | "publication-failed";
  readonly sourcePath: MemberContextSeedSource;
  readonly memberId: string;
  readonly contextRevisionId: string;
  readonly sourceArtifactDigest: string;
  readonly canonicalDigest: string;
  readonly nodeCount: number;
  readonly relationshipCount: number;
  readonly valid: boolean;
  readonly validationErrorCount: number;
  readonly activeRevisionBefore: string | null;
  readonly activeRevisionAfter: string | null;
  readonly sealId?: string;
  readonly sealedCanonicalDigest?: string;
  readonly sealedNodeCount?: number;
  readonly sealedRelationshipCount?: number;
  readonly publicationFailureCode?: string;
};

function inspectionFields(inspection: {
  readonly sealId?: string;
  readonly canonicalDigest?: string;
  readonly nodeCount?: number;
  readonly relationshipCount?: number;
}) {
  return {
    ...(inspection.sealId ? { sealId: inspection.sealId } : {}),
    ...(inspection.canonicalDigest ? { sealedCanonicalDigest: inspection.canonicalDigest } : {}),
    ...(inspection.nodeCount !== undefined ? { sealedNodeCount: inspection.nodeCount } : {}),
    ...(inspection.relationshipCount !== undefined ? { sealedRelationshipCount: inspection.relationshipCount } : {}),
  };
}

async function compileTrackedSource(sourcePath: MemberContextSeedSource): Promise<MemberContextGraphSnapshot> {
  const source = JSON.parse(await readFile(path.join(repositoryRoot, sourcePath), "utf8")) as unknown;
  return compileMemberContextGraph(source as never, { sourceLocator: sourcePath });
}

function baseReport(
  snapshot: MemberContextGraphSnapshot,
  sourcePath: MemberContextSeedSource,
  valid: boolean,
  validationErrorCount: number,
) {
  return {
    sourcePath,
    memberId: snapshot.memberId,
    contextRevisionId: snapshot.contextRevisionId,
    sourceArtifactDigest: snapshot.sourceArtifactDigest,
    canonicalDigest: canonicalMemberContextDigest(snapshot),
    nodeCount: snapshot.nodes.length,
    relationshipCount: snapshot.relationships.length,
    valid,
    validationErrorCount,
  } as const;
}

export async function runMemberContextSeed(
  options: MemberContextSeedOptions,
  dependencies: { readonly publisher?: MemberContextPublisher } = {},
): Promise<MemberContextSeedReport> {
  const sourcePath = options.sourcePath ?? MEMBER_CONTEXT_SEED_SOURCE;
  const snapshot = options.snapshot ?? await compileTrackedSource(sourcePath);
  const validation = validateMemberContextGraph(snapshot);
  const base = baseReport(snapshot, sourcePath, validation.valid, validation.errors.length);
  if (!validation.valid) {
    const inspection = options.mode === "dry-run"
      ? undefined
      : await dependencies.publisher?.inspect(snapshot.memberId);
    const preservedActiveRevision = inspection?.status === "ok" ? inspection.data.activeRevisionId : null;
    return {
      ...base,
      outcome: "validation-failed",
      activeRevisionBefore: preservedActiveRevision,
      activeRevisionAfter: preservedActiveRevision,
    };
  }
  if (options.mode === "dry-run") {
    return { ...base, outcome: "validated", activeRevisionBefore: null, activeRevisionAfter: null };
  }

  const publisher = dependencies.publisher;
  if (!publisher) throw new Error("member_context_publisher_required");
  const before = await publisher.inspect(snapshot.memberId);
  if (before.status !== "ok") {
    return {
      ...base,
      outcome: "publication-failed",
      activeRevisionBefore: null,
      activeRevisionAfter: null,
      publicationFailureCode: before.failure.code,
    };
  }
  const activeRevisionBefore = before.data.activeRevisionId;
  if (options.mode === "inspect") {
    const revision = await publisher.inspect(snapshot.memberId, snapshot.contextRevisionId);
    return {
      ...base,
      ...(revision.status === "ok" ? inspectionFields(revision.data) : {}),
      outcome: revision.status === "ok" && activeRevisionBefore === snapshot.contextRevisionId ? "active" : "missing",
      activeRevisionBefore,
      activeRevisionAfter: activeRevisionBefore,
    };
  }
  if (activeRevisionBefore === snapshot.contextRevisionId) {
    const revision = await publisher.inspect(snapshot.memberId, snapshot.contextRevisionId);
    return {
      ...base,
      ...(revision.status === "ok" ? inspectionFields(revision.data) : {}),
      outcome: "already-active",
      activeRevisionBefore,
      activeRevisionAfter: activeRevisionBefore,
    };
  }

  const staged = await publisher.stage({
    snapshot,
    canonicalDigest: base.canonicalDigest,
    nodeCount: base.nodeCount,
    relationshipCount: base.relationshipCount,
  });
  if (staged.status !== "ok") {
    return {
      ...base,
      outcome: "publication-failed",
      activeRevisionBefore,
      activeRevisionAfter: activeRevisionBefore,
      publicationFailureCode: staged.failure.code,
    };
  }
  const validated = await publisher.validate({ publicationAttemptId: staged.data.publicationAttemptId });
  if (validated.status !== "ok") {
    return {
      ...base,
      outcome: "publication-failed",
      activeRevisionBefore,
      activeRevisionAfter: activeRevisionBefore,
      publicationFailureCode: validated.failure.code,
    };
  }
  if (options.mode === "stage") {
    return {
      ...base,
      sealId: validated.data.sealId,
      sealedCanonicalDigest: validated.data.canonicalDigest,
      sealedNodeCount: validated.data.nodeCount,
      sealedRelationshipCount: validated.data.relationshipCount,
      outcome: "staged",
      activeRevisionBefore,
      activeRevisionAfter: activeRevisionBefore,
    };
  }
  const expectedPriorRevisionId = options.expectedActiveRevisionId === undefined
    ? activeRevisionBefore
    : options.expectedActiveRevisionId;
  const activated = await publisher.activate({
    memberId: snapshot.memberId,
    contextRevisionId: snapshot.contextRevisionId,
    expectedPriorRevisionId,
    actorId: "seed:member-context",
  });
  if (activated.status !== "ok") {
    const afterFailure = await publisher.inspect(snapshot.memberId);
    return {
      ...base,
      outcome: "publication-failed",
      activeRevisionBefore,
      activeRevisionAfter: afterFailure.status === "ok" ? afterFailure.data.activeRevisionId : activeRevisionBefore,
      publicationFailureCode: activated.failure.code,
    };
  }
  const after = await publisher.inspect(snapshot.memberId, snapshot.contextRevisionId);
  return {
    ...base,
    ...(after.status === "ok" ? inspectionFields(after.data) : {
      sealId: validated.data.sealId,
      sealedCanonicalDigest: validated.data.canonicalDigest,
      sealedNodeCount: validated.data.nodeCount,
      sealedRelationshipCount: validated.data.relationshipCount,
    }),
    outcome: activated.data.state === "already-active" ? "already-active" : "activated",
    activeRevisionBefore,
    activeRevisionAfter: after.status === "ok" ? after.data.activeRevisionId : snapshot.contextRevisionId,
  };
}

export async function runAllMemberContextSeeds(
  options: MemberContextSeedBatchOptions,
  dependencies: { readonly publisher?: MemberContextPublisher } = {},
): Promise<MemberContextSeedBatchReport> {
  const reports: MemberContextSeedReport[] = [];
  for (const target of MEMBER_CONTEXT_SEED_TARGETS) {
    const report = await runMemberContextSeed({
      mode: options.mode,
      expectedActiveRevisionId: options.expectedActiveRevisionId,
      sourcePath: target.sourcePath,
    }, dependencies);
    reports.push(report);
    if (options.mode !== "dry-run" && ["publication-failed", "validation-failed"].includes(report.outcome)) break;
  }

  let outcome: MemberContextSeedBatchReport["outcome"];
  if (reports.some((report) => report.outcome === "validation-failed")) outcome = "validation-failed";
  else if (reports.some((report) => report.outcome === "publication-failed")) outcome = "publication-failed";
  else if (options.mode === "dry-run") outcome = "validated";
  else if (options.mode === "stage") outcome = "staged";
  else if (options.mode === "inspect") outcome = reports.every((report) => report.outcome === "active") ? "active" : "missing";
  else outcome = reports.some((report) => report.outcome === "activated") ? "activated" : "already-active";

  return { outcome, reports };
}

function parseArguments(arguments_: readonly string[]): MemberContextSeedOptions {
  let mode: MemberContextSeedMode = "publish";
  let expectedActiveRevisionId: string | null | undefined;
  let sourcePath: MemberContextSeedSource | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    if (argument === "--dry-run") mode = "dry-run";
    else if (argument === "--stage") mode = "stage";
    else if (argument === "--inspect") mode = "inspect";
    else if (argument === "--expected-active") {
      const value = arguments_[index + 1];
      if (!value) throw new Error("missing_expected_active_revision");
      expectedActiveRevisionId = value === "none" ? null : value;
      index += 1;
    } else if (argument === "--member") {
      const value = arguments_[index + 1];
      const target = MEMBER_CONTEXT_SEED_TARGETS.find((candidate) => candidate.fixtureId === value || candidate.memberId === value);
      if (!target) throw new Error("unknown_member_seed_target");
      sourcePath = target.sourcePath;
      index += 1;
    } else throw new Error("unsupported_seed_argument");
  }
  if (expectedActiveRevisionId !== undefined && !sourcePath) throw new Error("expected_active_requires_member");
  return { mode, expectedActiveRevisionId, sourcePath };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === "dry-run") {
    const report = options.sourcePath
      ? await runMemberContextSeed(options)
      : await runAllMemberContextSeeds(options);
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const client = createNeo4jClient(memberContextNeo4jClientConfig());
  try {
    await client.verifyConnectivity();
    await setupMemberContextNeo4jSchema(client);
    const publisher = createNeo4jMemberContextPublisher(client);
    const report = options.sourcePath
      ? await runMemberContextSeed(options, { publisher })
      : await runAllMemberContextSeeds(options, { publisher });
    console.log(JSON.stringify(report, null, 2));
    if (["publication-failed", "validation-failed"].includes(report.outcome)) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({
      outcome: error instanceof MemberContextValidationError ? "validation-failed" : "failed",
      errorCode: error instanceof Error ? error.name : "UnknownError",
      ...(error instanceof MemberContextValidationError ? { validationErrorCount: error.errors.length } : {}),
    }));
    process.exitCode = 1;
  });
}
