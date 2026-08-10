import type {
  FullGraphEntityKind,
  FullGraphNode,
  FullGraphProjection,
  FullGraphRelationship,
} from "../../domain/contracts/full-graph-view";

export const FULL_GRAPH_CATEGORY_ORDER = ["domain", "identity", "lineage", "publication"] as const;
export type FullGraphCategory = FullGraphNode["category"];

export const FULL_GRAPH_HIGH_DEGREE_THRESHOLD = 12;
export const FULL_GRAPH_BUNDLE_PREVIEW_LIMIT = 12;
export const FULL_GRAPH_SUGGESTION_LIMIT = 8;

const MISSING_ENDPOINT_LABEL = "Loading node details";
const CATEGORY_LABELS: Readonly<Record<FullGraphCategory, string>> = {
  domain: "Domain",
  identity: "Identity",
  lineage: "Lineage",
  publication: "Publication",
};
const CATEGORY_RANK = new Map<FullGraphCategory, number>(
  FULL_GRAPH_CATEGORY_ORDER.map((category, index) => [category, index]),
);

export type FullGraphNodeDescriptor = FullGraphNode & {
  /** Stable internal callback key. Never use as display copy. */
  readonly key: string;
  readonly node: FullGraphNode;
  /** Human-readable and duplicate-safe card label. */
  readonly label: string;
  readonly kindLabel: string;
  readonly categoryLabel: string;
  readonly accessibilityName: string;
  readonly relationshipCount: number;
  readonly humanOrdinal: number | null;
};

export type FullGraphRelationshipDescriptor = FullGraphRelationship & {
  /** Stable internal callback key. Never use as display copy. */
  readonly key: string;
  readonly relationship: FullGraphRelationship;
  readonly kindLabel: string;
  readonly from: FullGraphNodeDescriptor | undefined;
  readonly to: FullGraphNodeDescriptor | undefined;
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly storedDirectionLabel: string;
  readonly accessibilityName: string;
  readonly hasMissingEndpoint: boolean;
};

export type FullGraphEntryKindGroup = {
  readonly kind: string;
  readonly kindLabel: string;
  readonly nodes: readonly FullGraphNodeDescriptor[];
  readonly nodeCount: number;
};

export type FullGraphEntryGroup = {
  readonly category: FullGraphCategory;
  readonly categoryLabel: string;
  readonly kindGroups: readonly FullGraphEntryKindGroup[];
  readonly nodeCount: number;
};

export type FullGraphCountProvenance = {
  readonly loaded: number;
  readonly total: number | null;
  readonly totalSource: "complete-projection" | "authoritative-metadata" | "unavailable";
};

export type FullGraphInventoryCounts = {
  readonly nodes: FullGraphCountProvenance;
  readonly relationships: FullGraphCountProvenance;
};

export type FullGraphInventory = {
  readonly nodes: readonly FullGraphNodeDescriptor[];
  readonly relationships: readonly FullGraphRelationshipDescriptor[];
  readonly counts: FullGraphInventoryCounts;
  readonly isComplete: boolean;
};

export type FullGraphCompleteness = {
  readonly isComplete: boolean;
  readonly canFollow: boolean;
  readonly loading: boolean;
  readonly missingEndpointCount: number;
  readonly issues: readonly FullGraphProjectionIssue[];
};

export type FullGraphProjectionIssue =
  | "count-mismatch"
  | "duplicate-node"
  | "duplicate-relationship"
  | "missing-endpoint"
  | "mixed-revision";

export type FullGraphContextResetInputs = {
  readonly domain: FullGraphProjection["domain"];
  readonly memberId: string | null;
  readonly revisionId: string;
  readonly sourceArtifactDigest: string | null;
  readonly projectionIdentity: string;
  readonly operation: string;
};

export type FullGraphContextIdentity = {
  /** Internal reset key. It may contain machine identity and must not be rendered. */
  readonly key: string;
  readonly resetInputs: FullGraphContextResetInputs;
};

export type FullGraphBuildOptions = {
  readonly loading?: boolean;
  readonly initialNodeId?: string;
  readonly projectionIdentity?: string;
  readonly operation?: string;
};

export type FullGraphKindGroup = FullGraphEntryKindGroup;

