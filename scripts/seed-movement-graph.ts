import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { MovementGraphPublisher, PublicationFailure } from "../src/domain/contracts/movement-graph-publication";
import type { MovementGraphSnapshot } from "../src/domain/contracts/movement-graph";
import {
  compileMovementGraph,
  movementGraphSources,
  type MovementGraphSources,
} from "../src/graph/ingest/movement-clinical";
import { createNeo4jClient, type Neo4jClientConfig } from "../src/graph/neo4j/client";
import { setupMovementNeo4jSchema } from "../src/graph/neo4j/movement-schema";
import { createNeo4jMovementPublisher } from "../src/graph/publication/neo4j-movement-publisher";
import { canonicalJson, sha256 } from "../src/graph/revisions/movement-graph";
import { validateMovementGraph } from "../src/graph/validation/movement-graph";

type SourceDigests = Readonly<Record<string, string>>;

export type PreparedMovementGraphSeed = {
  readonly status: "valid";
  readonly validationStatus: "valid";
  readonly snapshot: MovementGraphSnapshot;
  readonly canonicalDigest: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly sourceDigests: SourceDigests;
};

export type InvalidMovementGraphSeed = {
  readonly status: "invalid";
  readonly validationStatus: "invalid";
  readonly validationErrors: readonly string[];
};

export type MovementGraphSeedPreparation = PreparedMovementGraphSeed | InvalidMovementGraphSeed;

export type MovementGraphSeedMode =
  | { readonly mode: "dry-run" }
  | { readonly mode: "stage"; readonly clinicalReviewApprovalId: string }
  | {
      readonly mode: "activate";
      readonly clinicalReviewApprovalId: string;
      readonly expectedPriorRevisionId: string | null;
      readonly actorId: string;
    };

type MovementGraphSeedFailureCode = PublicationFailure["code"] | "invalid_seed";

export type MovementGraphSeedExecution = {
  readonly status: "ok";
  readonly validationStatus: "valid" | "sealed";
  readonly graphRevisionId: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly sourceDigests: SourceDigests;
  readonly activationOutcome: "not_requested" | "activated" | "already_active";
} | {
  readonly status: "failed";
  readonly validationStatus: "invalid" | "failed";
  readonly graphRevisionId: string;
  readonly failureCode: MovementGraphSeedFailureCode;
  readonly validationErrors: readonly string[];
};

const sourceReviewArtifactDigest = `sha256:${sha256(readFileSync(new URL("../data/movement-source-reviews.json", import.meta.url), "utf8"))}`;

type SourceReviewRecord = {
  readonly source_id?: string;
  readonly source_revision?: string;
  readonly source_release?: string;
  readonly review_status?: string;
  readonly license?: string | null;
  readonly hierarchy_imported?: boolean;
  readonly preferred_labels_modified?: boolean;
  readonly ontology_content_embedded?: boolean;
  readonly class_ids_embedded?: boolean;
  readonly review?: { readonly status?: string; readonly reviewer?: string; readonly reviewed_at?: string };
};

type SeedMappingRecord = {
  readonly status?: string;
  readonly mapping_id?: string;
  readonly verification_id?: string;
  readonly source_release?: string;
  readonly source_artifact_digest?: string;
  readonly source?: { readonly source_id?: string; readonly source_revision?: string };
};

function sourceReviewErrors(sources: MovementGraphSources): string[] {
  const sourceReviews = (sources.sourceReviews as unknown as { readonly records: readonly SourceReviewRecord[] }).records;
  const reviewsById = new Map(sourceReviews.map((record) => [record.source_id, record]));
  const errors: string[] = [];

  for (const review of sourceReviews) {
    if (review.review?.status !== "reviewed" || !review.review?.reviewer || !review.review?.reviewed_at) {
      errors.push(`unreviewed_source:${review.source_id ?? "unknown"}`);
    }
    if (review.source_id === "source:snomed-gps-license") {
      if (review.review_status !== "approved-for-bounded-mapping-metadata" || typeof review.license !== "string" || !review.license.trim()) {
        errors.push("unapproved_mapping_license:source:snomed-gps-license");
      }
      if (review.hierarchy_imported || review.preferred_labels_modified || review.ontology_content_embedded) {
        errors.push("license_scope_exceeded:source:snomed-gps-license");
      }
    }
    if (review.source_id === "source:ope-bioportal-0.0.1") {
      if (review.review_status !== "citation-only" || review.license !== null || review.ontology_content_embedded || review.class_ids_embedded) {
        errors.push("unlicensed_ontology_content:source:ope-bioportal-0.0.1");
      }
    }
  }

  const mappings = (sources.mappings as unknown as { readonly records: readonly SeedMappingRecord[] }).records;
  for (const mapping of mappings) {
    const source = reviewsById.get(mapping.source?.source_id);
    if (!source || source.source_revision !== mapping.source?.source_revision || source.source_release !== mapping.source_release) {
      errors.push(`unreviewed_mapping_source:${mapping.mapping_id ?? mapping.verification_id ?? "unknown"}`);
      continue;
    }
    if (mapping.status === "reviewed") {
      if (mapping.source_artifact_digest !== sourceReviewArtifactDigest) {
        errors.push(`mapping_source_digest_mismatch:${mapping.mapping_id ?? "unknown"}`);
      }
      if (source.review_status !== "approved-for-bounded-mapping-metadata" || typeof source.license !== "string") {
        errors.push(`mapping_license_not_approved:${mapping.mapping_id ?? "unknown"}`);
      }
    } else if (mapping.status === "local-only" && source.review_status !== "citation-only") {
      errors.push(`local_only_source_not_citation_only:${mapping.verification_id ?? "unknown"}`);
    }
  }
  return [...new Set(errors)].sort();
}

