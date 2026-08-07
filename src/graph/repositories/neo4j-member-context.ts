import { randomBytes } from "node:crypto";
import neo4j from "neo4j-driver";
import { inspectAuthorizedMemberContextScope } from "../../application/use-cases/retrieve-member-context";
import type {
  AuthorizedMemberContextScope,
  BoundedMemberContextQuery,
  MemberContextQueryResult,
  MemberContextReadHandle,
  MemberContextReadOpenResult,
  MemberContextReadProvider,
} from "../../domain/contracts/member-context-queries";
import type {
  MemberContextGraphNode,
  MemberContextGraphRelationship,
  MemberContextGraphSnapshot,
} from "../../domain/contracts/member-context";
import { MEMBER_CONTEXT_CYPHER } from "../cypher/member-context";
import { MEMBER_CONTEXT_NEO4J_LIMITS } from "../neo4j/member-context-schema";
import type { Neo4jClient, Neo4jTransaction } from "../neo4j/client";
import { canonicalMemberContextDigest, deepFreeze } from "../revisions/member-context";
import { validateMemberContextGraph } from "../validation/member-context";
import { createMemberContextReadHandle } from "./member-context";

const text = (value: unknown) => typeof value === "string" ? value : undefined;
const genericMessage = "Member context is unavailable.";

export async function readCanonicalMemberContextSnapshot(
  transaction: Neo4jTransaction,
  memberId: string,
  contextRevisionId: string,
): Promise<MemberContextGraphSnapshot | undefined> {
  const revision = await transaction.run(MEMBER_CONTEXT_CYPHER.findRevision, { memberId, contextRevisionId });
  const sourceArtifactDigest = text(revision.records[0]?.get("sourceArtifactDigest"));
  if (revision.records.length === 0 || !sourceArtifactDigest) return undefined;
  const nodes = await transaction.run(MEMBER_CONTEXT_CYPHER.readNodes, {
    memberId,
    contextRevisionId,
    limit: neo4j.int(MEMBER_CONTEXT_NEO4J_LIMITS.maxNodesPerRevision + 1),
  });
  const relationships = await transaction.run(MEMBER_CONTEXT_CYPHER.readRelationships, {
    memberId,
    contextRevisionId,
    limit: neo4j.int(MEMBER_CONTEXT_NEO4J_LIMITS.maxRelationshipsPerRevision + 1),
  });
  if (nodes.records.length > MEMBER_CONTEXT_NEO4J_LIMITS.maxNodesPerRevision
    || relationships.records.length > MEMBER_CONTEXT_NEO4J_LIMITS.maxRelationshipsPerRevision) {
    throw new Error("Stored member context exceeds bounded revision limits");
  }
  const parse = <T>(record: { get(key: string): unknown }): T => {
    const payload = text(record.get("payload"));
    if (!payload) throw new Error("Stored member context record has no canonical payload");
    return JSON.parse(payload) as T;
  };
  return deepFreeze({
    memberId,
    contextRevisionId,
    sourceArtifactDigest,
    nodes: nodes.records.map((record) => parse<MemberContextGraphNode>(record)),
    relationships: relationships.records.map((record) => parse<MemberContextGraphRelationship>(record)),
  });
}

type SealMetadata = {
  readonly canonicalDigest: string;
  readonly nodeCount: number;
  readonly relationshipCount: number;
};

type OpenedRevision =
  | { readonly activeRevisionId: string | null }
  | {
      readonly activeRevisionId: string | null;
      readonly seal: SealMetadata;
      readonly snapshot: MemberContextGraphSnapshot;
    };

class Neo4jMemberContextReadProvider implements MemberContextReadProvider {
  private readonly cursorSecret = randomBytes(32);

  constructor(private readonly client: Neo4jClient) {}

  async openActive(scope: AuthorizedMemberContextScope): Promise<MemberContextReadOpenResult> {
    const claims = inspectAuthorizedMemberContextScope(scope);
    if (!claims) return { status: "denied", message: genericMessage };
    try {
      const contextRevisionId = await this.client.executeRead(async (transaction) => {
        const result = await transaction.run(MEMBER_CONTEXT_CYPHER.readActiveRevision, { memberId: claims.memberId });
        return text(result.records[0]?.get("activeRevisionId"));
      });
      return contextRevisionId
        ? this.openClaimsRevision(claims, contextRevisionId, false)
        : { status: "empty", memberId: claims.memberId, message: genericMessage };
    } catch {
      return { status: "unavailable", message: genericMessage };
    }
  }

  async openRevision(
    scope: AuthorizedMemberContextScope,
    contextRevisionId: string,
  ): Promise<MemberContextReadOpenResult> {
    const claims = inspectAuthorizedMemberContextScope(scope);
    if (!claims) return { status: "denied", message: genericMessage };
    return this.openClaimsRevision(claims, contextRevisionId, true);
  }

