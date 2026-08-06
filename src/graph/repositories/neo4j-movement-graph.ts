import type {
  AssertionLookupQuery,
  AnatomyPathsQuery,
  ClinicalRuleFactsQuery,
  GraphQueryResult,
  MovementGraphReadHandle,
  MovementGraphReadOpenResult,
  MovementGraphReadProvider,
  ResolveConceptCandidatesQuery,
  SubstitutionCandidatesQuery,
} from "../../domain/contracts/movement-clinical-queries";
import type { MovementGraphAssertion, MovementGraphSnapshot } from "../../domain/contracts/movement-graph";
import neo4j from "neo4j-driver";
import { MOVEMENT_CYPHER } from "../cypher/movement";
import type { Neo4jClient, Neo4jTransaction } from "../neo4j/client";
import { canonicalJson, deepFreeze, sha256 } from "../revisions/movement-graph";
import { MOVEMENT_GRAPH_LIMITS } from "../schema/movement-schema";
import { validateMovementGraph } from "../validation/movement-graph";
import { InMemoryMovementGraphReadProvider } from "./movement-graph";

const textValue = (value: unknown) => typeof value === "string" ? value : undefined;

export async function readCanonicalMovementSnapshot(transaction: Neo4jTransaction, graphRevisionId: string): Promise<MovementGraphSnapshot | undefined> {
  const revision = await transaction.run(MOVEMENT_CYPHER.findRevision, { revisionId: graphRevisionId });
  if (revision.records.length === 0) return undefined;
  // Managed transactions permit one in-flight query at a time. Keep the
  // canonical read-back serialized inside the pinned transaction.
  const nodes = await transaction.run(MOVEMENT_CYPHER.readNodes, { revisionId: graphRevisionId, limit: neo4j.int(MOVEMENT_GRAPH_LIMITS.maxNodes + 1) });
  const edges = await transaction.run(MOVEMENT_CYPHER.readEdges, { revisionId: graphRevisionId, limit: neo4j.int(MOVEMENT_GRAPH_LIMITS.maxEdges + 1) });
  if (nodes.records.length > MOVEMENT_GRAPH_LIMITS.maxNodes || edges.records.length > MOVEMENT_GRAPH_LIMITS.maxEdges) throw new Error("Stored movement graph exceeds bounded snapshot limits");
  const parse = (record: { get(key: string): unknown }) => {
    const payload = textValue(record.get("payload"));
    if (!payload) throw new Error("Stored movement assertion has no canonical payload");
    return JSON.parse(payload) as MovementGraphAssertion;
  };
  return deepFreeze({
    graphRevisionId,
    nodes: nodes.records.map(parse) as MovementGraphSnapshot["nodes"],
    edges: edges.records.map(parse) as MovementGraphSnapshot["edges"],
  });
}

type SealMetadata = { readonly canonicalDigest: string; readonly nodeCount: number; readonly edgeCount: number };

class Neo4jMovementGraphReadHandle implements MovementGraphReadHandle {
  readonly authority = "canonical" as const;
  constructor(readonly graphRevisionId: string, private readonly client: Neo4jClient, private readonly seal: SealMetadata) {}

  private async withCanonicalHandle<T>(operation: (handle: MovementGraphReadHandle) => Promise<GraphQueryResult<T>>): Promise<GraphQueryResult<T>> {
    try {
      const snapshot = await this.client.executeRead((transaction) => readCanonicalMovementSnapshot(transaction, this.graphRevisionId));
      const digest = snapshot ? `sha256:${sha256(canonicalJson(snapshot))}` : undefined;
      if (!snapshot || snapshot.nodes.length !== this.seal.nodeCount || snapshot.edges.length !== this.seal.edgeCount
        || digest !== this.seal.canonicalDigest || validateMovementGraph(snapshot).status !== "valid") {
        return { status: "failed", graphRevisionId: this.graphRevisionId, authority: this.authority, failure: { code: "graph_unavailable", message: "Sealed movement graph failed canonical integrity verification" } };
      }
      const opened = await new InMemoryMovementGraphReadProvider([snapshot], { authority: "canonical", activeRevisionId: this.graphRevisionId }).openRevision(this.graphRevisionId);
      if (opened.status !== "ready") return { status: "failed", graphRevisionId: this.graphRevisionId, authority: this.authority, failure: { code: "graph_unavailable", message: "Canonical movement graph is unavailable" } };
      return operation(opened.handle);
    } catch {
      return { status: "failed", graphRevisionId: this.graphRevisionId, authority: this.authority, failure: { code: "graph_unavailable", message: "Canonical movement graph read failed" } };
    }
  }

  resolveConceptCandidates(query: ResolveConceptCandidatesQuery) { return this.withCanonicalHandle((handle) => handle.resolveConceptCandidates(query)); }
  getAnatomyPaths(query: AnatomyPathsQuery) { return this.withCanonicalHandle((handle) => handle.getAnatomyPaths(query)); }
  getClinicalRuleFacts(query: ClinicalRuleFactsQuery) { return this.withCanonicalHandle((handle) => handle.getClinicalRuleFacts(query)); }
  getSubstitutionCandidates(query: SubstitutionCandidatesQuery) { return this.withCanonicalHandle((handle) => handle.getSubstitutionCandidates(query)); }
  getAssertions(query: AssertionLookupQuery) { return this.withCanonicalHandle((handle) => handle.getAssertions(query)); }
}

class Neo4jMovementGraphReadProvider implements MovementGraphReadProvider {
  constructor(private readonly client: Neo4jClient) {}

  async openActive(): Promise<MovementGraphReadOpenResult> {
    try {
      const revisionId = await this.client.executeRead(async (transaction) => {
        const result = await transaction.run(MOVEMENT_CYPHER.readActiveRevision);
        return textValue(result.records[0]?.get("activeRevisionId"));
      });
      return revisionId ? this.openRevision(revisionId) : { status: "unavailable", failure: { code: "graph_unavailable", message: "No active movement graph revision" } };
    } catch {
      return { status: "unavailable", failure: { code: "graph_unavailable", message: "Movement graph catalog is unavailable" } };
    }
  }

  async openRevision(revisionId: string): Promise<MovementGraphReadOpenResult> {
    try {
      const seal = await this.client.executeRead(async (transaction): Promise<SealMetadata | undefined> => {
        const result = await transaction.run(MOVEMENT_CYPHER.readSealedRevision, { revisionId });
        const record = result.records[0];
        const canonicalDigest = textValue(record?.get("canonicalDigest"));
        if (!record || !canonicalDigest) return undefined;
        return { canonicalDigest, nodeCount: Number(record.get("nodeCount")), edgeCount: Number(record.get("edgeCount")) };
      });
      return seal
        ? { status: "ready", handle: new Neo4jMovementGraphReadHandle(revisionId, this.client, seal) }
        : { status: "unavailable", failure: { code: "revision_not_found", revisionId } };
    } catch {
      return { status: "unavailable", failure: { code: "graph_unavailable", message: "Movement graph revision lookup failed" } };
    }
  }
}

export function createNeo4jMovementGraphReadProvider(client: Neo4jClient): MovementGraphReadProvider {
  return new Neo4jMovementGraphReadProvider(client);
}
