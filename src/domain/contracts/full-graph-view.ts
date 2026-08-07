import type {
  AuthorizedMemberContextScope,
  MemberContextReadProvider,
} from "./member-context-queries";
import type {
  AssertionClassification,
  AssertionTemporal,
  MemberContextAuthority,
  MemberContextGraphNode,
  MemberContextGraphSnapshot,
  MemberContextNodeKind,
} from "./member-context";
import type {
  GraphAuthority,
  MovementGraphEdgeAssertion,
  MovementGraphNodeAssertion,
  MovementGraphSnapshot,
  MovementNodeKind,
} from "./movement-graph";
import type { MovementGraphReadProvider } from "./movement-clinical-queries";

export const FULL_GRAPH_DOMAINS = ["movement-clinical", "member-context"] as const;
export type FullGraphDomain = (typeof FULL_GRAPH_DOMAINS)[number];
export type FullGraphAuthority = GraphAuthority | MemberContextAuthority;
export type FullGraphNodeKind = MovementNodeKind | MemberContextNodeKind;

export type FullGraphDetailValue = string | number | boolean | null;

export type FullGraphDetailField = {
  readonly key: string;
  readonly value: FullGraphDetailValue;
};

export type FullGraphProvenance = {
  readonly directAssertion: "present" | "none";
  readonly assertionId?: string;
  readonly source?: {
    readonly sourceId?: string;
    readonly sourceRevision?: string;
    readonly sourceRecordId?: string;
    readonly locator?: string;
    readonly artifactDigest?: string;
  };
  readonly classification?: AssertionClassification;
  readonly temporal?: AssertionTemporal;
  readonly lineageIds: readonly string[];
};

export type FullGraphNode = {
  readonly id: string;
  readonly kind: FullGraphNodeKind;
  readonly label: string;
  readonly category: "domain" | "identity" | "lineage" | "publication";
  readonly revisionId: string;
  readonly detail: readonly FullGraphDetailField[];
  readonly provenance: FullGraphProvenance;
};

export type FullGraphRelationship = {
  readonly id: string;
  readonly kind: string;
  readonly fromId: string;
  readonly toId: string;
  readonly revisionId: string;
  readonly detail: readonly FullGraphDetailField[];
  readonly provenance: FullGraphProvenance;
};

export type FullGraphProjection = {
  readonly domain: FullGraphDomain;
  readonly revisionId: string;
  readonly memberId?: string;
  readonly sourceArtifactDigest?: string;
  readonly authority: FullGraphAuthority;
  readonly counts: {
    readonly nodes: number;
    readonly relationships: number;
  };
  readonly nodes: readonly FullGraphNode[];
  readonly relationships: readonly FullGraphRelationship[];
};

export type FullGraphReadResult =
  | { readonly status: "ready"; readonly data: FullGraphProjection }
  | { readonly status: "empty"; readonly domain: FullGraphDomain; readonly message: string }
  | {
      readonly status: "stale";
      readonly domain: FullGraphDomain;
      readonly requestedRevisionId: string;
      readonly activeRevisionId: string | null;
    }
  | { readonly status: "denied"; readonly domain: FullGraphDomain; readonly message: string }
  | { readonly status: "invalid"; readonly domain: FullGraphDomain; readonly message: string }
  | { readonly status: "unavailable"; readonly domain: FullGraphDomain; readonly message: string };

export type MovementGraphFullReadProvider = MovementGraphReadProvider & {
  readonly readFullActive: () => Promise<FullGraphReadResult>;
  readonly readFullRevision: (revisionId: string) => Promise<FullGraphReadResult>;
};

export type MemberContextFullReadProvider = MemberContextReadProvider & {
  readonly readFullActive: (scope: AuthorizedMemberContextScope) => Promise<FullGraphReadResult>;
  readonly readFullRevision: (
    scope: AuthorizedMemberContextScope,
    contextRevisionId: string,
  ) => Promise<FullGraphReadResult>;
};