  private async openClaimsRevision(
    claims: Readonly<{ coachId: string; memberId: string }>,
    contextRevisionId: string,
    explicitRevision: boolean,
  ): Promise<MemberContextReadOpenResult> {
    try {
      const opened = await this.client.executeRead<OpenedRevision>(async (transaction) => {
        const activeRevisionId = explicitRevision
          ? text((await transaction.run(MEMBER_CONTEXT_CYPHER.readActiveRevision, {
            memberId: claims.memberId,
          })).records[0]?.get("activeRevisionId")) ?? null
          : null;
        const sealResult = await transaction.run(MEMBER_CONTEXT_CYPHER.readSealedRevision, {
          memberId: claims.memberId,
          contextRevisionId,
        });
        const record = sealResult.records[0];
        const canonicalDigest = text(record?.get("canonicalDigest"));
        if (!record || !canonicalDigest) return { activeRevisionId };
        const seal: SealMetadata = {
          canonicalDigest,
          nodeCount: Number(record.get("nodeCount")),
          relationshipCount: Number(record.get("relationshipCount")),
        };
        const snapshot = await readCanonicalMemberContextSnapshot(transaction, claims.memberId, contextRevisionId);
        return snapshot ? { activeRevisionId, seal, snapshot } : { activeRevisionId };
      });
      if (!("snapshot" in opened)) {
        return explicitRevision
          ? { status: "stale", requestedRevisionId: contextRevisionId, activeRevisionId: opened.activeRevisionId }
          : { status: "empty", memberId: claims.memberId, message: genericMessage };
      }
      if (opened.snapshot.memberId !== claims.memberId
        || opened.snapshot.nodes.length !== opened.seal.nodeCount
        || opened.snapshot.relationships.length !== opened.seal.relationshipCount
        || canonicalMemberContextDigest(opened.snapshot) !== opened.seal.canonicalDigest
        || !validateMemberContextGraph(opened.snapshot).valid) {
        return { status: "unavailable", message: genericMessage };
      }
      return {
        status: "ready",
        handle: this.createTimedReadHandle(opened.snapshot, opened.seal, claims.coachId),
      };
    } catch {
      return { status: "unavailable", message: genericMessage };
    }
  }

  private createTimedReadHandle(
    openedSnapshot: MemberContextGraphSnapshot,
    seal: SealMetadata,
    coachId: string,
  ): MemberContextReadHandle {
    const base = {
      memberId: openedSnapshot.memberId,
      coachId,
      contextRevisionId: openedSnapshot.contextRevisionId,
      authority: "canonical" as const,
    };
    const unavailable = <T>(): MemberContextQueryResult<T> => ({
      status: "unavailable",
      ...base,
      evidenceIds: [],
      message: genericMessage,
    });
    const invoke = async <T>(
      query: BoundedMemberContextQuery,
      operation: (handle: MemberContextReadHandle) => Promise<MemberContextQueryResult<T>>,
    ): Promise<MemberContextQueryResult<T>> => {
      try {
        const preflight = await operation(createMemberContextReadHandle(
          openedSnapshot,
          coachId,
          "canonical",
          this.cursorSecret,
        ));
        if (preflight.status === "invalid") return preflight;
        const snapshot = await this.client.executeRead(
          (transaction) => readCanonicalMemberContextSnapshot(
            transaction,
            openedSnapshot.memberId,
            openedSnapshot.contextRevisionId,
          ),
          { timeoutMs: query.timeoutMs },
        );
        if (!snapshot
          || snapshot.nodes.length !== seal.nodeCount
          || snapshot.relationships.length !== seal.relationshipCount
          || canonicalMemberContextDigest(snapshot) !== seal.canonicalDigest
          || !validateMemberContextGraph(snapshot).valid) {
          return unavailable();
        }
        return operation(createMemberContextReadHandle(snapshot, coachId, "canonical", this.cursorSecret));
      } catch {
        return unavailable();
      }
    };
    return Object.freeze({
      ...base,
      getSummary: (query) => invoke(query, (handle) => handle.getSummary(query)),
      getEvidence: (query) => invoke(query, (handle) => handle.getEvidence(query)),
      getLongitudinalSeries: (query) => invoke(query, (handle) => handle.getLongitudinalSeries(query)),
      getRelativeOrderSequence: (query) => invoke(query, (handle) => handle.getRelativeOrderSequence!(query)),
      getConversation: (query) => invoke(query, (handle) => handle.getConversation(query)),
      getCoachBrief: (query) => invoke(query, (handle) => handle.getCoachBrief(query)),
      getWorkoutConstraints: (query) => invoke(query, (handle) => handle.getWorkoutConstraints(query)),
      getRelatedEvidence: (query) => invoke(query, (handle) => handle.getRelatedEvidence(query)),
      getCitations: (query) => invoke(query, (handle) => handle.getCitations(query)),
    });
  }
}

export function createNeo4jMemberContextReadProvider(client: Neo4jClient): MemberContextReadProvider {
  return new Neo4jMemberContextReadProvider(client);
}
