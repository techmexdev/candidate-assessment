import { randomUUID } from "node:crypto";
import type {
  ActivateMemberContextRevisionRequest,
  ActivatedMemberContextRevision,
  MemberContextPublicationInspection,
  MemberContextPublicationResult,
  MemberContextPublisher,
  StageMemberContextRevisionRequest,
  StagedMemberContextRevision,
  ValidateMemberContextRevisionRequest,
  ValidatedMemberContextRevision,
} from "../../domain/contracts/member-context-publication";
import type { MemberContextGraphNode } from "../../domain/contracts/member-context";
import { MEMBER_CONTEXT_CYPHER } from "../cypher/member-context";
import { MEMBER_CONTEXT_NEO4J_LIMITS } from "../neo4j/member-context-schema";
import type { Neo4jClient, Neo4jRecord, Neo4jTransaction } from "../neo4j/client";
import { readCanonicalMemberContextSnapshot } from "../repositories/neo4j-member-context";
import { canonicalJson, canonicalMemberContextDigest, sha256 } from "../revisions/member-context";
import { validateMemberContextGraph } from "../validation/member-context";

export type Neo4jMemberContextPublisherOptions = {
  readonly now?: () => string;
  readonly createId?: (kind: "activation-event") => string;
  readonly failureInjection?: "after_nodes" | "after_stage_commit";
};

const text = (value: unknown) => typeof value === "string" ? value : undefined;
const nullableText = (value: unknown) => typeof value === "string" ? value : null;
const unavailable = <T>(): MemberContextPublicationResult<T> => ({
  status: "failed",
  failure: { code: "publication_unavailable", message: "Member context publication is unavailable." },
});
const attemptIdFor = (memberId: string, revisionId: string, digest: string) => (
  `member-publication-attempt:${sha256(canonicalJson({ digest, memberId, revisionId }))}`
);
const sealIdFor = (memberId: string, revisionId: string, digest: string) => (
  `member-revision-seal:${sha256(canonicalJson({ digest, memberId, revisionId }))}`
);

function temporalProperties(node: MemberContextGraphNode) {
  if (!("temporal" in node)) {
    return { temporalPrecision: null, effectiveAt: null, effectiveOn: null, sourceOrder: null };
  }
  const temporal = node.temporal;
  return {
    temporalPrecision: temporal.precision,
    effectiveAt: temporal.precision === "exact-timestamp" ? temporal.effectiveAt : null,
    effectiveOn: temporal.precision === "date" ? temporal.effectiveOn : null,
    sourceOrder: "sourceOrder" in node ? node.sourceOrder : temporal.precision === "relative-order" ? temporal.sourceOrder : null,
  };
}

type StoredAttempt = {
  readonly attemptId: string;
  readonly memberId: string;
  readonly contextRevisionId: string;
  readonly requestedDigest: string;
  readonly requestedNodeCount: number;
  readonly requestedRelationshipCount: number;
};

function attemptFrom(record: Neo4jRecord | undefined): StoredAttempt | undefined {
  if (!record) return undefined;
  const attemptId = text(record.get("attemptId"));
  const memberId = text(record.get("memberId"));
  const contextRevisionId = text(record.get("contextRevisionId"));
  const requestedDigest = text(record.get("requestedDigest"));
  if (!attemptId || !memberId || !contextRevisionId || !requestedDigest) return undefined;
  return {
    attemptId,
    memberId,
    contextRevisionId,
    requestedDigest,
    requestedNodeCount: Number(record.get("requestedNodeCount")),
    requestedRelationshipCount: Number(record.get("requestedRelationshipCount")),
  };
}

async function existingStage(
  transaction: Neo4jTransaction,
  request: StageMemberContextRevisionRequest,
): Promise<MemberContextPublicationResult<StagedMemberContextRevision> | undefined> {
  const { memberId, contextRevisionId } = request.snapshot;
  const found = await transaction.run(MEMBER_CONTEXT_CYPHER.findRevision, { memberId, contextRevisionId });
  if (found.records.length === 0) return undefined;
  const stored = await readCanonicalMemberContextSnapshot(transaction, memberId, contextRevisionId);
  if (!stored || canonicalJson(stored) !== canonicalJson(request.snapshot)) {
    return { status: "failed", failure: { code: "immutable_payload_conflict", memberId, contextRevisionId } };
  }
  return {
    status: "ok",
    data: {
      publicationAttemptId: attemptIdFor(memberId, contextRevisionId, request.canonicalDigest),
      memberId,
      contextRevisionId,
      state: "already-staged",
    },
  };
}