export class FullGraphProjectionError extends Error {
  constructor(readonly code: "duplicate-node" | "duplicate-relationship" | "dangling-relationship" | "mixed-revision" | "invalid-snapshot") {
    super(`Full graph projection is invalid: ${code}`);
    this.name = "FullGraphProjectionError";
  }
}

const primitiveDetail = (record: Record<string, unknown>): readonly FullGraphDetailField[] => Object.entries(record)
  .filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value))
  .filter(([key]) => !["memberId", "contextRevisionId", "graphRevisionId", "source", "assertionId"].includes(key))
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([key, value]) => ({ key, value: value as FullGraphDetailValue }));

const movementCategory = (kind: MovementNodeKind): FullGraphNode["category"] => (
  kind === "graph-revision" || kind === "ingestion-activity" ? "lineage" : "domain"
);

const movementProvenance = (assertion: MovementGraphNodeAssertion | MovementGraphEdgeAssertion): FullGraphProvenance => ({
  directAssertion: "present",
  assertionId: assertion.assertionId,
  source: {
    sourceId: assertion.source.sourceId,
    sourceRevision: assertion.source.sourceRevision,
    ...(assertion.source.sourceRecordId ? { sourceRecordId: assertion.source.sourceRecordId } : {}),
  },
  lineageIds: [],
});

function assertMovementIntegrity(snapshot: MovementGraphSnapshot): void {
  const nodeIds = new Set<string>();
  const relationshipIds = new Set<string>();
  for (const node of snapshot.nodes) {
    if (node.graphRevisionId !== snapshot.graphRevisionId) throw new FullGraphProjectionError("mixed-revision");
    if (nodeIds.has(node.conceptId)) throw new FullGraphProjectionError("duplicate-node");
    nodeIds.add(node.conceptId);
  }
  for (const edge of snapshot.edges) {
    if (edge.graphRevisionId !== snapshot.graphRevisionId) throw new FullGraphProjectionError("mixed-revision");
    if (!nodeIds.has(edge.fromConceptId) || !nodeIds.has(edge.toConceptId)) throw new FullGraphProjectionError("dangling-relationship");
    if (relationshipIds.has(edge.assertionId)) throw new FullGraphProjectionError("duplicate-relationship");
    relationshipIds.add(edge.assertionId);
  }
}

export function projectMovementGraphSnapshot(
  snapshot: MovementGraphSnapshot,
  authority: GraphAuthority,
): FullGraphProjection {
  assertMovementIntegrity(snapshot);
  const nodes = [...snapshot.nodes]
    .sort((left, right) => left.assertionId.localeCompare(right.assertionId))
    .map((node): FullGraphNode => ({
      id: node.conceptId,
      kind: node.kind,
      label: node.label,
      category: movementCategory(node.kind),
      revisionId: snapshot.graphRevisionId,
      detail: primitiveDetail(node as unknown as Record<string, unknown>),
      provenance: movementProvenance(node),
    }));
  const relationships = [...snapshot.edges]
    .sort((left, right) => left.assertionId.localeCompare(right.assertionId))
    .map((edge): FullGraphRelationship => ({
      id: edge.assertionId,
      kind: edge.kind,
      fromId: edge.fromConceptId,
      toId: edge.toConceptId,
      revisionId: snapshot.graphRevisionId,
      detail: primitiveDetail(edge as unknown as Record<string, unknown>),
      provenance: movementProvenance(edge),
    }));
  return {
    domain: "movement-clinical",
    revisionId: snapshot.graphRevisionId,
    authority,
    counts: { nodes: nodes.length, relationships: relationships.length },
    nodes,
    relationships,
  };
}

const memberCategory = (kind: MemberContextNodeKind): FullGraphNode["category"] => {
  if (kind === "member" || kind === "coach") return "identity";
  if (["source-artifact", "member-context-revision", "ingestion-activity"].includes(kind)) return "lineage";
  if (["publication-attempt", "revision-seal", "member-context-catalog", "activation-event"].includes(kind)) return "publication";
  return "domain";
};

