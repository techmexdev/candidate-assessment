import { randomBytes } from "node:crypto";
import neo4j from "neo4j-driver";
import { inspectAuthorizedMemberContextScope } from "../../application/use-cases/retrieve-member-context";
import type {
  AuthorizedMemberContextScope,
  BoundedMemberContextQuery,
  MemberContextQueryResult,
  MemberContextReadHandle,
  MemberContextReadOpenResult,
} from "../../domain/contracts/member-context-queries";
import {
  FullGraphProjectionError,
  isValidFullGraphPageRequest,
  projectMemberContextGraphPage,
  projectMemberContextGraphSnapshot,
  type FullGraphPageRequest,
  type FullGraphReadResult,
  type MemberContextFullReadProvider,
} from "../../domain/contracts/full-graph-view";
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
    offset: neo4j.int(0),
    limit: neo4j.int(MEMBER_CONTEXT_NEO4J_LIMITS.maxNodesPerRevision + 1),
  });
  const relationships = await transaction.run(MEMBER_CONTEXT_CYPHER.readRelationships, {
    memberId,
    contextRevisionId,
    offset: neo4j.int(0),
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

export async function readCanonicalMemberContextPage(
  transaction: Neo4jTransaction,
  memberId: string,
  contextRevisionId: string,
  page: FullGraphPageRequest,
): Promise<{
  readonly snapshot: MemberContextGraphSnapshot;
  readonly page: FullGraphPageRequest & { readonly hasMoreNodes: boolean; readonly hasMoreRelationships: boolean };
  readonly seal: { readonly canonicalDigest: string; readonly nodeCount: number; readonly relationshipCount: number };
} | undefined> {
  const result = await transaction.run(MEMBER_CONTEXT_CYPHER.readPage, {
    memberId,
    contextRevisionId,
    nodeOffset: neo4j.int(page.nodeOffset),
    relationshipOffset: neo4j.int(page.relationshipOffset),
    limit: neo4j.int(page.pageSize + 1),
  });
  const record = result.records[0];
  const sourceArtifactDigest = text(record?.get("sourceArtifactDigest"));
  const resultRevisionId = text(record?.get("contextRevisionId"));
  const canonicalDigest = text(record?.get("canonicalDigest"));
  const nodeCount = Number(record?.get("nodeCount"));
  const relationshipCount = Number(record?.get("relationshipCount"));
  if (!record || !sourceArtifactDigest || resultRevisionId !== contextRevisionId || !canonicalDigest
    || !Number.isSafeInteger(nodeCount) || nodeCount < 0
    || !Number.isSafeInteger(relationshipCount) || relationshipCount < 0) return undefined;
  const parsePayloads = <T>(value: unknown): T[] => {
    if (!Array.isArray(value)) throw new Error("Stored member context page has no canonical payload list");
    return value.map((payload) => {
      const textPayload = text(payload);
      if (!textPayload) throw new Error("Stored member context record has no canonical payload");
      return JSON.parse(textPayload) as T;
    });
  };
  const nodePayloads = parsePayloads<MemberContextGraphNode>(record.get("nodePayloads"));
  const relationshipPayloads = parsePayloads<MemberContextGraphRelationship>(record.get("relationshipPayloads"));
  return {
    snapshot: deepFreeze({
      memberId,
      contextRevisionId,
      sourceArtifactDigest,
      nodes: nodePayloads.slice(0, page.pageSize),
      relationships: relationshipPayloads.slice(0, page.pageSize),
    }),
    page: {
      ...page,
      hasMoreNodes: nodePayloads.length > page.pageSize,
      hasMoreRelationships: relationshipPayloads.length > page.pageSize,
    },
    seal: { canonicalDigest, nodeCount, relationshipCount },
  };
}

type SealMetadata = {
  readonly sealId: string;
  readonly canonicalDigest: string;
  readonly nodeCount: number;
  readonly relationshipCount: number;
};

function sealMetadata(record: { get(key: string): unknown } | undefined): SealMetadata | undefined {
  const sealId = text(record?.get("sealId"));
  const canonicalDigest = text(record?.get("canonicalDigest"));
  return record && sealId && canonicalDigest
    ? {
        sealId,
        canonicalDigest,
        nodeCount: Number(record.get("nodeCount")),
        relationshipCount: Number(record.get("relationshipCount")),
      }
    : undefined;
}

function sameSeal(left: SealMetadata | undefined, right: SealMetadata): boolean {
  return left?.sealId === right.sealId
    && left.canonicalDigest === right.canonicalDigest
    && left.nodeCount === right.nodeCount
    && left.relationshipCount === right.relationshipCount;
}

type OpenedRevision =
  | { readonly activeRevisionId: string | null }
  | {
      readonly activeRevisionId: string | null;
      readonly seal: SealMetadata;
      readonly snapshot: MemberContextGraphSnapshot;
    };

class Neo4jMemberContextReadProvider implements MemberContextFullReadProvider {
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

  async readFullActive(scope: AuthorizedMemberContextScope): Promise<FullGraphReadResult> {
    const claims = inspectAuthorizedMemberContextScope(scope);
    if (!claims) return { status: "denied", domain: "member-context", message: genericMessage };
    try {
      return await this.client.executeRead(async (transaction) => {
        const contextRevisionId = text((await transaction.run(MEMBER_CONTEXT_CYPHER.readActiveRevision, { memberId: claims.memberId })).records[0]?.get("activeRevisionId"));
        return contextRevisionId
          ? this.readFullRevisionInTransaction(transaction, claims.memberId, contextRevisionId, contextRevisionId)
          : { status: "empty", domain: "member-context", message: genericMessage };
      });
    } catch (error) {
      return error instanceof FullGraphProjectionError
        ? { status: "invalid", domain: "member-context", message: "Member context failed integrity validation." }
        : { status: "unavailable", domain: "member-context", message: genericMessage };
    }
  }

  async readFullRevision(
    scope: AuthorizedMemberContextScope,
    contextRevisionId: string,
  ): Promise<FullGraphReadResult> {
    const claims = inspectAuthorizedMemberContextScope(scope);
    if (!claims) return { status: "denied", domain: "member-context", message: genericMessage };
    try {
      return await this.client.executeRead(async (transaction) => {
        const activeRevisionId = text((await transaction.run(MEMBER_CONTEXT_CYPHER.readActiveRevision, {
          memberId: claims.memberId,
        })).records[0]?.get("activeRevisionId")) ?? null;
        return this.readFullRevisionInTransaction(transaction, claims.memberId, contextRevisionId, activeRevisionId);
      });
    } catch (error) {
      const message = error instanceof FullGraphProjectionError ? "Member context failed integrity validation." : genericMessage;
      return { status: "invalid", domain: "member-context", message };
    }
  }

  async readFullPage(
    scope: AuthorizedMemberContextScope,
    page: FullGraphPageRequest,
    contextRevisionId?: string,
  ): Promise<FullGraphReadResult> {
    const claims = inspectAuthorizedMemberContextScope(scope);
    if (!claims) return { status: "denied", domain: "member-context", message: genericMessage };
    if (!isValidFullGraphPageRequest(page)) {
      return { status: "invalid", domain: "member-context", message: "Invalid full graph page request." };
    }
    try {
      return await this.client.executeRead(async (transaction) => {
        const activeRevisionId = text((await transaction.run(MEMBER_CONTEXT_CYPHER.readActiveRevision, {
          memberId: claims.memberId,
        })).records[0]?.get("activeRevisionId")) ?? null;
        const requestedRevisionId = contextRevisionId ?? activeRevisionId;
        return requestedRevisionId
          ? this.readFullPageInTransaction(transaction, claims.memberId, requestedRevisionId, activeRevisionId, page)
          : { status: "empty", domain: "member-context", message: genericMessage };
      });
    } catch (error) {
      return error instanceof FullGraphProjectionError
        ? { status: "invalid", domain: "member-context", message: "Member context failed integrity validation." }
        : { status: "unavailable", domain: "member-context", message: genericMessage };
    }
  }

  private async readFullRevisionInTransaction(
    transaction: Neo4jTransaction,
    memberId: string,
    contextRevisionId: string,
    activeRevisionId: string | null,
  ): Promise<FullGraphReadResult> {
    if (activeRevisionId !== contextRevisionId) {
      return {
        status: "stale",
        domain: "member-context",
        requestedRevisionId: contextRevisionId,
        activeRevisionId,
      };
    }
    const sealResult = await transaction.run(MEMBER_CONTEXT_CYPHER.readSealedRevision, {
      memberId,
      contextRevisionId,
    });
    const seal = sealMetadata(sealResult.records[0]);
    if (!seal) return { status: "empty", domain: "member-context", message: genericMessage };
    const snapshot = await readCanonicalMemberContextSnapshot(transaction, memberId, contextRevisionId);
    if (!snapshot) return { status: "empty", domain: "member-context", message: genericMessage };
    if (snapshot.memberId !== memberId
      || snapshot.nodes.length !== seal.nodeCount
      || snapshot.relationships.length !== seal.relationshipCount
      || canonicalMemberContextDigest(snapshot) !== seal.canonicalDigest
      || !validateMemberContextGraph(snapshot).valid) {
      return { status: "unavailable", domain: "member-context", message: genericMessage };
    }
    return { status: "ready", data: projectMemberContextGraphSnapshot(snapshot, "canonical") };
  }

  private async readFullPageInTransaction(
    transaction: Neo4jTransaction,
    memberId: string,
    contextRevisionId: string,
    activeRevisionId: string | null,
    page: FullGraphPageRequest,
  ): Promise<FullGraphReadResult> {
    if (activeRevisionId !== contextRevisionId) {
      return {
        status: "stale",
        domain: "member-context",
        requestedRevisionId: contextRevisionId,
        activeRevisionId,
      };
    }
    const sealResult = await transaction.run(MEMBER_CONTEXT_CYPHER.readSealedRevision, {
      memberId,
      contextRevisionId,
    });
    const seal = sealMetadata(sealResult.records[0]);
    if (!seal) return { status: "empty", domain: "member-context", message: genericMessage };
    const snapshot = await readCanonicalMemberContextSnapshot(transaction, memberId, contextRevisionId);
    if (!snapshot
      || snapshot.memberId !== memberId
      || snapshot.nodes.length !== seal.nodeCount
      || snapshot.relationships.length !== seal.relationshipCount
      || canonicalMemberContextDigest(snapshot) !== seal.canonicalDigest
      || !validateMemberContextGraph(snapshot).valid) {
      return { status: "unavailable", domain: "member-context", message: genericMessage };
    }
    const pageSnapshot = await readCanonicalMemberContextPage(transaction, memberId, contextRevisionId, page);
    if (!pageSnapshot) return { status: "empty", domain: "member-context", message: genericMessage };
    if (pageSnapshot.seal.canonicalDigest !== seal.canonicalDigest
      || pageSnapshot.seal.nodeCount !== seal.nodeCount
      || pageSnapshot.seal.relationshipCount !== seal.relationshipCount) {
      return { status: "unavailable", domain: "member-context", message: genericMessage };
    }
    return {
      status: "ready",
      data: projectMemberContextGraphPage(
        pageSnapshot.snapshot,
        "canonical",
        { nodes: pageSnapshot.seal.nodeCount, relationships: pageSnapshot.seal.relationshipCount },
        pageSnapshot.page,
      ),
    };
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
        const seal = sealMetadata(sealResult.records[0]);
        if (!seal) return { activeRevisionId };
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
    // Sealed revisions are immutable by repository contract. Build the indexed
    // projection handle once from the fully validated snapshot, then pin each
    // read to the exact seal identity and metadata instead of rebuilding and
    // re-digesting the entire graph.
    const delegate = createMemberContextReadHandle(
      openedSnapshot,
      coachId,
      "canonical",
      this.cursorSecret,
    );
    const invoke = async <T>(
      query: BoundedMemberContextQuery,
      operation: (handle: MemberContextReadHandle) => Promise<MemberContextQueryResult<T>>,
    ): Promise<MemberContextQueryResult<T>> => {
      try {
        query.signal?.throwIfAborted();
        const preflight = await operation(delegate);
        query.signal?.throwIfAborted();
        if (preflight.status === "invalid") return preflight;
        const currentSeal = await this.client.executeRead(
          async (transaction) => {
            const result = await transaction.run(MEMBER_CONTEXT_CYPHER.readPinnedRevisionSeal, {
              sealId: seal.sealId,
              memberId: openedSnapshot.memberId,
              contextRevisionId: openedSnapshot.contextRevisionId,
            });
            return sealMetadata(result.records[0]);
          },
          { timeoutMs: query.timeoutMs, ...(query.signal ? { signal: query.signal } : {}) },
        );
        if (!sameSeal(currentSeal, seal)) return unavailable();
        return preflight;
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

export function createNeo4jMemberContextReadProvider(client: Neo4jClient): MemberContextFullReadProvider {
  return new Neo4jMemberContextReadProvider(client);
}