class Neo4jMemberContextPublisher implements MemberContextPublisher {
  private readonly now: () => string;
  private readonly createId: (kind: "activation-event") => string;

  constructor(
    private readonly client: Neo4jClient,
    private readonly options: Neo4jMemberContextPublisherOptions,
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => `member-activation-event:${randomUUID()}`);
  }

  async stage(request: StageMemberContextRevisionRequest): Promise<MemberContextPublicationResult<StagedMemberContextRevision>> {
    const { snapshot } = request;
    const graphValidation = validateMemberContextGraph(snapshot);
    const computedDigest = canonicalMemberContextDigest(snapshot);
    const envelopeErrors = [
      ...(snapshot.memberId.trim() ? [] : ["missing_member_id"]),
      ...(snapshot.contextRevisionId.trim() ? [] : ["missing_revision_id"]),
      ...(computedDigest === request.canonicalDigest ? [] : ["canonical_digest_mismatch"]),
      ...(snapshot.nodes.length === request.nodeCount ? [] : ["node_count_mismatch"]),
      ...(snapshot.relationships.length === request.relationshipCount ? [] : ["relationship_count_mismatch"]),
      ...(snapshot.nodes.length <= MEMBER_CONTEXT_NEO4J_LIMITS.maxNodesPerRevision ? [] : ["node_limit_exceeded"]),
      ...(snapshot.relationships.length <= MEMBER_CONTEXT_NEO4J_LIMITS.maxRelationshipsPerRevision ? [] : ["relationship_limit_exceeded"]),
    ];
    if (envelopeErrors.length > 0) {
      return {
        status: "failed",
        failure: { code: "validation_failed", memberId: snapshot.memberId, contextRevisionId: snapshot.contextRevisionId, errors: envelopeErrors },
      };
    }
    const graphErrors = graphValidation.valid ? [] : graphValidation.errors;
    const publicationAttemptId = attemptIdFor(snapshot.memberId, snapshot.contextRevisionId, request.canonicalDigest);
    const stagedAt = this.now();

    try {
      const result = await this.client.executeWrite(async (transaction): Promise<MemberContextPublicationResult<StagedMemberContextRevision>> => {
        const existing = await existingStage(transaction, request);
        if (existing) return existing;
        if (graphErrors.length > 0) {
          return {
            status: "failed",
            failure: { code: "validation_failed", memberId: snapshot.memberId, contextRevisionId: snapshot.contextRevisionId, errors: graphErrors },
          };
        }
        const common = {
          memberId: snapshot.memberId,
          contextRevisionId: snapshot.contextRevisionId,
          canonicalDigest: request.canonicalDigest,
          nodeCount: request.nodeCount,
          relationshipCount: request.relationshipCount,
          sourceArtifactDigest: snapshot.sourceArtifactDigest,
          attemptId: publicationAttemptId,
          stagedAt,
        };
        await transaction.run(MEMBER_CONTEXT_CYPHER.createStage, common);
        await transaction.run(MEMBER_CONTEXT_CYPHER.createNodes, {
          memberId: snapshot.memberId,
          contextRevisionId: snapshot.contextRevisionId,
          nodes: snapshot.nodes.map((node, recordOrder) => ({
            semanticId: node.semanticId,
            assertionId: "assertionId" in node ? node.assertionId : null,
            kind: node.kind,
            recordOrder,
            ...temporalProperties(node),
            payload: canonicalJson(node),
          })),
        });
        if (this.options.failureInjection === "after_nodes") throw new Error("injected_member_context_stage_failure");
        await transaction.run(MEMBER_CONTEXT_CYPHER.createRelationships, {
          memberId: snapshot.memberId,
          contextRevisionId: snapshot.contextRevisionId,
          relationships: snapshot.relationships.map((relationship, recordOrder) => ({
            assertionId: relationship.assertionId,
            kind: relationship.kind,
            fromSemanticId: relationship.fromSemanticId,
            toSemanticId: relationship.toSemanticId,
            recordOrder,
            sourceOrder: relationship.sourceOrder ?? null,
            payload: canonicalJson(relationship),
          })),
        });
        return {
          status: "ok",
          data: {
            publicationAttemptId,
            memberId: snapshot.memberId,
            contextRevisionId: snapshot.contextRevisionId,
            state: "staged",
          },
        };
      });
      if (this.options.failureInjection === "after_stage_commit") throw new Error("injected_member_context_post_stage_failure");
      return result;
    } catch {
      if (!this.options.failureInjection) {
        try {
          const concurrent = await this.client.executeRead((transaction) => existingStage(transaction, request));
          if (concurrent) return concurrent;
        } catch { /* retain the generic originating infrastructure result */ }
      }
      return unavailable();
    }
  }

  async validate(request: ValidateMemberContextRevisionRequest): Promise<MemberContextPublicationResult<ValidatedMemberContextRevision>> {
    const validatedAt = this.now();
    try {
      return await this.client.executeWrite(async (transaction): Promise<MemberContextPublicationResult<ValidatedMemberContextRevision>> => {
        const result = await transaction.run(MEMBER_CONTEXT_CYPHER.findAttempt, { attemptId: request.publicationAttemptId });
        const attempt = attemptFrom(result.records[0]);
        if (!attempt) return unavailable();
        let snapshot;
        try {
          snapshot = await readCanonicalMemberContextSnapshot(transaction, attempt.memberId, attempt.contextRevisionId);
        } catch {
          snapshot = undefined;
        }
        const validation = snapshot ? validateMemberContextGraph(snapshot) : undefined;
        const canonicalDigest = snapshot ? canonicalMemberContextDigest(snapshot) : undefined;
        const errors = [
          ...(snapshot ? [] : ["canonical_readback_failed"]),
          ...(validation?.valid === false ? validation.errors : []),
          ...(canonicalDigest === attempt.requestedDigest ? [] : ["canonical_digest_mismatch"]),
          ...(snapshot?.nodes.length === attempt.requestedNodeCount ? [] : ["node_count_mismatch"]),
          ...(snapshot?.relationships.length === attempt.requestedRelationshipCount ? [] : ["relationship_count_mismatch"]),
        ];
        if (!snapshot || !canonicalDigest || errors.length > 0) {
          await transaction.run(MEMBER_CONTEXT_CYPHER.rejectAttempt, { attemptId: attempt.attemptId, validationErrors: errors, validatedAt });
          return {
            status: "failed",
            failure: { code: "validation_failed", memberId: attempt.memberId, contextRevisionId: attempt.contextRevisionId, errors },
          };
        }
        const sealId = sealIdFor(attempt.memberId, attempt.contextRevisionId, canonicalDigest);
        await transaction.run(MEMBER_CONTEXT_CYPHER.sealRevision, {
          attemptId: attempt.attemptId,
          memberId: attempt.memberId,
          contextRevisionId: attempt.contextRevisionId,
          sealId,
          canonicalDigest,
          nodeCount: snapshot.nodes.length,
          relationshipCount: snapshot.relationships.length,
          sealedAt: validatedAt,
        });
        return {
          status: "ok",
          data: {
            publicationAttemptId: attempt.attemptId,
            memberId: attempt.memberId,
            contextRevisionId: attempt.contextRevisionId,
            sealId,
            canonicalDigest,
            nodeCount: snapshot.nodes.length,
            relationshipCount: snapshot.relationships.length,
          },
        };
      });
    } catch {
      return unavailable();
    }
  }

  async activate(request: ActivateMemberContextRevisionRequest): Promise<MemberContextPublicationResult<ActivatedMemberContextRevision>> {
    if (!request.memberId.trim() || !request.contextRevisionId.trim() || !request.actorId.trim()) return unavailable();
    const activatedAt = this.now();
    const activationEventId = `${this.createId("activation-event")}:${sha256(canonicalJson({
      actorId: request.actorId,
      activatedAt,
      contextRevisionId: request.contextRevisionId,
      expectedPriorRevisionId: request.expectedPriorRevisionId,
      memberId: request.memberId,
    }))}`;
    try {
      return await this.client.executeWrite(async (transaction): Promise<MemberContextPublicationResult<ActivatedMemberContextRevision>> => {
        const locked = await transaction.run(MEMBER_CONTEXT_CYPHER.activateRevision, {
          memberId: request.memberId,
          contextRevisionId: request.contextRevisionId,
        });
        const record = locked.records[0];
        const actualRevisionId = nullableText(record?.get("actualRevisionId"));
        if (actualRevisionId === request.contextRevisionId) {
          return {
            status: "ok",
            data: {
              memberId: request.memberId,
              contextRevisionId: request.contextRevisionId,
              priorRevisionId: actualRevisionId,
              activationEventId,
              state: "already-active",
            },
          };
        }
        if (actualRevisionId !== request.expectedPriorRevisionId) {
          return {
            status: "failed",
            failure: { code: "stale_revision", memberId: request.memberId, expectedPriorRevisionId: request.expectedPriorRevisionId, actualRevisionId },
          };
        }
        if (!text(record?.get("sealId"))) {
          return { status: "failed", failure: { code: "not_sealed", memberId: request.memberId, contextRevisionId: request.contextRevisionId } };
        }
        let snapshot;
        try {
          snapshot = await readCanonicalMemberContextSnapshot(transaction, request.memberId, request.contextRevisionId);
        } catch {
          snapshot = undefined;
        }
        const digest = snapshot ? canonicalMemberContextDigest(snapshot) : undefined;
        if (!snapshot || validateMemberContextGraph(snapshot).valid === false
          || digest !== text(record?.get("canonicalDigest"))
          || snapshot.nodes.length !== Number(record?.get("nodeCount"))
          || snapshot.relationships.length !== Number(record?.get("relationshipCount"))) {
          return { status: "failed", failure: { code: "not_sealed", memberId: request.memberId, contextRevisionId: request.contextRevisionId } };
        }
        await transaction.run(MEMBER_CONTEXT_CYPHER.swapActiveRevision, {
          memberId: request.memberId,
          contextRevisionId: request.contextRevisionId,
          priorRevisionId: actualRevisionId,
          actorId: request.actorId,
          activatedAt,
          eventId: activationEventId,
        });
        return {
          status: "ok",
          data: {
            memberId: request.memberId,
            contextRevisionId: request.contextRevisionId,
            priorRevisionId: actualRevisionId,
            activationEventId,
            state: "activated",
          },
        };
      });
    } catch {
      return unavailable();
    }
  }

  async inspect(memberId: string, contextRevisionId?: string): Promise<MemberContextPublicationResult<MemberContextPublicationInspection>> {
    try {
      return await this.client.executeRead(async (transaction): Promise<MemberContextPublicationResult<MemberContextPublicationInspection>> => {
        if (!contextRevisionId) {
          const result = await transaction.run(MEMBER_CONTEXT_CYPHER.inspectCatalog, { memberId });
          const activeRevisionId = nullableText(result.records[0]?.get("activeRevisionId"));
          return {
            status: "ok",
            data: {
              memberId,
              activeRevisionId,
              ...(activeRevisionId ? { contextRevisionId: activeRevisionId } : {}),
              state: activeRevisionId ? "active" : "missing",
              validationErrors: [],
            },
          };
        }
        const result = await transaction.run(MEMBER_CONTEXT_CYPHER.inspect, { memberId, contextRevisionId });
        const record = result.records[0];
        const activeRevisionId = nullableText(record?.get("activeRevisionId"));
        const foundRevision = text(record?.get("contextRevisionId"));
        const attemptState = text(record?.get("attemptState"));
        const state: MemberContextPublicationInspection["state"] = activeRevisionId === contextRevisionId
          ? "active"
          : text(record?.get("sealId")) ? "sealed"
            : attemptState === "rejected" ? "rejected"
              : attemptState === "abandoned" ? "abandoned"
                : foundRevision ? "staged" : "missing";
        const validationErrors = Array.isArray(record?.get("validationErrors")) ? record!.get("validationErrors") as string[] : [];
        const sealId = text(record?.get("sealId"));
        const canonicalDigest = text(record?.get("canonicalDigest"));
        const nodeCount = Number(record?.get("nodeCount"));
        const relationshipCount = Number(record?.get("relationshipCount"));
        return {
          status: "ok",
          data: {
            memberId,
            activeRevisionId,
            contextRevisionId,
            ...(text(record?.get("attemptId")) ? { publicationAttemptId: text(record?.get("attemptId")) } : {}),
            ...(sealId ? { sealId } : {}),
            ...(canonicalDigest ? { canonicalDigest } : {}),
            ...(Number.isFinite(nodeCount) ? { nodeCount } : {}),
            ...(Number.isFinite(relationshipCount) ? { relationshipCount } : {}),
            state,
            validationErrors,
          },
        };
      });
    } catch {
      return unavailable();
    }
  }
}

export function createNeo4jMemberContextPublisher(
  client: Neo4jClient,
  options: Neo4jMemberContextPublisherOptions = {},
): MemberContextPublisher {
  return new Neo4jMemberContextPublisher(client, options);
}
