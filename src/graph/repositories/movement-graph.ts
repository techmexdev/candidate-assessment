import type {
  LegacyConceptCandidate,
  LegacyMovementEdgeKind,
  LegacyMovementGraphRepository,
  LegacyMovementGraphSnapshot,
  LegacyMovementNode,
} from "../../domain/contracts/movement-graph";
import { normalizeConceptText } from "../../domain/policies/text-normalization";

function tokenScore(query: string, candidate: string) {
  const queryTokens = new Set(normalizeConceptText(query).split(" ").filter(Boolean));
  const candidateTokens = new Set(normalizeConceptText(candidate).split(" ").filter(Boolean));
  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;
  const overlap = [...queryTokens].filter((token) => candidateTokens.has(token)).length;
  return overlap / Math.max(queryTokens.size, candidateTokens.size);
}

export class InMemoryMovementGraphRepository implements LegacyMovementGraphRepository {
  private readonly nodesById: Map<string, LegacyMovementNode>;
  private readonly edgesByFrom: Map<string, LegacyMovementGraphSnapshot["edges"]>;
  private readonly anatomyChildrenByParent: Map<string, string[]>;

  constructor(private readonly graph: LegacyMovementGraphSnapshot) {
    this.nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    this.edgesByFrom = new Map();
    this.anatomyChildrenByParent = new Map();
    for (const edge of graph.edges) {
      const existing = this.edgesByFrom.get(edge.from) ?? [];
      existing.push(edge);
      this.edgesByFrom.set(edge.from, existing);
      if (edge.kind === "part-of") {
        const children = this.anatomyChildrenByParent.get(edge.to) ?? [];
        children.push(edge.from);
        this.anatomyChildrenByParent.set(edge.to, children);
      }
    }
    for (const edges of this.edgesByFrom.values()) edges.sort((left, right) => left.id.localeCompare(right.id));
    for (const children of this.anatomyChildrenByParent.values()) children.sort();
  }

  snapshot() {
    return this.graph;
  }

  getNode(id: string) {
    return this.nodesById.get(id);
  }

  getRelated(id: string, kind: LegacyMovementEdgeKind) {
    return (this.edgesByFrom.get(id) ?? [])
      .filter((edge) => edge.kind === kind)
      .map((edge) => this.nodesById.get(edge.to))
      .filter((node): node is LegacyMovementNode => Boolean(node));
  }

  getAnatomyDescendants(id: string) {
    const descendants: LegacyMovementNode[] = [];
    const visited = new Set<string>([id]);
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const childId of this.anatomyChildrenByParent.get(current) ?? []) {
        if (visited.has(childId)) continue;
        visited.add(childId);
        const node = this.nodesById.get(childId);
        if (node) descendants.push(node);
        queue.push(childId);
      }
    }
    return descendants.sort((left, right) => left.id.localeCompare(right.id));
  }

  findConceptCandidates(query: string, kind?: LegacyMovementNode["kind"]) {
    const normalizedQuery = normalizeConceptText(query);
    return this.graph.nodes
      .filter((node) => !kind || node.kind === kind)
      .flatMap((node): LegacyConceptCandidate[] => {
        const aliases = [node.label, ...node.aliases];
        const exactAlias = aliases.find((alias) => normalizeConceptText(alias) === normalizedQuery);
        if (exactAlias) return [{ node, matchedAlias: exactAlias, exact: true, score: 1 }];
        const best = aliases
          .map((alias) => ({ alias, score: tokenScore(query, alias) }))
          .sort((left, right) => right.score - left.score || left.alias.localeCompare(right.alias))[0];
        return best && best.score > 0 ? [{ node, matchedAlias: best.alias, exact: false, score: best.score }] : [];
      })
      .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id));
  }

  findEquivalentExercises(exerciseId: string) {
    return this.getRelated(exerciseId, "equivalent-to").sort((left, right) => left.id.localeCompare(right.id));
  }
}
