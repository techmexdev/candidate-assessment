import type {
  AssertionLookupQuery,
  AnatomyPathsQuery,
  CatalogExerciseFactsQuery,
  CatalogFamilyFactsQuery,
  ClinicalRuleFactsQuery,
  ExerciseConstraintFactsQuery,
  GraphQueryResult,
  MovementGraphReadHandle,
  MovementGraphReadOpenResult,
  ResolveConceptCandidatesQuery,
  SubstitutionCandidatesQuery,
} from "../../domain/contracts/movement-clinical-queries";
import {
  FullGraphProjectionError,
  projectMovementGraphSnapshot,
  type FullGraphReadResult,
  type MovementGraphFullReadProvider,
} from "../../domain/contracts/full-graph-view";
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
  readonly graphRevisionId: string;

  constructor(
    private readonly delegate: MovementGraphReadHandle,
    private readonly client: Neo4jClient,
    private readonly seal: SealMetadata,
  ) {
    this.graphRevisionId = delegate.graphRevisionId;
  }

  private async withPinnedSeal<T>(operation: (handle: MovementGraphReadHandle) => Promise<GraphQueryResult<T>>): Promise<GraphQueryResult<T>> {
    try {
      const seal = await this.client.executeRead(async (transaction): Promise<SealMetadata | undefined> => {
        const result = await transaction.run(MOVEMENT_CYPHER.readSealedRevision, { revisionId: this.graphRevisionId });
        const record = result.records[0];
        const canonicalDigest = textValue(record?.get("canonicalDigest"));
        return record && canonicalDigest
          ? { canonicalDigest, nodeCount: Number(record.get("nodeCount")), edgeCount: Number(record.get("edgeCount")) }
          : undefined;
      });
      if (!seal || seal.canonicalDigest !== this.seal.canonicalDigest
        || seal.nodeCount !== this.seal.nodeCount || seal.edgeCount !== this.seal.edgeCount) {
        return {
          status: "failed",
          graphRevisionId: this.graphRevisionId,
          authority: this.authority,
          failure: { code: "graph_unavailable", message: "Movement graph revision seal changed after open" },
        };
      }
      return operation(this.delegate);
    } catch {
      return {
        status: "failed",
        graphRevisionId: this.graphRevisionId,
        authority: this.authority,
        failure: { code: "graph_unavailable", message: "Movement graph revision seal check failed" },
      };
    }
  }

  resolveConceptCandidates(query: ResolveConceptCandidatesQuery) { return this.withPinnedSeal((handle) => handle.resolveConceptCandidates(query)); }
  getAnatomyPaths(query: AnatomyPathsQuery) { return this.withPinnedSeal((handle) => handle.getAnatomyPaths(query)); }
  getClinicalRuleFacts(query: ClinicalRuleFactsQuery) { return this.withPinnedSeal((handle) => handle.getClinicalRuleFacts(query)); }
  getExerciseConstraintFacts(query: ExerciseConstraintFactsQuery) { return this.withPinnedSeal((handle) => handle.getExerciseConstraintFacts(query)); }
  getCatalogExerciseFacts(query: CatalogExerciseFactsQuery) { return this.withPinnedSeal((handle) => handle.getCatalogExerciseFacts(query)); }
  getCatalogFamilyFacts(query: CatalogFamilyFactsQuery) { return this.withPinnedSeal((handle) => handle.getCatalogFamilyFacts(query)); }
  getSubstitutionCandidates(query: SubstitutionCandidatesQuery) { return this.withPinnedSeal((handle) => handle.getSubstitutionCandidates(query)); }
  getAssertions(query: AssertionLookupQuery) { return this.withPinnedSeal((handle) => handle.getAssertions(query)); }
}