export type FullGraphViewModel = {
  readonly status: "complete" | "partial" | "empty" | "invalid";
  readonly context: FullGraphContextIdentity;
  readonly completeness: FullGraphCompleteness;
  readonly entryGroups: readonly FullGraphEntryGroup[];
  readonly suggestedRoots: readonly FullGraphNodeDescriptor[];
  readonly seededRoot: FullGraphNodeDescriptor | null;
  readonly focusedAnchor: FullGraphNodeDescriptor | null;
  readonly inventory: FullGraphInventory;
  readonly nodeById: ReadonlyMap<string, FullGraphNodeDescriptor>;
  readonly relationshipById: ReadonlyMap<string, FullGraphRelationshipDescriptor>;
  readonly outgoingByNodeId: ReadonlyMap<string, readonly FullGraphRelationshipDescriptor[]>;
  readonly incomingByNodeId: ReadonlyMap<string, readonly FullGraphRelationshipDescriptor[]>;
  readonly degreeByNodeId: ReadonlyMap<string, number>;
};

export type FullGraphBranchPathEntry = {
  readonly pathKey: string;
  readonly nodeId: string;
  readonly parentPathKey: string | null;
  readonly viaRelationshipId: string | null;
  readonly direction: FullGraphFollowDirection | null;
};

export type FullGraphBranchState = {
  readonly contextKey: string;
  readonly path: readonly FullGraphBranchPathEntry[];
};

export type FullGraphSelection = {
  readonly entityKind: FullGraphEntityKind;
  readonly entityId: string;
};

export type FullGraphInteractionState = {
  readonly contextKey: string;
  readonly requestGeneration: number;
  readonly branch: FullGraphBranchState;
  /** Provenance/detail selection is intentionally independent of branch ownership. */
  readonly selection: FullGraphSelection | null;
};

export type FullGraphFollowDirection = "outgoing" | "incoming";
export type FullGraphCandidateMarker =
  | "available"
  | "active-path"
  | "existing-path"
  | "shared-connection"
  | "missing-endpoint";

export type FullGraphBranchCandidate = {
  readonly key: string;
  readonly parentPathKey: string;
  readonly parentNode: FullGraphNodeDescriptor;
  readonly neighbor: FullGraphNodeDescriptor | undefined;
  readonly neighborLabel: string;
  readonly relationship: FullGraphRelationshipDescriptor;
  readonly direction: FullGraphFollowDirection;
  readonly followLabel: string;
  readonly accessibilityName: string;
  readonly marker: FullGraphCandidateMarker;
  readonly canFollow: boolean;
  readonly ownsCanonicalCard: boolean;
};

export type FullGraphRelationshipBundle = {
  readonly key: string;
  readonly direction: FullGraphFollowDirection;
  readonly relationshipKind: string;
  readonly kindLabel: string;
  readonly isBundle: boolean;
  readonly candidates: readonly FullGraphBranchCandidate[];
  readonly visibleCount: number;
  readonly totalCount: number;
};

export type FullGraphBranchLevel = {
  readonly pathEntry: FullGraphBranchPathEntry;
  readonly node: FullGraphNodeDescriptor;
  readonly isCurrent: boolean;
  readonly isHighDegree: boolean;
  readonly groups: readonly FullGraphRelationshipBundle[];
};

export type FullGraphBranch = {
  readonly contextKey: string;
  readonly path: readonly FullGraphBranchPathEntry[];
  readonly levels: readonly FullGraphBranchLevel[];
  readonly canonicalCardOwnerByNodeId: ReadonlyMap<string, string>;
};

export type FullGraphInteractionAction =
  | { readonly type: "set-root"; readonly nodeId: string }
  | { readonly type: "follow"; readonly candidateKey: string }
  | { readonly type: "toggle-path"; readonly pathKey: string }
  | { readonly type: "select"; readonly entityKind: FullGraphEntityKind; readonly entityId: string }
  | { readonly type: "clear-selection" }
  | { readonly type: "reset" };

export type FullGraphInventoryFilter = {
  readonly text?: string;
  readonly kinds?: readonly string[];
  readonly categories?: readonly FullGraphCategory[];
  readonly relationshipKinds?: readonly string[];
};

const compareText = (left: string, right: string): number => left.localeCompare(right);
const normalizeSearchText = (value: string): string => value.trim().toLocaleLowerCase();
const capitalize = (value: string): string => value ? `${value[0]!.toLocaleUpperCase()}${value.slice(1)}` : "Unknown";

