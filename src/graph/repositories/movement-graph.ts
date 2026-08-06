import type {
  AnatomyPathFact,
  AnatomyPathsQuery,
  AssertionLookupQuery,
  ClinicalRuleFact,
  ClinicalRuleFactsQuery,
  ConceptCandidateFact,
  ExerciseConstraintFact,
  ExerciseConstraintFactsQuery,
  GraphQueryResult,
  MovementGraphReadHandle,
  MovementGraphReadOpenResult,
  MovementGraphReadProvider,
  ResolveConceptCandidatesQuery,
  SubstitutionCandidateFact,
  SubstitutionCandidatesQuery,
} from "../../domain/contracts/movement-clinical-queries";
import { RESOLVABLE_CONCEPT_KINDS } from "../../domain/contracts/movement-graph";
import type {
  GraphAuthority,
  MovementGraphAssertion,
  MovementGraphEdgeAssertion,
  MovementGraphNodeAssertion,
  MovementGraphSnapshot,
} from "../../domain/contracts/movement-graph";
import { normalizeConceptText } from "../../domain/policies/text-normalization";
import { MOVEMENT_GRAPH_QUERY_LIMITS } from "../schema/movement-schema";

const byAssertionId = (left: { assertionId: string }, right: { assertionId: string }) => left.assertionId.localeCompare(right.assertionId);
const resolvableKinds = new Set<string>(RESOLVABLE_CONCEPT_KINDS);
function tokenScore(query: string, candidate: string) {
  const queryTokens = new Set(normalizeConceptText(query).split(" ").filter(Boolean));
  const candidateTokens = new Set(normalizeConceptText(candidate).split(" ").filter(Boolean));
  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;
  return [...queryTokens].filter((token) => candidateTokens.has(token)).length / Math.max(queryTokens.size, candidateTokens.size);
}

type ProviderOptions = { readonly authority?: GraphAuthority; readonly activeRevisionId?: string };

export class InMemoryMovementGraphReadProvider implements MovementGraphReadProvider {
  private readonly snapshots = new Map<string, MovementGraphSnapshot>();
  private activeRevisionId?: string;
  private readonly authority: GraphAuthority;

  constructor(snapshots: readonly MovementGraphSnapshot[], options: ProviderOptions = {}) {
    for (const snapshot of snapshots) this.snapshots.set(snapshot.graphRevisionId, snapshot);
    this.authority = options.authority ?? "fixture";
    this.activeRevisionId = options.activeRevisionId ?? snapshots[0]?.graphRevisionId;
  }

  /** Infrastructure/test composition hook; it is intentionally absent from MovementGraphReadProvider. */
  setActiveRevisionForTesting(revisionId: string | undefined) { this.activeRevisionId = revisionId; }

  async openActive(): Promise<MovementGraphReadOpenResult> {
    if (!this.activeRevisionId) return { status: "unavailable", failure: { code: "graph_unavailable", message: "No active movement graph revision" } };
    return this.openRevision(this.activeRevisionId);
  }

  async openRevision(revisionId: string): Promise<MovementGraphReadOpenResult> {
    const snapshot = this.snapshots.get(revisionId);
    return snapshot
      ? { status: "ready", handle: new InMemoryMovementGraphReadHandle(snapshot, this.authority) }
      : { status: "unavailable", failure: { code: "revision_not_found", revisionId } };
  }
}

class InMemoryMovementGraphReadHandle implements MovementGraphReadHandle {
  readonly graphRevisionId: string;
  readonly authority: GraphAuthority;
  private readonly nodesById: Map<string, MovementGraphNodeAssertion>;
  private readonly assertionsById: Map<string, MovementGraphAssertion>;
  private readonly edgesByFrom = new Map<string, MovementGraphEdgeAssertion[]>();
  private readonly edgesByTo = new Map<string, MovementGraphEdgeAssertion[]>();

  constructor(private readonly snapshot: MovementGraphSnapshot, authority: GraphAuthority) {
    this.graphRevisionId = snapshot.graphRevisionId;
    this.authority = authority;
    this.nodesById = new Map(snapshot.nodes.map((node) => [node.conceptId, node]));
    this.assertionsById = new Map([...snapshot.nodes, ...snapshot.edges].map((assertion) => [assertion.assertionId, assertion]));
    for (const edge of snapshot.edges) {
      this.edgesByFrom.set(edge.fromConceptId, [...(this.edgesByFrom.get(edge.fromConceptId) ?? []), edge]);
      this.edgesByTo.set(edge.toConceptId, [...(this.edgesByTo.get(edge.toConceptId) ?? []), edge]);
    }
    for (const values of [...this.edgesByFrom.values(), ...this.edgesByTo.values()]) values.sort(byAssertionId);
  }