export function prepareMovementGraphSeed(sources: unknown = movementGraphSources): MovementGraphSeedPreparation {
  const compiled = compileMovementGraph(sources);
  if (compiled.status === "invalid") {
    return {
      status: "invalid",
      validationStatus: "invalid",
      validationErrors: compiled.report.errors.map((error) => error.assertionId ? `${error.code}:${error.assertionId}` : error.code).sort(),
    };
  }
  const gateErrors = sourceReviewErrors(sources as MovementGraphSources);
  if (gateErrors.length > 0) return { status: "invalid", validationStatus: "invalid", validationErrors: gateErrors };
  const revision = compiled.snapshot.nodes.find((node) => node.kind === "graph-revision");
  if (!revision || revision.kind !== "graph-revision") {
    return { status: "invalid", validationStatus: "invalid", validationErrors: ["missing_graph_revision"] };
  }
  return {
    status: "valid",
    validationStatus: "valid",
    snapshot: compiled.snapshot,
    canonicalDigest: `sha256:${sha256(canonicalJson(compiled.snapshot))}`,
    nodeCount: compiled.snapshot.nodes.length,
    edgeCount: compiled.snapshot.edges.length,
    sourceDigests: revision.sourceDigests,
  };
}

function failure(
  seed: PreparedMovementGraphSeed,
  code: MovementGraphSeedFailureCode,
  validationErrors: readonly string[] = [],
): MovementGraphSeedExecution {
  return {
    status: "failed",
    validationStatus: code === "validation_failed" || code === "invalid_seed" ? "invalid" : "failed",
    graphRevisionId: seed.snapshot.graphRevisionId,
    failureCode: code,
    validationErrors,
  };
}

export async function executePreparedMovementGraphSeed(
  publisher: MovementGraphPublisher | undefined,
  seed: PreparedMovementGraphSeed,
  options: MovementGraphSeedMode,
): Promise<MovementGraphSeedExecution> {
  const digest = `sha256:${sha256(canonicalJson(seed.snapshot))}`;
  const report = validateMovementGraph(seed.snapshot);
  const integrityErrors = [
    ...(report.status === "invalid" ? report.errors.map((error) => error.code) : []),
    ...(digest === seed.canonicalDigest ? [] : ["canonical_digest_mismatch"]),
    ...(seed.nodeCount === seed.snapshot.nodes.length ? [] : ["node_count_mismatch"]),
    ...(seed.edgeCount === seed.snapshot.edges.length ? [] : ["edge_count_mismatch"]),
  ];
  if (integrityErrors.length > 0) return failure(seed, "validation_failed", integrityErrors);

  if (options.mode === "dry-run") {
    return {
      status: "ok",
      validationStatus: "valid",
      graphRevisionId: seed.snapshot.graphRevisionId,
      nodeCount: seed.nodeCount,
      edgeCount: seed.edgeCount,
      sourceDigests: seed.sourceDigests,
      activationOutcome: "not_requested",
    };
  }
  if (!publisher) return failure(seed, "publication_unavailable");

  const staged = await publisher.stage({
    snapshot: seed.snapshot,
    canonicalDigest: seed.canonicalDigest,
    nodeCount: seed.nodeCount,
    edgeCount: seed.edgeCount,
  });
  if (staged.status === "failed") {
    return failure(seed, staged.failure.code, staged.failure.code === "validation_failed" ? staged.failure.errors : []);
  }
  const validated = await publisher.validate({
    publicationAttemptId: staged.data.publicationAttemptId,
    clinicalReviewApprovalId: options.clinicalReviewApprovalId,
  });
  if (validated.status === "failed") {
    return failure(seed, validated.failure.code, validated.failure.code === "validation_failed" ? validated.failure.errors : []);
  }
  if (options.mode === "stage") {
    return {
      status: "ok",
      validationStatus: "sealed",
      graphRevisionId: seed.snapshot.graphRevisionId,
      nodeCount: seed.nodeCount,
      edgeCount: seed.edgeCount,
      sourceDigests: seed.sourceDigests,
      activationOutcome: "not_requested",
    };
  }
  const activated = await publisher.activate({
    graphRevisionId: seed.snapshot.graphRevisionId,
    expectedPriorRevisionId: options.expectedPriorRevisionId,
    actorId: options.actorId,
  });
  if (activated.status === "failed") return failure(seed, activated.failure.code);
  return {
    status: "ok",
    validationStatus: "sealed",
    graphRevisionId: seed.snapshot.graphRevisionId,
    nodeCount: seed.nodeCount,
    edgeCount: seed.edgeCount,
    sourceDigests: seed.sourceDigests,
    activationOutcome: activated.data.state,
  };
}

