import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import type { MemberContextGraphSnapshot } from "../src/domain/contracts/member-context";
import type { MemberContextPublisher } from "../src/domain/contracts/member-context-publication";
import { compileMemberContextGraph } from "../src/graph/ingest/member-context";
import { createNeo4jClient } from "../src/graph/neo4j/client";
import { setupMemberContextNeo4jSchema } from "../src/graph/neo4j/member-context-schema";
import { createNeo4jMemberContextPublisher } from "../src/graph/publication/neo4j-member-context-publisher";
import { canonicalMemberContextDigest } from "../src/graph/revisions/member-context";
import {
  MemberContextValidationError,
  validateMemberContextGraph,
} from "../src/graph/validation/member-context";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
export const MEMBER_CONTEXT_SEED_SOURCE = "data/member-context.json";
const trackedSourcePath = path.join(repositoryRoot, MEMBER_CONTEXT_SEED_SOURCE);

export type MemberContextSeedMode = "dry-run" | "publish" | "inspect";

export type MemberContextSeedOptions = {
  readonly mode: MemberContextSeedMode;
  readonly expectedActiveRevisionId?: string | null;
  /** Integration seam; the command-line entry always compiles the tracked source. */
  readonly snapshot?: MemberContextGraphSnapshot;
};

export type MemberContextSeedReport = {
  readonly outcome:
    | "validated"
    | "activated"
    | "already-active"
    | "active"
    | "missing"
    | "validation-failed"
    | "publication-failed";
  readonly sourcePath: typeof MEMBER_CONTEXT_SEED_SOURCE;
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
  readonly publicationFailureCode?: string;
};

async function compileTrackedSource(): Promise<MemberContextGraphSnapshot> {
  const source = JSON.parse(await readFile(trackedSourcePath, "utf8")) as unknown;
  return compileMemberContextGraph(source as never);
}

function baseReport(snapshot: MemberContextGraphSnapshot, valid: boolean, validationErrorCount: number) {
  return {
    sourcePath: MEMBER_CONTEXT_SEED_SOURCE,
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
  const snapshot = options.snapshot ?? await compileTrackedSource();
  const validation = validateMemberContextGraph(snapshot);
  const base = baseReport(snapshot, validation.valid, validation.errors.length);
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
    return {
      ...base,
      outcome: activeRevisionBefore ? "active" : "missing",
      activeRevisionBefore,
      activeRevisionAfter: activeRevisionBefore,
    };
  }
  if (activeRevisionBefore === snapshot.contextRevisionId) {
    return {
      ...base,
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
  const after = await publisher.inspect(snapshot.memberId);
  return {
    ...base,
    outcome: activated.data.state === "already-active" ? "already-active" : "activated",
    activeRevisionBefore,
    activeRevisionAfter: after.status === "ok" ? after.data.activeRevisionId : snapshot.contextRevisionId,
  };
}

function parseArguments(arguments_: readonly string[]): MemberContextSeedOptions {
  let mode: MemberContextSeedMode = "publish";
  let expectedActiveRevisionId: string | null | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    if (argument === "--dry-run") mode = "dry-run";
    else if (argument === "--inspect") mode = "inspect";
    else if (argument === "--expected-active") {
      const value = arguments_[index + 1];
      if (!value) throw new Error("missing_expected_active_revision");
      expectedActiveRevisionId = value === "none" ? null : value;
      index += 1;
    } else throw new Error("unsupported_seed_argument");
  }
  return { mode, expectedActiveRevisionId };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === "dry-run") {
    console.log(JSON.stringify(await runMemberContextSeed(options), null, 2));
    return;
  }
  const client = createNeo4jClient({ environment: process.env.NODE_ENV ?? "development" });
  try {
    await client.verifyConnectivity();
    await setupMemberContextNeo4jSchema(client);
    const report = await runMemberContextSeed(options, {
      publisher: createNeo4jMemberContextPublisher(client),
    });
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