export function humanizeGraphKind(value: string, type: FullGraphEntityKind = "node"): string {
  const words = value
    .trim()
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
  const fallback = type === "node" ? "Unknown kind" : "related to";
  if (!words) return fallback;
  return type === "node" ? capitalize(words) : words;
}

function compareRawNodes(left: FullGraphNode, right: FullGraphNode): number {
  return compareText(humanizeGraphKind(left.kind), humanizeGraphKind(right.kind))
    || compareText(left.label.trim(), right.label.trim())
    || compareText(left.id, right.id);
}

function projectionFingerprint(projection: FullGraphProjection): string {
  const canonical = JSON.stringify({
    counts: projection.counts,
    page: projection.page ?? null,
    nodes: [...projection.nodes]
      .sort((left, right) => compareText(left.id, right.id))
      .map((item) => [item.id, item.kind, item.label, item.category, item.revisionId]),
    relationships: [...projection.relationships]
      .sort((left, right) => compareText(left.id, right.id))
      .map((item) => [item.id, item.kind, item.fromId, item.toId, item.revisionId]),
  });
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < canonical.length; index += 1) {
    const code = canonical.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `projection-${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function contextIdentity(
  projection: FullGraphProjection,
  options: FullGraphBuildOptions,
): FullGraphContextIdentity {
  const resetInputs: FullGraphContextResetInputs = {
    domain: projection.domain,
    memberId: projection.memberId ?? null,
    revisionId: projection.revisionId,
    sourceArtifactDigest: projection.sourceArtifactDigest ?? null,
    projectionIdentity: options.projectionIdentity ?? projectionFingerprint(projection),
    operation: options.operation ?? "browse",
  };
  return { key: JSON.stringify(resetInputs), resetInputs };
}

function projectionIssues(projection: FullGraphProjection, pageIsComplete: boolean): readonly FullGraphProjectionIssue[] {
  const issues = new Set<FullGraphProjectionIssue>();
  const nodeIds = new Set<string>();
  const relationshipIds = new Set<string>();
  for (const item of projection.nodes) {
    if (nodeIds.has(item.id)) issues.add("duplicate-node");
    nodeIds.add(item.id);
    if (item.revisionId !== projection.revisionId) issues.add("mixed-revision");
  }
  for (const item of projection.relationships) {
    if (relationshipIds.has(item.id)) issues.add("duplicate-relationship");
    relationshipIds.add(item.id);
    if (item.revisionId !== projection.revisionId) issues.add("mixed-revision");
    if (!nodeIds.has(item.fromId) || !nodeIds.has(item.toId)) issues.add("missing-endpoint");
  }
  if (pageIsComplete && (
    projection.counts.nodes !== projection.nodes.length
    || projection.counts.relationships !== projection.relationships.length
  )) issues.add("count-mismatch");
  return [...issues].sort(compareText);
}

function countProvenance(loaded: number, declaredTotal: number, isComplete: boolean): FullGraphCountProvenance {
  if (isComplete) return { loaded, total: loaded, totalSource: "complete-projection" };
  if (Number.isSafeInteger(declaredTotal) && declaredTotal >= loaded) {
    return { loaded, total: declaredTotal, totalSource: "authoritative-metadata" };
  }
  return { loaded, total: null, totalSource: "unavailable" };
}

function nodeIdentifierValues(node: FullGraphNode, projection: FullGraphProjection): ReadonlySet<string> {
  const source = node.provenance.source;
  return new Set([
    node.id,
    node.revisionId,
    projection.revisionId,
    projection.sourceArtifactDigest,
    node.provenance.assertionId,
    source?.sourceId,
    source?.sourceRevision,
    source?.sourceRecordId,
    source?.locator,
    source?.artifactDigest,
    ...node.provenance.lineageIds,
  ].flatMap((value) => value?.trim() ? [value.trim()] : []));
}

function humanNodeLabel(node: FullGraphNode, projection: FullGraphProjection, kindLabel: string): string {
  const label = node.label.trim();
  return label && !nodeIdentifierValues(node, projection).has(label)
    ? label
    : `${kindLabel} (unnamed)`;
}

function nodeDescriptors(
  projection: FullGraphProjection,
  degreeByNodeId: ReadonlyMap<string, number>,
): readonly FullGraphNodeDescriptor[] {
  const bases = [...projection.nodes].sort(compareRawNodes).map((item) => ({
    node: item,
    kindLabel: humanizeGraphKind(item.kind, "node"),
    baseLabel: humanNodeLabel(item, projection, humanizeGraphKind(item.kind, "node")),
  }));
  const duplicates = new Map<string, typeof bases>();
  for (const item of bases) {
    const key = normalizeSearchText(item.baseLabel);
    const group = duplicates.get(key) ?? [];
    group.push(item);
    duplicates.set(key, group);
  }
  const ordinalById = new Map<string, number>();
  for (const group of duplicates.values()) {
    if (group.length < 2) continue;
    [...group]
      .sort((left, right) => compareText(left.kindLabel, right.kindLabel) || compareText(left.node.id, right.node.id))
      .forEach((item, index) => ordinalById.set(item.node.id, index + 1));
  }
  return bases.map(({ node: item, kindLabel, baseLabel }) => {
    const humanOrdinal = ordinalById.get(item.id) ?? null;
    const label = humanOrdinal === null ? baseLabel : `${baseLabel} · ${kindLabel} ${humanOrdinal}`;
    const relationshipCount = degreeByNodeId.get(item.id) ?? 0;
    const countLabel = `${relationshipCount} ${relationshipCount === 1 ? "relationship" : "relationships"}`;
    return {
      ...item,
      key: item.id,
      node: item,
      label,
      kindLabel,
      categoryLabel: CATEGORY_LABELS[item.category],
      accessibilityName: `${label} · ${kindLabel} · ${countLabel}`,
      relationshipCount,
      humanOrdinal,
    };
  });
}

function compareNodeDescriptors(left: FullGraphNodeDescriptor, right: FullGraphNodeDescriptor): number {
  return (CATEGORY_RANK.get(left.category) ?? Number.MAX_SAFE_INTEGER)
    - (CATEGORY_RANK.get(right.category) ?? Number.MAX_SAFE_INTEGER)
    || compareText(left.kindLabel, right.kindLabel)
    || compareText(left.label, right.label)
    || compareText(left.key, right.key);
}

function relationshipDescriptors(
  projection: FullGraphProjection,
  nodeById: ReadonlyMap<string, FullGraphNodeDescriptor>,
): readonly FullGraphRelationshipDescriptor[] {
  return projection.relationships.map((item): FullGraphRelationshipDescriptor => {
    const from = nodeById.get(item.fromId);
    const to = nodeById.get(item.toId);
    const kindLabel = humanizeGraphKind(item.kind, "relationship");
    const fromLabel = from?.label ?? MISSING_ENDPOINT_LABEL;
    const toLabel = to?.label ?? MISSING_ENDPOINT_LABEL;
    const storedDirectionLabel = `${fromLabel} → ${kindLabel} → ${toLabel}`;
    return {
      ...item,
      key: item.id,
      relationship: item,
      kindLabel,
      from,
      to,
      fromLabel,
      toLabel,
      storedDirectionLabel,
      accessibilityName: storedDirectionLabel,
      hasMissingEndpoint: !from || !to,
    };
  }).sort((left, right) => compareText(left.kindLabel, right.kindLabel)
    || compareText(left.fromLabel, right.fromLabel)
    || compareText(left.toLabel, right.toLabel)
    || compareText(left.key, right.key));
}

function entryGroups(nodes: readonly FullGraphNodeDescriptor[]): readonly FullGraphEntryGroup[] {
  const byCategory = new Map<FullGraphCategory, Map<string, FullGraphNodeDescriptor[]>>();
  for (const item of nodes) {
    const kinds = byCategory.get(item.category) ?? new Map<string, FullGraphNodeDescriptor[]>();
    const kindNodes = kinds.get(item.kind) ?? [];
    kindNodes.push(item);
    kinds.set(item.kind, kindNodes);
    byCategory.set(item.category, kinds);
  }
  return [...byCategory.entries()]
    .sort(([left], [right]) => (CATEGORY_RANK.get(left) ?? Number.MAX_SAFE_INTEGER)
      - (CATEGORY_RANK.get(right) ?? Number.MAX_SAFE_INTEGER))
    .map(([category, kinds]) => {
      const kindGroups = [...kinds.entries()]
        .sort(([leftKind], [rightKind]) => compareText(humanizeGraphKind(leftKind), humanizeGraphKind(rightKind)))
        .map(([kind, kindNodes]): FullGraphEntryKindGroup => ({
          kind,
          kindLabel: humanizeGraphKind(kind, "node"),
          nodes: [...kindNodes].sort(compareNodeDescriptors),
          nodeCount: kindNodes.length,
        }));
      return {
        category,
        categoryLabel: CATEGORY_LABELS[category],
        kindGroups,
        nodeCount: kindGroups.reduce((total, group) => total + group.nodeCount, 0),
      };
    });
}

function suggestedRoots(nodes: readonly FullGraphNodeDescriptor[]): readonly FullGraphNodeDescriptor[] {
  const rankedByCategory = FULL_GRAPH_CATEGORY_ORDER.map((category) => nodes
    .filter((item) => item.category === category)
    .sort((left, right) => right.relationshipCount - left.relationshipCount || compareNodeDescriptors(left, right)));
  const result: FullGraphNodeDescriptor[] = [];
  for (let rank = 0; result.length < FULL_GRAPH_SUGGESTION_LIMIT; rank += 1) {
    let added = false;
    for (const categoryNodes of rankedByCategory) {
      const candidate = categoryNodes[rank];
      if (!candidate) continue;
      result.push(candidate);
      added = true;
      if (result.length === FULL_GRAPH_SUGGESTION_LIMIT) break;
    }
    if (!added) break;
  }
  return result;
}

function memberSeed(
  projection: FullGraphProjection,
  nodes: readonly FullGraphNodeDescriptor[],
): FullGraphNodeDescriptor | null {
  if (projection.domain !== "member-context") return null;
  const members = nodes.filter((item) => item.kind === "member");
  if (!projection.memberId) return members[0] ?? null;
  return members.find((item) => item.key === projection.memberId || item.key.endsWith(`:${projection.memberId}`))
    ?? members[0]
    ?? null;
}

export function buildFullGraphViewModel(
  projection: FullGraphProjection,
  options: FullGraphBuildOptions = {},
): FullGraphViewModel {
  const loading = options.loading ?? false;
  const pageIsComplete = !loading && (!projection.page
    || (!projection.page.hasMoreNodes && !projection.page.hasMoreRelationships));
  const issues = projectionIssues(projection, pageIsComplete);
  const structuralIssues = issues.filter((issue) => issue !== "missing-endpoint");
  const nodeIds = new Set(projection.nodes.map((node) => node.id));
  const missingEndpointCount = projection.relationships.filter((item) => !nodeIds.has(item.fromId)
    || !nodeIds.has(item.toId)).length;
  const invalid = pageIsComplete && (structuralIssues.length > 0 || missingEndpointCount > 0);
  const isComplete = pageIsComplete && !invalid;

  const degreeByNodeId = new Map(projection.nodes.map((item) => [item.id, 0]));
  for (const item of projection.relationships) {
    if (degreeByNodeId.has(item.fromId)) degreeByNodeId.set(item.fromId, (degreeByNodeId.get(item.fromId) ?? 0) + 1);
    if (item.toId !== item.fromId && degreeByNodeId.has(item.toId)) {
      degreeByNodeId.set(item.toId, (degreeByNodeId.get(item.toId) ?? 0) + 1);
    }
  }

  const nodes = [...nodeDescriptors(projection, degreeByNodeId)].sort(compareNodeDescriptors);
  const nodeById = new Map<string, FullGraphNodeDescriptor>(nodes.map((item) => [item.key, item]));
  const relationships = relationshipDescriptors(projection, nodeById);
  const relationshipById = new Map<string, FullGraphRelationshipDescriptor>(relationships.map((item) => [item.key, item]));
  const outgoingByNodeId = new Map<string, FullGraphRelationshipDescriptor[]>(
    nodes.map((item) => [item.key, []]),
  );
  const incomingByNodeId = new Map<string, FullGraphRelationshipDescriptor[]>(
    nodes.map((item) => [item.key, []]),
  );
  for (const item of relationships) {
    outgoingByNodeId.get(item.fromId)?.push(item);
    incomingByNodeId.get(item.toId)?.push(item);
  }

  const groups = entryGroups(nodes);
  const inventoryCounts: FullGraphInventoryCounts = {
    nodes: countProvenance(nodes.length, projection.counts.nodes, isComplete),
    relationships: countProvenance(relationships.length, projection.counts.relationships, isComplete),
  };
  const status: FullGraphViewModel["status"] = invalid
    ? "invalid"
    : !isComplete
      ? "partial"
      : nodes.length === 0 && relationships.length === 0
        ? "empty"
        : "complete";
  const context = contextIdentity(projection, options);

  return {
    status,
    context,
    completeness: {
      isComplete,
      canFollow: isComplete,
      loading,
      missingEndpointCount,
      issues,
    },
    entryGroups: groups,
    suggestedRoots: suggestedRoots(nodes),
    seededRoot: memberSeed(projection, nodes),
    focusedAnchor: options.initialNodeId ? nodeById.get(options.initialNodeId) ?? null : null,
    inventory: { nodes, relationships, counts: inventoryCounts, isComplete },
    nodeById,
    relationshipById,
    outgoingByNodeId,
    incomingByNodeId,
    degreeByNodeId,
  };
}

function reverseRelationshipLabel(kindLabel: string): string {
  const known: Readonly<Record<string, string>> = {
    "part of": "has part",
    "sent by": "has sent",
    "supported by": "supports",
    targets: "targeted by",
    describes: "described by",
    "published in": "publishes",
    "in revision": "includes",
    "has option": "is an option for",
  };
  return `${known[kindLabel] ?? "incoming connection"} · reverse of ${kindLabel}`;
}

function rootPathEntry(nodeId: string): FullGraphBranchPathEntry {
  return {
    pathKey: `root:${nodeId}`,
    nodeId,
    parentPathKey: null,
    viaRelationshipId: null,
    direction: null,
  };
}

function childPathEntry(
  parent: FullGraphBranchPathEntry,
  candidate: FullGraphBranchCandidate,
): FullGraphBranchPathEntry {
  const nodeId = candidate.neighbor!.key;
  return {
    pathKey: `${parent.pathKey}>${candidate.direction}:${candidate.relationship.key}:${nodeId}`,
    nodeId,
    parentPathKey: parent.pathKey,
    viaRelationshipId: candidate.relationship.key,
    direction: candidate.direction,
  };
}

export function createFullGraphInteractionState(
  model: FullGraphViewModel,
  requestGeneration = 0,
): FullGraphInteractionState {
  const seed = model.completeness.canFollow ? model.seededRoot : null;
  const path = seed ? [rootPathEntry(seed.key)] : [];
  return {
    contextKey: model.context.key,
    requestGeneration,
    branch: { contextKey: model.context.key, path },
    selection: null,
  };
}

export function isFullGraphInteractionCurrent(
  model: FullGraphViewModel,
  state: FullGraphInteractionState,
  requestGeneration: number,
): boolean {
  return state.contextKey === model.context.key
    && state.branch.contextKey === model.context.key
    && state.requestGeneration === requestGeneration;
}

function candidateKey(
  parentPathKey: string,
  relationshipId: string,
  direction: FullGraphFollowDirection,
  neighborId: string,
): string {
  return `${parentPathKey}|${direction}|${relationshipId}|${neighborId}`;
}

function candidateInputs(
  model: FullGraphViewModel,
  entry: FullGraphBranchPathEntry,
): readonly {
  readonly relationship: FullGraphRelationshipDescriptor;
  readonly direction: FullGraphFollowDirection;
  readonly neighborId: string;
  }[] {
  const outgoing = (model.outgoingByNodeId.get(entry.nodeId) ?? []).map((relationship) => ({
    relationship,
    direction: "outgoing" as const,
    neighborId: relationship.toId,
  }));
  const incoming = (model.incomingByNodeId.get(entry.nodeId) ?? []).map((relationship) => ({
    relationship,
    direction: "incoming" as const,
    neighborId: relationship.fromId,
  }));
  return [...outgoing, ...incoming].sort((left, right) => compareText(left.direction, right.direction)
    || compareText(left.relationship.kindLabel, right.relationship.kindLabel)
    || compareText(model.nodeById.get(left.neighborId)?.label ?? MISSING_ENDPOINT_LABEL, model.nodeById.get(right.neighborId)?.label ?? MISSING_ENDPOINT_LABEL)
    || compareText(left.relationship.key, right.relationship.key));
}

export function deriveFullGraphBranch(
  model: FullGraphViewModel,
  state: FullGraphBranchState,
): FullGraphBranch {
  if (state.contextKey !== model.context.key || !model.completeness.canFollow) {
    return { contextKey: model.context.key, path: [], levels: [], canonicalCardOwnerByNodeId: new Map() };
  }
  const validPath = state.path.filter((entry, index) => {
    if (!model.nodeById.has(entry.nodeId)) return false;
    if (index === 0) return entry.parentPathKey === null;
    return entry.parentPathKey === state.path[index - 1]?.pathKey;
  });
  const canonicalOwners = new Map<string, string>();
  for (const entry of validPath) canonicalOwners.set(entry.nodeId, entry.pathKey);
  const pathNodeIds = new Set(validPath.map((entry) => entry.nodeId));
  const levels: FullGraphBranchLevel[] = [];

  for (const [index, entry] of validPath.entries()) {
    const parentNode = model.nodeById.get(entry.nodeId)!;
    const candidates: FullGraphBranchCandidate[] = [];
    for (const input of candidateInputs(model, entry)) {
      const neighbor = model.nodeById.get(input.neighborId);
      const key = candidateKey(entry.pathKey, input.relationship.key, input.direction, input.neighborId);
      const nextPathEntry = validPath[index + 1];
      const isActivePath = nextPathEntry?.nodeId === input.neighborId
        && nextPathEntry.viaRelationshipId === input.relationship.key
        && nextPathEntry.direction === input.direction;
      let marker: FullGraphCandidateMarker;
      let ownsCanonicalCard = false;
      if (!neighbor) marker = "missing-endpoint";
      else if (isActivePath) marker = "active-path";
      else if (pathNodeIds.has(neighbor.key)) marker = "existing-path";
      else if (canonicalOwners.has(neighbor.key)) marker = "shared-connection";
      else {
        marker = "available";
        ownsCanonicalCard = true;
        canonicalOwners.set(neighbor.key, key);
      }
      const followLabel = input.direction === "outgoing"
        ? input.relationship.kindLabel
        : reverseRelationshipLabel(input.relationship.kindLabel);
      const neighborLabel = neighbor?.label ?? MISSING_ENDPOINT_LABEL;
      candidates.push({
        key,
        parentPathKey: entry.pathKey,
        parentNode,
        neighbor,
        neighborLabel,
        relationship: input.relationship,
        direction: input.direction,
        followLabel,
        accessibilityName: `Follow ${neighborLabel} through ${followLabel}. Stored direction: ${input.relationship.storedDirectionLabel}`,
        marker,
        canFollow: Boolean(neighbor) && ownsCanonicalCard,
        ownsCanonicalCard,
      });
    }

    const isHighDegree = (model.degreeByNodeId.get(entry.nodeId) ?? 0) > FULL_GRAPH_HIGH_DEGREE_THRESHOLD;
    const grouped = new Map<string, FullGraphBranchCandidate[]>();
    for (const candidate of candidates) {
      const groupKey = `${candidate.direction}:${candidate.relationship.kind}`;
      const group = grouped.get(groupKey) ?? [];
      group.push(candidate);
      grouped.set(groupKey, group);
    }
    const groups = [...grouped.entries()].map(([key, groupCandidates]): FullGraphRelationshipBundle => {
      const first = groupCandidates[0]!;
      const visible = isHighDegree ? groupCandidates.slice(0, FULL_GRAPH_BUNDLE_PREVIEW_LIMIT) : groupCandidates;
      return {
        key: `${entry.pathKey}|bundle:${key}`,
        direction: first.direction,
        relationshipKind: first.relationship.kind,
        kindLabel: first.relationship.kindLabel,
        isBundle: isHighDegree,
        candidates: visible,
        visibleCount: visible.length,
        totalCount: groupCandidates.length,
      };
    }).sort((left, right) => compareText(left.direction, right.direction)
      || compareText(left.kindLabel, right.kindLabel)
      || compareText(left.key, right.key));
    levels.push({
      pathEntry: entry,
      node: parentNode,
      isCurrent: index === validPath.length - 1,
      isHighDegree,
      groups,
    });
  }

  return {
    contextKey: model.context.key,
    path: validPath,
    levels,
    canonicalCardOwnerByNodeId: canonicalOwners,
  };
}

function freshForStaleState(model: FullGraphViewModel, state: FullGraphInteractionState): FullGraphInteractionState {
  return createFullGraphInteractionState(model, state.requestGeneration + 1);
}

export function transitionFullGraphInteraction(
  model: FullGraphViewModel,
  state: FullGraphInteractionState,
  action: FullGraphInteractionAction,
): FullGraphInteractionState {
  if (state.contextKey !== model.context.key || state.branch.contextKey !== model.context.key) {
    return freshForStaleState(model, state);
  }
  if (action.type === "reset") return createFullGraphInteractionState(model, state.requestGeneration);
  if (action.type === "clear-selection") return { ...state, selection: null };
  if (action.type === "select") {
    const exists = action.entityKind === "node"
      ? model.nodeById.has(action.entityId)
      : model.relationshipById.has(action.entityId);
    return exists ? { ...state, selection: { entityKind: action.entityKind, entityId: action.entityId } } : state;
  }
  if (!model.completeness.canFollow) return state;
  if (action.type === "set-root") {
    if (!model.nodeById.has(action.nodeId)) return state;
    return { ...state, branch: { contextKey: model.context.key, path: [rootPathEntry(action.nodeId)] } };
  }
  if (action.type === "toggle-path") {
    const index = state.branch.path.findIndex((entry) => entry.pathKey === action.pathKey);
    if (index < 0 || index === state.branch.path.length - 1) return state;
    return {
      ...state,
      branch: { ...state.branch, path: state.branch.path.slice(0, index + 1) },
    };
  }
  const branch = deriveFullGraphBranch(model, state.branch);
  const candidate = branch.levels
    .flatMap((level) => level.groups.flatMap((group) => group.candidates))
    .find((item) => item.key === action.candidateKey);
  if (!candidate?.canFollow || !candidate.neighbor) return state;
  const parentIndex = state.branch.path.findIndex((entry) => entry.pathKey === candidate.parentPathKey);
  if (parentIndex < 0) return state;
  const parent = state.branch.path[parentIndex]!;
  return {
    ...state,
    branch: {
      ...state.branch,
      path: [...state.branch.path.slice(0, parentIndex + 1), childPathEntry(parent, candidate)],
    },
  };
}

function normalizedFilter(filter: string | FullGraphInventoryFilter): FullGraphInventoryFilter {
  return typeof filter === "string" ? { text: filter } : filter;
}

export function filterFullGraphInventory(
  model: FullGraphViewModel,
  filter: string | FullGraphInventoryFilter,
): FullGraphInventory {
  const input = normalizedFilter(filter);
  const text = normalizeSearchText(input.text ?? "");
  const kinds = new Set((input.kinds ?? []).map(normalizeSearchText));
  const categories = new Set(input.categories ?? []);
  const relationshipKinds = new Set((input.relationshipKinds ?? []).map(normalizeSearchText));
  const nodes = model.inventory.nodes.filter((item) => {
    if (kinds.size > 0 && !kinds.has(normalizeSearchText(item.kind)) && !kinds.has(normalizeSearchText(item.kindLabel))) return false;
    if (categories.size > 0 && !categories.has(item.category)) return false;
    if (!text) return true;
    return [item.label, item.kind, item.kindLabel, item.category, item.categoryLabel]
      .some((value) => normalizeSearchText(value).includes(text));
  });
  const relationships = model.inventory.relationships.filter((item) => {
    if (relationshipKinds.size > 0
      && !relationshipKinds.has(normalizeSearchText(item.kind))
      && !relationshipKinds.has(normalizeSearchText(item.kindLabel))) return false;
    if (kinds.size > 0) {
      const endpointKinds = [item.from?.kind, item.to?.kind, item.from?.kindLabel, item.to?.kindLabel]
        .filter((value): value is string => Boolean(value))
        .map(normalizeSearchText);
      if (!endpointKinds.some((value) => kinds.has(value))) return false;
    }
    if (categories.size > 0 && ![item.from?.category, item.to?.category].some((category) => category && categories.has(category))) return false;
    if (!text) return true;
    return [item.kind, item.kindLabel, item.fromLabel, item.toLabel, item.from?.categoryLabel, item.to?.categoryLabel]
      .filter((value): value is string => Boolean(value))
      .some((value) => normalizeSearchText(value).includes(text));
  });
  return {
    nodes,
    relationships,
    counts: model.inventory.counts,
    isComplete: model.inventory.isComplete,
  };
}

export function nodeAccessibilityName(node: FullGraphNode | FullGraphNodeDescriptor): string {
  if ("accessibilityName" in node) return node.accessibilityName;
  const kindLabel = humanizeGraphKind(node.kind, "node");
  const label = node.label.trim() || `${kindLabel} (unnamed)`;
  return `${label} · ${kindLabel}`;
}