function argumentValue(args: readonly string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function clientConfig(): Neo4jClientConfig {
  return {
    uri: process.env.NEO4J_URI,
    username: process.env.NEO4J_USERNAME,
    password: process.env.NEO4J_PASSWORD,
    database: process.env.NEO4J_DATABASE,
    environment: process.env.NODE_ENV ?? "development",
  };
}

type MovementGraphSeedCliPublisherSession = {
  readonly publisher: MovementGraphPublisher;
  readonly close: () => Promise<void>;
};

export type MovementGraphSeedCliDependencies = {
  readonly prepareSeed?: () => MovementGraphSeedPreparation;
  readonly openPublisher?: () => Promise<MovementGraphSeedCliPublisherSession>;
  readonly writeOutput?: (output: string) => void;
  readonly setExitCode?: (exitCode: number) => void;
};

async function openMovementGraphSeedPublisher(): Promise<MovementGraphSeedCliPublisherSession> {
  const client = createNeo4jClient(clientConfig());
  try {
    await client.verifyConnectivity();
    await setupMovementNeo4jSchema(client);
    return {
      publisher: createNeo4jMovementPublisher(client),
      close: () => client.close(),
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function runMovementGraphSeedCli(
  args: readonly string[],
  dependencies: MovementGraphSeedCliDependencies = {},
) {
  const prepareSeed = dependencies.prepareSeed ?? prepareMovementGraphSeed;
  const openPublisher = dependencies.openPublisher ?? openMovementGraphSeedPublisher;
  const writeOutput = dependencies.writeOutput ?? ((output: string) => process.stdout.write(output));
  const setExitCode = dependencies.setExitCode ?? ((exitCode: number) => { process.exitCode = exitCode; });
  const action = args[0] ?? "seed";

  if (action === "inspect") {
    const session = await openPublisher();
    try {
      const revisionId = argumentValue(args, "--revision");
      const inspection = await session.publisher.inspect(revisionId);
      const safeOutput = inspection.status === "ok"
        ? {
            validationStatus: inspection.data.state,
            activeRevisionId: inspection.data.activeRevisionId,
            ...(inspection.data.revisionId ? { graphRevisionId: inspection.data.revisionId } : {}),
          }
        : { validationStatus: "failed", failureCode: inspection.failure.code };
      writeOutput(`${JSON.stringify(safeOutput)}\n`);
      if (inspection.status === "failed") setExitCode(1);
      return;
    } finally {
      await session.close();
    }
  }

  const seed = prepareSeed();
  if (seed.status === "invalid") {
    writeOutput(`${JSON.stringify(seed)}\n`);
    setExitCode(1);
    return;
  }
  if (action === "seed" && args.includes("--dry-run")) {
    writeOutput(`${JSON.stringify(await executePreparedMovementGraphSeed(undefined, seed, { mode: "dry-run" }))}\n`);
    return;
  }

  const session = await openPublisher();
  try {
    if (action !== "seed") throw new Error("Expected seed or inspect command");

    const activate = args.includes("--activate");
    const expectedPrior = argumentValue(args, "--expected-prior");
    if (activate && expectedPrior === undefined) throw new Error("--activate requires --expected-prior <revision-id|null>");
    const mode: MovementGraphSeedMode = activate
      ? {
          mode: "activate",
          clinicalReviewApprovalId: "clinical-review:manifest:clinical-rules:v1",
          expectedPriorRevisionId: expectedPrior === "null" ? null : expectedPrior!,
          actorId: argumentValue(args, "--actor") ?? "curator:local-seed-command",
        }
      : { mode: "stage", clinicalReviewApprovalId: "clinical-review:manifest:clinical-rules:v1" };
    const result = await executePreparedMovementGraphSeed(session.publisher, seed, mode);
    writeOutput(`${JSON.stringify(result)}\n`);
    if (result.status === "failed") setExitCode(1);
  } finally {
    await session.close();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  runMovementGraphSeedCli(process.argv.slice(2)).catch(() => {
    process.stdout.write(`${JSON.stringify({ validationStatus: "failed", failureCode: "publication_unavailable" })}\n`);
    process.exitCode = 1;
  });
}
