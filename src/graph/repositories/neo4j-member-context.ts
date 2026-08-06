import neo4j from "neo4j-driver";
import { inspectAuthorizedMemberContextScope } from "../../application/use-cases/retrieve-member-context";
import type {
  AuthorizedMemberContextScope,
  CitationLookupQuery,
  CitationProjection,
  CoachBriefProjection,
  CoachBriefQuery,
  ConversationProjection,
  ConversationQuery,
  EvidenceQuery,
  LongitudinalPointProjection,
  LongitudinalSeriesQuery,
  MemberContextQueryResult,
  MemberContextReadHandle,
  MemberContextReadOpenResult,
  MemberContextReadProvider,
  MemberEvidenceProjection,
  MemberSummaryProjection,
  RelatedEvidenceQuery,
  SummaryQuery,
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

class Neo4jMemberContextReadHandle implements MemberContextReadHandle {
  readonly authority = "canonical" as const;
  readonly memberId: string;
  readonly coachId: string;
  readonly contextRevisionId: string;

  constructor(
    private readonly client: Neo4jClient,
    private readonly seal: SealMetadata,
    private readonly canonicalHandle: MemberContextReadHandle,
  ) {
    this.memberId = canonicalHandle.memberId;
    this.coachId = canonicalHandle.coachId;
    this.contextRevisionId = canonicalHandle.contextRevisionId;
  }

  private unavailable<T>(): MemberContextQueryResult<T> {
    return {
      status: "unavailable",
      memberId: this.memberId,
      contextRevisionId: this.contextRevisionId,
      authority: this.authority,
      evidenceIds: [],
      message: genericMessage,
    };
  }

  private async withIntegrity<T>(
    timeoutMs: number,
    operation: (handle: MemberContextReadHandle) => Promise<MemberContextQueryResult<T>>,
  ): Promise<MemberContextQueryResult<T>> {
    try {
      const snapshot = await this.client.executeRead(
        (transaction) => readCanonicalMemberContextSnapshot(transaction, this.memberId, this.contextRevisionId),
        timeoutMs > 0 ? { timeoutMs } : undefined,
      );
      if (!snapshot
        || snapshot.nodes.length !== this.seal.nodeCount
        || snapshot.relationships.length !== this.seal.relationshipCount
        || canonicalMemberContextDigest(snapshot) !== this.seal.canonicalDigest
        || !validateMemberContextGraph(snapshot).valid) {
        return this.unavailable();
      }
      return operation(this.canonicalHandle);
    } catch {
      return this.unavailable();
    }
  }

  getSummary(query: SummaryQuery): Promise<MemberContextQueryResult<MemberSummaryProjection>> {
    return this.withIntegrity(query.timeoutMs, (handle) => handle.getSummary(query));
  }

  getEvidence(query: EvidenceQuery): Promise<MemberContextQueryResult<readonly MemberEvidenceProjection[]>> {
    return this.withIntegrity(query.timeoutMs, (handle) => handle.getEvidence(query));
  }

  getLongitudinalSeries(query: LongitudinalSeriesQuery): Promise<MemberContextQueryResult<readonly LongitudinalPointProjection[]>> {
    return this.withIntegrity(query.timeoutMs, (handle) => handle.getLongitudinalSeries(query));
  }

  getConversation(query: ConversationQuery): Promise<MemberContextQueryResult<ConversationProjection>> {
    return this.withIntegrity(query.timeoutMs, (handle) => handle.getConversation(query));
  }

  getCoachBrief(query: CoachBriefQuery): Promise<MemberContextQueryResult<CoachBriefProjection>> {
    return this.withIntegrity(query.timeoutMs, (handle) => handle.getCoachBrief(query));
  }

  getRelatedEvidence(query: RelatedEvidenceQuery): Promise<MemberContextQueryResult<readonly MemberEvidenceProjection[]>> {
    return this.withIntegrity(query.timeoutMs, (handle) => handle.getRelatedEvidence(query));
  }

  getCitations(query: CitationLookupQuery): Promise<MemberContextQueryResult<readonly CitationProjection[]>> {
    return this.withIntegrity(query.timeoutMs, (handle) => handle.getCitations(query));
  }
}

class Neo4jMemberContextReadProvider implements MemberContextReadProvider {
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
        ? this.openClaimsRevision(claims, contextRevisionId)
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
    return this.openClaimsRevision(claims, contextRevisionId);
  }

  private async openClaimsRevision(
    claims: Readonly<{ coachId: string; memberId: string }>,
    contextRevisionId: string,
  ): Promise<MemberContextReadOpenResult> {
    try {
      const opened = await this.client.executeRead(async (transaction) => {
        const sealResult = await transaction.run(MEMBER_CONTEXT_CYPHER.readSealedRevision, {
          memberId: claims.memberId,
          contextRevisionId,
        });
        const record = sealResult.records[0];
        const canonicalDigest = text(record?.get("canonicalDigest"));
        if (!record || !canonicalDigest) return undefined;
        const seal: SealMetadata = {
          canonicalDigest,
          nodeCount: Number(record.get("nodeCount")),
          relationshipCount: Number(record.get("relationshipCount")),
        };
        const snapshot = await readCanonicalMemberContextSnapshot(transaction, claims.memberId, contextRevisionId);
        return snapshot ? { seal, snapshot } : undefined;
      });
      if (!opened
        || opened.snapshot.memberId !== claims.memberId
        || opened.snapshot.nodes.length !== opened.seal.nodeCount
        || opened.snapshot.relationships.length !== opened.seal.relationshipCount
        || canonicalMemberContextDigest(opened.snapshot) !== opened.seal.canonicalDigest
        || !validateMemberContextGraph(opened.snapshot).valid) {
        return { status: "empty", memberId: claims.memberId, message: genericMessage };
      }
      const canonicalHandle = createMemberContextReadHandle(opened.snapshot, claims.coachId, "canonical");
      return {
        status: "ready",
        handle: new Neo4jMemberContextReadHandle(this.client, opened.seal, canonicalHandle),
      };
    } catch {
      return { status: "unavailable", message: genericMessage };
    }
  }
}

export function createNeo4jMemberContextReadProvider(client: Neo4jClient): MemberContextReadProvider {
  return new Neo4jMemberContextReadProvider(client);
}
