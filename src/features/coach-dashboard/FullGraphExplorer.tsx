"use client";

import { useMemo, useState } from "react";

import type {
  FullGraphDomain,
  FullGraphNode,
  FullGraphProjection,
  FullGraphReadResult,
  FullGraphRelationship,
} from "../../domain/contracts/full-graph-view";
import styles from "./full-graph-explorer.module.css";

export type GraphFocusLane = {
  readonly name: string;
  readonly text: string;
  readonly source: string;
};

export type FullGraphExplorerProps = {
  readonly domain: FullGraphDomain;
  readonly focusedLanes: readonly GraphFocusLane[];
  readonly fullGraph: FullGraphReadResult | null;
  readonly expanded: boolean;
  readonly loading?: boolean;
  readonly unavailableReason?: string;
  readonly onExpand: () => void;
  readonly onCollapse: () => void;
  readonly onRetry?: () => void;
};

export type FullGraphLayout = {
  readonly width: number;
  readonly height: number;
  readonly positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
};

const NODE_WIDTH = 156;
const NODE_HEIGHT = 70;
const COLUMN_GAP = 20;
const ROW_GAP = 28;
const PADDING = 24;

const categoryOrder: FullGraphNode["category"][] = ["domain", "identity", "lineage", "publication"];

export function layoutFullGraph(projection: FullGraphProjection): FullGraphLayout {
  const positions = new Map<string, { x: number; y: number }>();
  const columns = Math.max(4, Math.ceil(Math.sqrt(Math.max(1, projection.nodes.length))));
  const rows = Math.max(1, Math.ceil(projection.nodes.length / columns));
  const sortedNodes = [...projection.nodes].sort((left, right) => (
    categoryOrder.indexOf(left.category) - categoryOrder.indexOf(right.category)
      || left.id.localeCompare(right.id)
  ));
  sortedNodes.forEach((node, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    positions.set(node.id, {
      x: PADDING + column * (NODE_WIDTH + COLUMN_GAP),
      y: PADDING + row * (NODE_HEIGHT + ROW_GAP),
    });
  });
  return {
    width: PADDING * 2 + columns * NODE_WIDTH + Math.max(0, columns - 1) * COLUMN_GAP,
    height: PADDING * 2 + rows * NODE_HEIGHT + Math.max(0, rows - 1) * ROW_GAP,
    positions,
  };
}

function graphTitle(domain: FullGraphDomain): string {
  return domain === "movement-clinical" ? "Movement knowledge graph" : "Member context graph";
}

function graphKicker(domain: FullGraphDomain): string {
  return domain === "movement-clinical" ? "MOVEMENT + CLINICAL · READ ONLY" : "MEMBER CONTEXT · READ ONLY";
}

function selectedEntity(
  projection: FullGraphProjection,
  selectedId: string | null,
): { readonly kind: "node" | "relationship"; readonly value: FullGraphNode | FullGraphRelationship } | null {
  if (!selectedId) return null;
  const node = projection.nodes.find((candidate) => candidate.id === selectedId);
  if (node) return { kind: "node", value: node };
  const relationship = projection.relationships.find((candidate) => candidate.id === selectedId);
  return relationship ? { kind: "relationship", value: relationship } : null;
}

function provenanceRows(entity: FullGraphNode | FullGraphRelationship): readonly { readonly label: string; readonly value: string }[] {
  const source = entity.provenance.source;
  const temporal = entity.provenance.temporal;
  return [
    { label: "Assertion", value: entity.provenance.directAssertion === "present" ? entity.provenance.assertionId ?? "present" : "none · identity or lineage node" },
    ...(source?.sourceId ? [{ label: "Source", value: source.sourceId }] : []),
    ...(source?.sourceRevision ? [{ label: "Source revision", value: source.sourceRevision }] : []),
    ...(source?.sourceRecordId ? [{ label: "Source record", value: source.sourceRecordId }] : []),
    ...(source?.locator ? [{ label: "Locator", value: source.locator }] : []),
    ...(source?.artifactDigest ? [{ label: "Artifact digest", value: source.artifactDigest }] : []),
    ...(entity.provenance.classification ? [{ label: "Classification", value: entity.provenance.classification }] : []),
    ...(temporal?.precision ? [{ label: "Temporal precision", value: temporal.precision }] : []),
    ...(temporal && "effectiveAt" in temporal ? [{ label: "Effective at", value: temporal.effectiveAt }] : []),
    ...(temporal && "effectiveOn" in temporal ? [{ label: "Effective on", value: temporal.effectiveOn }] : []),
    ...(temporal && "sourceOrder" in temporal ? [{ label: "Source order", value: String(temporal.sourceOrder) }] : []),
    ...(entity.provenance.lineageIds.length > 0 ? [{ label: "Lineage", value: entity.provenance.lineageIds.join(" · ") }] : []),
  ];
}

