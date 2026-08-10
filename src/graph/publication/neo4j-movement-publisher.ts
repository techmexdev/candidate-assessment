import { randomUUID } from "node:crypto";
import type {
  ActivateRevisionRequest,
  ActivatedRevision,
  MovementGraphPublisher,
  PublicationInspection,
  PublicationResult,
  StageRevisionRequest,
  StagedRevision,
  ValidatedRevision,
  ValidateRevisionRequest,
} from "../../domain/contracts/movement-graph-publication";
import { MOVEMENT_CYPHER } from "../cypher/movement";
import type { Neo4jClient, Neo4jRecord, Neo4jTransaction } from "../neo4j/client";
import { readCanonicalMovementSnapshot } from "../repositories/neo4j-movement-graph";
import { canonicalJson, sha256 } from "../revisions/movement-graph";
import { validateMovementGraph } from "../validation/movement-graph";

type PublisherOptions = {
  readonly now?: () => string;
  readonly createId?: (kind: "activation-event") => string;
  readonly failureInjection?: "after_nodes" | "after_stage_commit";
};

const text = (value: unknown) => typeof value === "string" ? value : undefined;
const nullableText = (value: unknown) => typeof value === "string" ? value : null;
const attemptIdFor = (revisionId: string, digest: string) => `publication-attempt:${sha256(canonicalJson({ revisionId, digest }))}`;
const sealIdFor = (revisionId: string, digest: string) => `revision-seal:${sha256(canonicalJson({ revisionId, digest }))}`;
const validationStrings = (errors: readonly { code: string; assertionId?: string }[]) => errors.map((error) => error.assertionId ? `${error.code}:${error.assertionId}` : error.code).sort();
const unavailable = <T>(error: unknown): PublicationResult<T> => ({ status: "failed", failure: { code: "publication_unavailable", message: error instanceof Error ? error.message : "Neo4j publication failed" } });

async function existingStage(transaction: Neo4jTransaction, request: StageRevisionRequest): Promise<PublicationResult<StagedRevision> | undefined> {
  const stored = await readCanonicalMovementSnapshot(transaction, request.snapshot.graphRevisionId);
  if (!stored) return undefined;
  if (canonicalJson(stored) !== canonicalJson(request.snapshot)) {
    return { status: "failed", failure: { code: "immutable_payload_conflict", graphRevisionId: request.snapshot.graphRevisionId } };
  }
  return { status: "ok", data: { publicationAttemptId: attemptIdFor(request.snapshot.graphRevisionId, request.canonicalDigest), graphRevisionId: request.snapshot.graphRevisionId, state: "already_staged" } };
}

function attemptFrom(record: Neo4jRecord | undefined) {
  if (!record) return undefined;
  const attemptId = text(record.get("attemptId"));
  const revisionId = text(record.get("revisionId"));
  const requestedDigest = text(record.get("requestedDigest"));
  if (!attemptId || !revisionId || !requestedDigest) return undefined;
  return { attemptId, revisionId, requestedDigest, requestedNodeCount: Number(record.get("requestedNodeCount")), requestedEdgeCount: Number(record.get("requestedEdgeCount")), state: text(record.get("state")) };
}