const memberLabel = (node: MemberContextGraphNode): string => {
  if ("name" in node) return node.name;
  if ("text" in node) return node.text;
  if ("originalLabel" in node) return node.originalLabel;
  if ("originalText" in node) return node.originalText;
  if ("title" in node) return node.title;
  if ("label" in node) return node.label;
  if ("level" in node) return `Churn risk: ${node.level}`;
  if ("sourceLocator" in node) return node.sourceLocator;
  if ("contextRevisionId" in node) return node.contextRevisionId;
  return node.semanticId;
};

const memberProvenance = (node: MemberContextGraphNode): FullGraphProvenance => {
  if ("assertionId" in node) {
    return {
      directAssertion: "present",
      assertionId: node.assertionId,
      source: { locator: node.source.locator, artifactDigest: node.source.artifactDigest },
      classification: node.classification,
      temporal: node.temporal,
      lineageIds: [],
    };
  }
  const artifactDigest = "artifactDigest" in node ? node.artifactDigest : "canonicalDigest" in node ? node.canonicalDigest : undefined;
  const locator = "sourceLocator" in node ? node.sourceLocator : undefined;
  return {
    directAssertion: "none",
    ...(artifactDigest || locator ? { source: { ...(artifactDigest ? { artifactDigest } : {}), ...(locator ? { locator } : {}) } } : {}),
    lineageIds: [],
  };
};

function assertMemberIntegrity(snapshot: MemberContextGraphSnapshot): void {
  const nodeIds = new Set<string>();
  const relationshipIds = new Set<string>();
  for (const node of snapshot.nodes) {
    if ("contextRevisionId" in node && node.contextRevisionId !== snapshot.contextRevisionId) throw new FullGraphProjectionError("mixed-revision");
    if (nodeIds.has(node.semanticId)) throw new FullGraphProjectionError("duplicate-node");
    nodeIds.add(node.semanticId);
  }
  for (const relationship of snapshot.relationships) {
    if (relationship.contextRevisionId !== snapshot.contextRevisionId) throw new FullGraphProjectionError("mixed-revision");
    if (!nodeIds.has(relationship.fromSemanticId) || !nodeIds.has(relationship.toSemanticId)) throw new FullGraphProjectionError("dangling-relationship");
    if (relationshipIds.has(relationship.assertionId)) throw new FullGraphProjectionError("duplicate-relationship");
    relationshipIds.add(relationship.assertionId);
  }
}

export function projectMemberContextGraphSnapshot(
  snapshot: MemberContextGraphSnapshot,
  authority: MemberContextAuthority,
): FullGraphProjection {
  assertMemberIntegrity(snapshot);
  const nodes = [...snapshot.nodes]
    .sort((left, right) => left.semanticId.localeCompare(right.semanticId))
    .map((node): FullGraphNode => ({
      id: node.semanticId,
      kind: node.kind,
      label: memberLabel(node),
      category: memberCategory(node.kind),
      revisionId: snapshot.contextRevisionId,
      detail: primitiveDetail(node as unknown as Record<string, unknown>),
      provenance: memberProvenance(node),
    }));
  const relationships = [...snapshot.relationships]
    .sort((left, right) => left.assertionId.localeCompare(right.assertionId))
    .map((relationship): FullGraphRelationship => ({
      id: relationship.assertionId,
      kind: relationship.kind,
      fromId: relationship.fromSemanticId,
      toId: relationship.toSemanticId,
      revisionId: snapshot.contextRevisionId,
      detail: primitiveDetail(relationship as unknown as Record<string, unknown>),
      provenance: {
        directAssertion: "present",
        assertionId: relationship.assertionId,
        source: { locator: relationship.source.locator, artifactDigest: relationship.source.artifactDigest },
        classification: relationship.classification,
        temporal: relationship.temporal,
        lineageIds: [],
      },
    }));
  return {
    domain: "member-context",
    revisionId: snapshot.contextRevisionId,
    memberId: snapshot.memberId,
    sourceArtifactDigest: snapshot.sourceArtifactDigest,
    authority,
    counts: { nodes: nodes.length, relationships: relationships.length },
    nodes,
    relationships,
  };
}