class Neo4jMovementGraphReadProvider implements MovementGraphFullReadProvider {
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
      const canonicalRevision = await this.client.executeRead(async (transaction): Promise<{
        readonly seal: SealMetadata;
        readonly snapshot: MovementGraphSnapshot | undefined;
      } | undefined> => {
        const result = await transaction.run(MOVEMENT_CYPHER.readSealedRevision, { revisionId });
        const record = result.records[0];
        const canonicalDigest = textValue(record?.get("canonicalDigest"));
        if (!record || !canonicalDigest) return undefined;
        const seal = { canonicalDigest, nodeCount: Number(record.get("nodeCount")), edgeCount: Number(record.get("edgeCount")) };
        const snapshot = await readCanonicalMovementSnapshot(transaction, revisionId);
        return { seal, snapshot };
      });
      if (!canonicalRevision) return { status: "unavailable", failure: { code: "revision_not_found", revisionId } };

      const { seal, snapshot } = canonicalRevision;
      const digest = snapshot ? `sha256:${sha256(canonicalJson(snapshot))}` : undefined;
      if (!snapshot || snapshot.nodes.length !== seal.nodeCount || snapshot.edges.length !== seal.edgeCount
        || digest !== seal.canonicalDigest || validateMovementGraph(snapshot).status !== "valid") {
        return { status: "unavailable", failure: { code: "graph_unavailable", message: "Sealed movement graph failed canonical integrity verification" } };
      }

      const indexed = await new InMemoryMovementGraphReadProvider([snapshot], {
        authority: "canonical",
        activeRevisionId: revisionId,
      }).openRevision(revisionId);
      return indexed.status === "ready"
        ? { status: "ready", handle: new Neo4jMovementGraphReadHandle(indexed.handle, this.client, seal) }
        : { status: "unavailable", failure: { code: "graph_unavailable", message: "Canonical movement graph is unavailable" } };
    } catch {
      return { status: "unavailable", failure: { code: "graph_unavailable", message: "Movement graph revision read failed" } };
    }
  }

  async readFullActive(): Promise<FullGraphReadResult> {
    try {
      const revisionId = await this.client.executeRead(async (transaction) => {
        const result = await transaction.run(MOVEMENT_CYPHER.readActiveRevision);
        return textValue(result.records[0]?.get("activeRevisionId"));
      });
      return revisionId
        ? this.readFullRevision(revisionId)
        : { status: "unavailable", domain: "movement-clinical", message: "No active movement graph revision." };
    } catch {
      return { status: "unavailable", domain: "movement-clinical", message: "Movement graph catalog is unavailable." };
    }
  }

  async readFullRevision(revisionId: string): Promise<FullGraphReadResult> {
    try {
      const canonicalRevision = await this.client.executeRead(async (transaction): Promise<{
        readonly seal: SealMetadata;
        readonly snapshot: MovementGraphSnapshot | undefined;
      } | undefined> => {
        const result = await transaction.run(MOVEMENT_CYPHER.readSealedRevision, { revisionId });
        const record = result.records[0];
        const canonicalDigest = textValue(record?.get("canonicalDigest"));
        if (!record || !canonicalDigest) return undefined;
        const seal = {
          canonicalDigest,
          nodeCount: Number(record.get("nodeCount")),
          edgeCount: Number(record.get("edgeCount")),
        };
        return { seal, snapshot: await readCanonicalMovementSnapshot(transaction, revisionId) };
      });
      if (!canonicalRevision?.snapshot) return { status: "unavailable", domain: "movement-clinical", message: "Movement graph revision is unavailable." };
      const { seal, snapshot } = canonicalRevision;
      const digest = `sha256:${sha256(canonicalJson(snapshot))}`;
      if (snapshot.nodes.length !== seal.nodeCount || snapshot.edges.length !== seal.edgeCount
        || digest !== seal.canonicalDigest || validateMovementGraph(snapshot).status !== "valid") {
        return { status: "unavailable", domain: "movement-clinical", message: "Movement graph revision failed canonical integrity validation." };
      }
      return { status: "ready", data: projectMovementGraphSnapshot(snapshot, "canonical") };
    } catch (error) {
      const message = error instanceof FullGraphProjectionError ? "Movement graph revision failed integrity validation." : "Movement graph revision is unavailable.";
      return { status: "invalid", domain: "movement-clinical", message };
    }
  }
}

export function createNeo4jMovementGraphReadProvider(client: Neo4jClient): MovementGraphFullReadProvider {
  return new Neo4jMovementGraphReadProvider(client);
}