class Neo4jMovementPublisher implements MovementGraphPublisher {
  private readonly now: () => string;
  private readonly createId: (kind: "activation-event") => string;
  constructor(private readonly client: Neo4jClient, private readonly options: PublisherOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => `activation-event:${randomUUID()}`);
  }

  async stage(request: StageRevisionRequest): Promise<PublicationResult<StagedRevision>> {
    const report = validateMovementGraph(request.snapshot);
    const computedDigest = `sha256:${sha256(canonicalJson(request.snapshot))}`;
    const requestErrors = [
      ...(report.status === "invalid" ? validationStrings(report.errors) : []),
      ...(request.snapshot.graphRevisionId.trim() ? [] : ["missing_revision_id"]),
      ...(computedDigest === request.canonicalDigest ? [] : ["canonical_digest_mismatch"]),
      ...(request.nodeCount === request.snapshot.nodes.length ? [] : ["node_count_mismatch"]),
      ...(request.edgeCount === request.snapshot.edges.length ? [] : ["edge_count_mismatch"]),
    ];
    if (requestErrors.length) return { status: "failed", failure: { code: "validation_failed", graphRevisionId: request.snapshot.graphRevisionId, errors: requestErrors } };

    const attemptId = attemptIdFor(request.snapshot.graphRevisionId, request.canonicalDigest);
    const stagedAt = this.now();
    try {
      const result = await this.client.executeWrite(async (transaction): Promise<PublicationResult<StagedRevision>> => {
        const existing = await existingStage(transaction, request);
        if (existing) return existing;
        const parameters = { revisionId: request.snapshot.graphRevisionId, canonicalDigest: request.canonicalDigest, nodeCount: request.nodeCount, edgeCount: request.edgeCount, attemptId, stagedAt };
        await transaction.run(MOVEMENT_CYPHER.createStage, parameters);
        await transaction.run(MOVEMENT_CYPHER.createNodes, {
          revisionId: request.snapshot.graphRevisionId,
          nodes: request.snapshot.nodes.map((node) => ({ conceptId: node.conceptId, assertionId: node.assertionId, kind: node.kind, payload: canonicalJson(node) })),
        });
        if (this.options.failureInjection === "after_nodes") throw new Error("Injected failure after node writes");
        await transaction.run(MOVEMENT_CYPHER.createEdges, {
          revisionId: request.snapshot.graphRevisionId,
          edges: request.snapshot.edges.map((edge) => ({ fromConceptId: edge.fromConceptId, toConceptId: edge.toConceptId, assertionId: edge.assertionId, kind: edge.kind, payload: canonicalJson(edge) })),
        });
        return { status: "ok", data: { publicationAttemptId: attemptId, graphRevisionId: request.snapshot.graphRevisionId, state: "staged" } };
      });
      if (this.options.failureInjection === "after_stage_commit") throw new Error("Injected interruption after stage commit");
      return result;
    } catch (error) {
      if (this.options.failureInjection !== "after_nodes" && this.options.failureInjection !== "after_stage_commit") {
        try {
          const concurrent = await this.client.executeRead((transaction) => existingStage(transaction, request));
          if (concurrent) return concurrent;
        } catch { /* preserve the originating infrastructure failure */ }
      }
      return unavailable(error);
    }
  }

  async validate(request: ValidateRevisionRequest): Promise<PublicationResult<ValidatedRevision>> {
    const validatedAt = this.now();
    try {
      return await this.client.executeWrite(async (transaction): Promise<PublicationResult<ValidatedRevision>> => {
        const attemptResult = await transaction.run(MOVEMENT_CYPHER.findAttempt, { attemptId: request.publicationAttemptId });
        const attempt = attemptFrom(attemptResult.records[0]);
        if (!attempt) return { status: "failed", failure: { code: "publication_unavailable", message: "Publication attempt was not found" } };
        let snapshot;
        try { snapshot = await readCanonicalMovementSnapshot(transaction, attempt.revisionId); } catch { snapshot = undefined; }
        if (!snapshot) {
          const errors = ["canonical_readback_failed"];
          await transaction.run(MOVEMENT_CYPHER.rejectAttempt, { attemptId: attempt.attemptId, validationErrors: errors, validatedAt });
          return { status: "failed", failure: { code: "validation_failed", graphRevisionId: attempt.revisionId, errors } };
        }
        if (!request.clinicalReviewApprovalId?.trim()) {
          return { status: "failed", failure: { code: "clinical_review_required", graphRevisionId: attempt.revisionId } };
        }
        const report = validateMovementGraph(snapshot);
        const canonicalDigest = `sha256:${sha256(canonicalJson(snapshot))}`;
        const errors = [
          ...(report.status === "invalid" ? validationStrings(report.errors) : []),
          ...(snapshot.nodes.some((node) => node.kind === "clinical-rule") ? [] : ["missing_clinical_rules"]),
          ...(canonicalDigest === attempt.requestedDigest ? [] : ["canonical_digest_mismatch"]),
          ...(snapshot.nodes.length === attempt.requestedNodeCount ? [] : ["node_count_mismatch"]),
          ...(snapshot.edges.length === attempt.requestedEdgeCount ? [] : ["edge_count_mismatch"]),
        ];
        if (errors.length) {
          await transaction.run(MOVEMENT_CYPHER.rejectAttempt, { attemptId: attempt.attemptId, validationErrors: errors, validatedAt });
          return { status: "failed", failure: { code: "validation_failed", graphRevisionId: attempt.revisionId, errors } };
        }
        const sealId = sealIdFor(attempt.revisionId, canonicalDigest);
        await transaction.run(MOVEMENT_CYPHER.sealRevision, {
          attemptId: attempt.attemptId, revisionId: attempt.revisionId, sealId, canonicalDigest,
          nodeCount: snapshot.nodes.length, edgeCount: snapshot.edges.length,
          clinicalReviewApprovalId: request.clinicalReviewApprovalId, sealedAt: validatedAt,
        });
        return { status: "ok", data: { publicationAttemptId: attempt.attemptId, graphRevisionId: attempt.revisionId, sealId, canonicalDigest, nodeCount: snapshot.nodes.length, edgeCount: snapshot.edges.length } };
      });
    } catch (error) { return unavailable(error); }
  }

  async activate(request: ActivateRevisionRequest): Promise<PublicationResult<ActivatedRevision>> {
    if (!request.graphRevisionId.trim() || !request.actorId.trim()) return unavailable(new Error("Activation revision and actor IDs are required"));
    const activatedAt = this.now();
    const rawEventId = this.createId("activation-event");
    const activationEventId = `${rawEventId}:${sha256(canonicalJson({ graphRevisionId: request.graphRevisionId, expectedPriorRevisionId: request.expectedPriorRevisionId, actorId: request.actorId, activatedAt }))}`;
    try {
      return await this.client.executeWrite(async (transaction): Promise<PublicationResult<ActivatedRevision>> => {
        const locked = await transaction.run(MOVEMENT_CYPHER.activateRevision, { revisionId: request.graphRevisionId });
        const record = locked.records[0];
        const actualRevisionId = nullableText(record?.get("actualRevisionId"));
        if (actualRevisionId === request.graphRevisionId) return { status: "ok", data: { graphRevisionId: request.graphRevisionId, priorRevisionId: actualRevisionId, activationEventId, state: "already_active" } };
        if (actualRevisionId !== request.expectedPriorRevisionId) return { status: "failed", failure: { code: "stale_revision", expectedPriorRevisionId: request.expectedPriorRevisionId, actualRevisionId } };
        if (!text(record?.get("sealId"))) return { status: "failed", failure: { code: "not_sealed", graphRevisionId: request.graphRevisionId } };
        let snapshot;
        try { snapshot = await readCanonicalMovementSnapshot(transaction, request.graphRevisionId); } catch { snapshot = undefined; }
        const canonicalDigest = snapshot ? `sha256:${sha256(canonicalJson(snapshot))}` : undefined;
        if (!snapshot || validateMovementGraph(snapshot).status !== "valid"
          || canonicalDigest !== text(record?.get("canonicalDigest"))
          || snapshot.nodes.length !== Number(record?.get("nodeCount"))
          || snapshot.edges.length !== Number(record?.get("edgeCount"))) {
          return { status: "failed", failure: { code: "not_sealed", graphRevisionId: request.graphRevisionId } };
        }
        await transaction.run(MOVEMENT_CYPHER.swapActiveRevision, { revisionId: request.graphRevisionId, priorRevisionId: actualRevisionId, actorId: request.actorId, activatedAt, eventId: activationEventId });
        return { status: "ok", data: { graphRevisionId: request.graphRevisionId, priorRevisionId: actualRevisionId, activationEventId, state: "activated" } };
      });
    } catch (error) { return unavailable(error); }
  }

  async inspect(revisionId?: string): Promise<PublicationResult<PublicationInspection>> {
    try {
      return await this.client.executeRead(async (transaction): Promise<PublicationResult<PublicationInspection>> => {
        if (!revisionId) {
          const result = await transaction.run(MOVEMENT_CYPHER.inspectCatalog);
          const activeRevisionId = nullableText(result.records[0]?.get("activeRevisionId"));
          return { status: "ok", data: { activeRevisionId, state: activeRevisionId ? "active" : "missing", validationErrors: [] } };
        }
        const result = await transaction.run(MOVEMENT_CYPHER.inspect, { revisionId });
        const record = result.records[0];
        const activeRevisionId = nullableText(record?.get("activeRevisionId"));
        const foundRevision = text(record?.get("revisionId"));
        const attemptState = text(record?.get("attemptState"));
        const state: PublicationInspection["state"] = activeRevisionId === revisionId ? "active" : text(record?.get("sealId")) ? "sealed" : attemptState === "rejected" ? "rejected" : attemptState === "abandoned" ? "abandoned" : foundRevision ? "staged" : "missing";
        const validationErrors = Array.isArray(record?.get("validationErrors")) ? record!.get("validationErrors") as string[] : [];
        const sealId = text(record?.get("sealId"));
        const canonicalDigest = text(record?.get("canonicalDigest"));
        const nodeCount = Number(record?.get("nodeCount"));
        const edgeCount = Number(record?.get("edgeCount"));
        return {
          status: "ok",
          data: {
            activeRevisionId,
            ...(foundRevision ? { revisionId: foundRevision } : {}),
            ...(text(record?.get("attemptId")) ? { publicationAttemptId: text(record?.get("attemptId"))! } : {}),
            ...(sealId ? { sealId } : {}),
            ...(canonicalDigest ? { canonicalDigest } : {}),
            ...(Number.isFinite(nodeCount) ? { nodeCount } : {}),
            ...(Number.isFinite(edgeCount) ? { edgeCount } : {}),
            state,
            validationErrors,
          },
        };
      });
    } catch (error) { return unavailable(error); }
  }
}

export function createNeo4jMovementPublisher(client: Neo4jClient, options: PublisherOptions = {}): MovementGraphPublisher {
  return new Neo4jMovementPublisher(client, options);
}