  private result<T>(data: T): GraphQueryResult<T> { return { status: "ok", graphRevisionId: this.graphRevisionId, authority: this.authority, data }; }
  private failure<T>(failure: Extract<GraphQueryResult<T>, { status: "failed" }>["failure"]): GraphQueryResult<T> { return { status: "failed", graphRevisionId: this.graphRevisionId, authority: this.authority, failure }; }
  private validateBounds(query: { maxResults: number; maxDepth?: number }) {
    return Number.isInteger(query.maxResults) && query.maxResults > 0 && query.maxResults <= MOVEMENT_GRAPH_QUERY_LIMITS.maxResults
      && (query.maxDepth === undefined || (Number.isInteger(query.maxDepth) && query.maxDepth > 0 && query.maxDepth <= MOVEMENT_GRAPH_QUERY_LIMITS.maxDepth));
  }

  async resolveConceptCandidates(query: ResolveConceptCandidatesQuery): Promise<GraphQueryResult<readonly ConceptCandidateFact[]>> {
    if (!this.validateBounds(query) || !normalizeConceptText(query.text) || query.kinds.length === 0) return this.failure({ code: "invalid_query", message: "A non-empty query, kind list, and valid bounds are required" });
    const normalized = normalizeConceptText(query.text);
    const facts = this.snapshot.nodes.flatMap((node): ConceptCandidateFact[] => {
      if (!resolvableKinds.has(node.kind) || !query.kinds.includes(node.kind as ConceptCandidateFact["kind"])) return [];
      const kind = node.kind as ConceptCandidateFact["kind"];
      const aliases = [node.label, ...("aliases" in node ? node.aliases : [])];
      const mappingEdges = (this.edgesByFrom.get(node.conceptId) ?? []).filter((edge): edge is Extract<MovementGraphEdgeAssertion, { kind: "maps-to" }> => edge.kind === "maps-to");
      const activeMapping = mappingEdges.some((edge) => {
        const target = this.nodesById.get(edge.toConceptId);
        return target?.kind === "ontology-concept" && target.status === "active";
      });
      const groundingStatus = activeMapping ? "active-mapping" : mappingEdges.length > 0 ? "deprecated-mapping" : "local-only";
      const mappingAssertionIds = mappingEdges.map((edge) => edge.assertionId).sort();
      const exact = aliases.filter((alias) => normalizeConceptText(alias) === normalized).sort()[0];
      if (exact) return [{ conceptId: node.conceptId, assertionId: node.assertionId, kind, label: node.label, matchedAlias: exact, exact: true, score: 1, groundingStatus, mappingAssertionIds }];
      const best = aliases.map((alias) => ({ alias, score: tokenScore(query.text, alias) })).sort((a, b) => b.score - a.score || a.alias.localeCompare(b.alias))[0];
      return best && best.score > 0 ? [{ conceptId: node.conceptId, assertionId: node.assertionId, kind, label: node.label, matchedAlias: best.alias, exact: false, score: best.score, groundingStatus, mappingAssertionIds }] : [];
    }).sort((a, b) => b.score - a.score || a.conceptId.localeCompare(b.conceptId));
    if (facts.length > query.maxResults) return this.failure({ code: "traversal_limit_exceeded", maxDepth: query.maxDepth ?? 1, maxResults: query.maxResults });
    return this.result(facts);
  }