function EntityDetail({ entity, kind }: { entity: FullGraphNode | FullGraphRelationship; kind: "node" | "relationship" }) {
  return (
    <section className={styles.detailPanel} aria-label="Source and provenance details">
      <div className={styles.detailKicker}>{kind === "node" ? "SELECTED NODE" : "SELECTED RELATIONSHIP"}</div>
      <h3 className={styles.detailTitle}>{"label" in entity ? entity.label : entity.kind}</h3>
      <div className={styles.detailId}>{entity.id}</div>
      <dl className={styles.detailList}>
        <div><dt>Kind</dt><dd>{entity.kind}</dd></div>
        <div><dt>Revision</dt><dd>{entity.revisionId}</dd></div>
        {"fromId" in entity && <div><dt>From</dt><dd>{entity.fromId}</dd></div>}
        {"toId" in entity && <div><dt>To</dt><dd>{entity.toId}</dd></div>}
        {entity.detail.map((field) => <div key={field.key}><dt>{field.key}</dt><dd>{field.value === null ? "—" : String(field.value)}</dd></div>)}
        {provenanceRows(entity).map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
      </dl>
    </section>
  );
}

function GraphCanvas({ projection, selectedId, onSelect }: {
  readonly projection: FullGraphProjection;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  const layout = useMemo(() => layoutFullGraph(projection), [projection]);
  const nodeById = useMemo(() => new Map(projection.nodes.map((node) => [node.id, node])), [projection.nodes]);
  return (
    <div className={styles.canvasViewport} role="region" aria-label={`${graphTitle(projection.domain)} complete graph`}>
      <div className={styles.canvas} style={{ width: layout.width, height: layout.height }}>
        <svg className={styles.edges} width={layout.width} height={layout.height} aria-hidden="true">
          {projection.relationships.map((relationship) => {
            const from = layout.positions.get(relationship.fromId);
            const to = layout.positions.get(relationship.toId);
            if (!from || !to) return null;
            return <line key={relationship.id} x1={from.x + NODE_WIDTH / 2} y1={from.y + NODE_HEIGHT / 2} x2={to.x + NODE_WIDTH / 2} y2={to.y + NODE_HEIGHT / 2} className={styles.edge} />;
          })}
        </svg>
        <div className={styles.nodes}>
          {projection.nodes.map((node) => {
            const position = layout.positions.get(node.id);
            if (!position) return null;
            return (
              <button
                className={`${styles.node} ${selectedId === node.id ? styles.nodeSelected : ""}`}
                data-focus-key={`full-graph-node-${node.id}`}
                key={node.id}
                style={{ left: position.x, top: position.y, width: NODE_WIDTH, minHeight: NODE_HEIGHT }}
                type="button"
                aria-pressed={selectedId === node.id}
                aria-label={`${node.label}, ${node.kind}`}
                onClick={() => onSelect(node.id)}
              >
                <span className={styles.nodeKind}>{node.kind}</span>
                <span className={styles.nodeLabel}>{node.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className={styles.relationships} aria-label="Graph relationships">
        <div className={styles.relationshipHeading}>RELATIONSHIPS · {projection.relationships.length}</div>
        {projection.relationships.map((relationship) => {
          const from = nodeById.get(relationship.fromId)?.label ?? relationship.fromId;
          const to = nodeById.get(relationship.toId)?.label ?? relationship.toId;
          return <button className={`${styles.relationship} ${selectedId === relationship.id ? styles.relationshipSelected : ""}`} key={relationship.id} type="button" aria-pressed={selectedId === relationship.id} onClick={() => onSelect(relationship.id)}><span>{from}</span><strong>{relationship.kind}</strong><span>{to}</span></button>;
        })}
      </div>
    </div>
  );
}

export function FullGraphExplorer({
  domain,
  focusedLanes,
  fullGraph,
  expanded,
  loading = false,
  unavailableReason,
  onExpand,
  onCollapse,
  onRetry,
}: FullGraphExplorerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const projection = fullGraph?.status === "ready" ? fullGraph.data : null;
  const selected = projection ? selectedEntity(projection, selectedId) : null;
  const effectiveSelectedId = selected ? selectedId : null;

  return (
    <section className={styles.explorer} aria-label={graphTitle(domain)}>
      <div className={styles.explorerHeader}>
        <div>
          <div className={styles.kicker}>{graphKicker(domain)}</div>
          <h2 className={styles.title}>{graphTitle(domain)}</h2>
        </div>
        <div className={styles.headerActions}>
          {expanded
            ? <button className={styles.secondaryButton} type="button" onClick={onCollapse}>← Focused view</button>
            : <button className={styles.primaryButton} type="button" onClick={onExpand} disabled={loading || Boolean(unavailableReason)}>{loading ? "Loading graph…" : "Show full graph"}</button>}
        </div>
      </div>
      {!expanded && <div className={styles.focusedView}>
        {focusedLanes.map((lane) => <div className={styles.focusLane} key={lane.name}><div className={styles.laneName}>{lane.name}</div><div className={styles.laneText}>{lane.text}</div><div className={styles.laneSource}>{lane.source}</div></div>)}
        {unavailableReason && <div className={styles.capabilityNote} role="status">{unavailableReason}</div>}
      </div>}
      {expanded && loading && <div className={styles.loadingPanel} role="status" aria-busy="true">Loading the complete, revision-pinned graph…</div>}
      {expanded && !loading && fullGraph && fullGraph.status !== "ready" && (
        <div className={styles.loadingPanel} role="status">
          <strong>{fullGraph.status === "stale" ? "This graph revision is no longer active." : "Full graph unavailable."}</strong>
          {fullGraph.status === "stale" && <span>Return to the focused view, then try again for the active revision.</span>}
          {fullGraph.status !== "stale" && <span>{fullGraph.message}</span>}
          {onRetry && <button className={styles.secondaryButton} type="button" onClick={onRetry}>Try again</button>}
        </div>
      )}
      {expanded && projection && <>
        <div className={styles.graphMeta}><span>{projection.counts.nodes} nodes</span><span>{projection.counts.relationships} relationships</span><span>{projection.authority} · {projection.revisionId}</span></div>
        <GraphCanvas projection={projection} selectedId={effectiveSelectedId} onSelect={setSelectedId} />
        {selected ? <EntityDetail entity={selected.value} kind={selected.kind} /> : <div className={styles.emptyDetail}>Select a node or relationship to inspect its source and provenance.</div>}
      </>}
    </section>
  );
}