  async getAnatomyPaths(query: AnatomyPathsQuery): Promise<GraphQueryResult<readonly AnatomyPathFact[]>> {
    if (!this.validateBounds(query) || query.maxDepth === undefined) return this.failure({ code: "invalid_query", message: "Anatomy paths require valid maxDepth and maxResults" });
    const root = this.nodesById.get(query.conceptId);
    if (!root || !["joint", "body-region"].includes(root.kind)) return this.failure({ code: "unresolved_concept", conceptId: query.conceptId });
    const facts: AnatomyPathFact[] = query.includeSelf ? [{ descendantConceptId: root.conceptId, ancestorConceptId: root.conceptId, nodeAssertionIds: [root.assertionId], edgeAssertionIds: [] }] : [];
    const queue = [{ id: root.conceptId, nodeIds: [root.assertionId], edgeIds: [] as string[], depth: 0 }];
    const visited = new Set([root.conceptId]); let exceeded = false;
    while (queue.length) {
      const current = queue.shift()!;
      const children = (this.edgesByTo.get(current.id) ?? []).filter((edge) => edge.kind === "part-of");
      if (current.depth >= query.maxDepth) { if (children.some((edge) => !visited.has(edge.fromConceptId))) exceeded = true; continue; }
      for (const edge of children) {
        if (visited.has(edge.fromConceptId)) continue;
        const node = this.nodesById.get(edge.fromConceptId);
        if (!node) return this.failure({ code: "broken_assertion", assertionId: edge.assertionId });
        visited.add(node.conceptId);
        const next = { id: node.conceptId, nodeIds: [...current.nodeIds, node.assertionId], edgeIds: [...current.edgeIds, edge.assertionId], depth: current.depth + 1 };
        facts.push({ descendantConceptId: node.conceptId, ancestorConceptId: root.conceptId, nodeAssertionIds: next.nodeIds, edgeAssertionIds: next.edgeIds });
        queue.push(next);
      }
    }
    facts.sort((a, b) => a.descendantConceptId.localeCompare(b.descendantConceptId));
    if (exceeded || facts.length > query.maxResults) return this.failure({ code: "traversal_limit_exceeded", maxDepth: query.maxDepth, maxResults: query.maxResults });
    return this.result(facts);
  }

  async getClinicalRuleFacts(query: ClinicalRuleFactsQuery): Promise<GraphQueryResult<readonly ClinicalRuleFact[]>> {
    if (!this.validateBounds(query)) return this.failure({ code: "invalid_query", message: "Clinical rule query bounds are invalid" });
    const condition = this.nodesById.get(query.conditionConceptId);
    if (!condition || condition.kind !== "condition") return this.failure({ code: "unresolved_concept", conceptId: query.conditionConceptId });
    const facts: ClinicalRuleFact[] = [];
    for (const constraint of (this.edgesByFrom.get(condition.conceptId) ?? []).filter((edge) => edge.kind === "has-constraint")) {
      const rule = this.nodesById.get(constraint.toConceptId);
      if (!rule || rule.kind !== "clinical-rule") return this.failure({ code: "broken_assertion", assertionId: constraint.assertionId });
      const targets = (this.edgesByFrom.get(rule.conceptId) ?? []).filter((edge) => ["contraindicates", "cautions", "downranks"].includes(edge.kind));
      for (const targetEdge of targets) {
        if (query.targetConceptIds && !query.targetConceptIds.includes(targetEdge.toConceptId)) continue;
        const target = this.nodesById.get(targetEdge.toConceptId);
        if (!target) return this.failure({ code: "broken_assertion", assertionId: targetEdge.assertionId });
        const evidenceEdges = (this.edgesByFrom.get(rule.conceptId) ?? []).filter((edge) => edge.kind === "supported-by");
        const mappingEdges = [condition.conceptId, target.conceptId].flatMap((id) => (this.edgesByFrom.get(id) ?? []).filter((edge) => edge.kind === "maps-to"));
        facts.push({ conditionConceptId: condition.conceptId, conditionAssertionId: condition.assertionId, ruleConceptId: rule.conceptId, ruleAssertionId: rule.assertionId, effect: rule.effect, applicability: rule.applicability, overridePolicy: rule.overridePolicy, targetConceptId: target.conceptId, targetKind: target.kind as ClinicalRuleFact["targetKind"], pathAssertionIds: [condition.assertionId, constraint.assertionId, rule.assertionId, targetEdge.assertionId, target.assertionId], mappingAssertionIds: mappingEdges.map((edge) => edge.assertionId).sort(), evidenceAssertionIds: evidenceEdges.flatMap((edge) => [edge.assertionId, this.nodesById.get(edge.toConceptId)?.assertionId].filter((id): id is string => Boolean(id))).sort() });
      }
    }
    facts.sort((a, b) => a.ruleConceptId.localeCompare(b.ruleConceptId) || a.targetConceptId.localeCompare(b.targetConceptId));
    if (facts.length > query.maxResults) return this.failure({ code: "traversal_limit_exceeded", maxDepth: query.maxDepth ?? 2, maxResults: query.maxResults });
    return this.result(facts);
  }

  async getExerciseConstraintFacts(query: ExerciseConstraintFactsQuery): Promise<GraphQueryResult<ExerciseConstraintFact>> {
    if (!this.validateBounds(query)) return this.failure({ code: "invalid_query", message: "Exercise facts query bounds are invalid" });
    const exercise = this.nodesById.get(query.exerciseConceptId);
    if (!exercise || exercise.kind !== "exercise") return this.failure({ code: "unresolved_concept", conceptId: query.exerciseConceptId });
    const relations = (this.edgesByFrom.get(exercise.conceptId) ?? []).flatMap((edge): ExerciseConstraintFact["relations"][number][] => {
      if (!["has-demand", "expresses", "stresses", "requires"].includes(edge.kind)) return [];
      const target = this.nodesById.get(edge.toConceptId);
      if (!target) return [];
      return [{
        kind: edge.kind as ExerciseConstraintFact["relations"][number]["kind"],
        targetConceptId: target.conceptId,
        targetKind: target.kind as ExerciseConstraintFact["relations"][number]["targetKind"],
        targetAssertionId: target.assertionId,
        edgeAssertionId: edge.assertionId,
      }];
    }).sort((left, right) => left.kind.localeCompare(right.kind)
      || left.targetConceptId.localeCompare(right.targetConceptId)
      || left.edgeAssertionId.localeCompare(right.edgeAssertionId));
    if (relations.length > query.maxResults) return this.failure({ code: "traversal_limit_exceeded", maxDepth: query.maxDepth ?? 1, maxResults: query.maxResults });
    return this.result({ exerciseConceptId: exercise.conceptId, exerciseAssertionId: exercise.assertionId, attributes: exercise.attributes, relations });
  }

  async getSubstitutionCandidates(query: SubstitutionCandidatesQuery): Promise<GraphQueryResult<readonly SubstitutionCandidateFact[]>> {
    if (!this.validateBounds(query)) return this.failure({ code: "invalid_query", message: "Substitution query bounds are invalid" });
    const exercise = this.nodesById.get(query.exerciseConceptId);
    if (!exercise || exercise.kind !== "exercise") return this.failure({ code: "unresolved_concept", conceptId: query.exerciseConceptId });
    const facts = (this.edgesByTo.get(exercise.conceptId) ?? []).filter((edge): edge is Extract<MovementGraphEdgeAssertion, { kind: "substitution-candidate-for" }> => edge.kind === "substitution-candidate-for").map((edge) => {
      const candidate = this.nodesById.get(edge.fromConceptId);
      return candidate?.kind === "exercise" ? { exerciseConceptId: candidate.conceptId, exerciseAssertionId: candidate.assertionId, substitutionAssertionId: edge.assertionId, rank: edge.rank, preservedIntent: edge.preservedIntent, curator: edge.curator, reviewedAt: edge.reviewedAt } : undefined;
    }).filter((fact): fact is SubstitutionCandidateFact => Boolean(fact)).sort((a, b) => a.rank - b.rank || a.exerciseConceptId.localeCompare(b.exerciseConceptId));
    if (facts.length > query.maxResults) return this.failure({ code: "traversal_limit_exceeded", maxDepth: query.maxDepth ?? 1, maxResults: query.maxResults });
    return this.result(facts);
  }

  async getAssertions(query: AssertionLookupQuery): Promise<GraphQueryResult<readonly MovementGraphAssertion[]>> {
    if (!this.validateBounds(query) || query.assertionIds.length === 0) return this.failure({ code: "invalid_query", message: "Assertion lookup requires IDs and valid bounds" });
    if (query.assertionIds.length > query.maxResults) return this.failure({ code: "traversal_limit_exceeded", maxDepth: query.maxDepth ?? 1, maxResults: query.maxResults });
    const assertions: MovementGraphAssertion[] = [];
    for (const id of [...new Set(query.assertionIds)].sort()) {
      const assertion = this.assertionsById.get(id);
      if (!assertion) return this.failure({ code: "broken_assertion", assertionId: id });
      assertions.push(assertion);
    }
    return this.result(assertions);
  }
}
