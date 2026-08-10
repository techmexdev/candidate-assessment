"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type {
  FullGraphDomain,
  FullGraphReadResult,
} from "../../domain/contracts/full-graph-view";
import { FullGraphRelationshipMap } from "./FullGraphRelationshipMap";
import {
  buildFullGraphViewModel,
  createFullGraphInteractionState,
  deriveFullGraphBranch,
  filterFullGraphInventory,
  transitionFullGraphInteraction,
  type FullGraphInteractionState,
  type FullGraphNodeDescriptor,
  type FullGraphRelationshipDescriptor,
  type FullGraphViewModel,
} from "./full-graph-view-model";
import styles from "./full-graph-explorer.module.css";

export type GraphFocusLane = {
  readonly name: string;
  readonly text: string;
  readonly source: string;
};

export type GraphInspectionRequest = {
  readonly entityId: string;
  readonly entityKind: "node" | "relationship";
  readonly revisionId: string;
};

export type GraphInspectionOutcome = "refreshed" | "unchanged" | "failed";

export type FullGraphExplorerProps = {
  readonly domain: FullGraphDomain;
  readonly focusedLanes: readonly GraphFocusLane[];
  readonly fullGraph: FullGraphReadResult | null;
  readonly expanded: boolean;
  readonly loading?: boolean;
  readonly unavailableReason?: string;
  readonly initialNodeId?: string;
  readonly onExpand: () => void;
  readonly onCollapse: () => void;
  readonly onRetry?: () => void;
  readonly onInspect?: (input: GraphInspectionRequest) => Promise<GraphInspectionOutcome>;
};

type SelectedEntity =
  | { readonly kind: "node"; readonly value: FullGraphNodeDescriptor }
  | { readonly kind: "relationship"; readonly value: FullGraphRelationshipDescriptor };

function graphTitle(domain: FullGraphDomain): string {
  return domain === "movement-clinical" ? "Movement knowledge graph" : "Member context graph";
}

function graphKicker(domain: FullGraphDomain): string {
  return domain === "movement-clinical" ? "MOVEMENT + CLINICAL · READ ONLY" : "MEMBER CONTEXT · READ ONLY";
}

function capitalize(value: string): string {
  return value ? `${value[0]!.toLocaleUpperCase()}${value.slice(1)}` : value;
}

function selectedEntity(model: FullGraphViewModel, state: FullGraphInteractionState | null): SelectedEntity | null {
  const selection = state?.selection;
  if (!selection) return null;
  if (selection.entityKind === "node") {
    const node = model.nodeById.get(selection.entityId);
    return node ? { kind: "node", value: node } : null;
  }
  const relationship = model.relationshipById.get(selection.entityId);
  return relationship ? { kind: "relationship", value: relationship } : null;
}

function initializeInteraction(model: FullGraphViewModel, generation: number): FullGraphInteractionState {
  let state = createFullGraphInteractionState(model, generation);
  if (state.branch.path.length === 0 && model.focusedAnchor) {
    state = transitionFullGraphInteraction(model, state, { type: "set-root", nodeId: model.focusedAnchor.key });
  }
  return state;
}

function countCopy(loaded: number, total: number | null, unit: string): string {
  if (total === null) return `${loaded} loaded · total unavailable ${unit}`;
  return `${loaded} loaded of ${total} total ${unit}`;
}

function technicalValue(value: string | undefined): string {
  return value?.trim() ? value : "Unavailable";
}

function EntityDetail({
  entity,
  model,
  projectionDigest,
  onRefresh,
  refreshStatus,
}: {
  readonly entity: SelectedEntity;
  readonly model: FullGraphViewModel;
  readonly projectionDigest?: string;
  readonly onRefresh?: () => void;
  readonly refreshStatus?: string;
}) {
  const item = entity.value;
  const source = item.provenance.source;
  const relationship = entity.kind === "relationship" ? entity.value : null;
  const title = entity.kind === "node" ? entity.value.label : capitalize(entity.value.kindLabel);
  const kindLabel = entity.kind === "node" ? entity.value.kindLabel : "Relationship";
  const digest = source?.artifactDigest ?? projectionDigest;
  return (
    <section className={styles.detailPanel} aria-label="Source and provenance details">
      <div className={styles.detailKicker}>{entity.kind === "node" ? "SELECTED NODE" : "SELECTED RELATIONSHIP"}</div>
      <h3 className={styles.detailTitle}>{title}</h3>
      <dl className={styles.detailList}>
        <div><dt>Kind</dt><dd>{kindLabel}</dd></div>
        {entity.kind === "node" ? <>
          <div><dt>Category</dt><dd>{entity.value.categoryLabel}</dd></div>
          <div><dt>Connections</dt><dd>{entity.value.relationshipCount} {entity.value.relationshipCount === 1 ? "relationship" : "relationships"}</dd></div>
        </> : relationship && <div><dt>Direction</dt><dd>{relationship.fromLabel} → {relationship.kindLabel} → {relationship.toLabel}</dd></div>}
        <div><dt>Graph context</dt><dd>Pinned to the loaded graph revision</dd></div>
        <div><dt>Authority</dt><dd>{capitalize(model.inventory.isComplete ? "canonical graph projection" : "loaded graph projection")}</dd></div>
        <div><dt>Source status</dt><dd>{item.provenance.directAssertion === "present" ? "Source-backed assertion" : "Identity or lineage record"}</dd></div>
      </dl>
      <details className={styles.technicalDisclosure}>
        <summary>Technical reference</summary>
        <dl className={styles.detailList}>
          <div><dt>Entity reference</dt><dd>{technicalValue(item.key)}</dd></div>
          <div><dt>Assertion ID</dt><dd>{technicalValue(item.provenance.assertionId)}</dd></div>
          <div><dt>Pinned revision</dt><dd>{technicalValue(item.revisionId)}</dd></div>
          <div><dt>Source ID</dt><dd>{technicalValue(source?.sourceId)}</dd></div>
          <div><dt>Source record</dt><dd>{technicalValue(source?.sourceRecordId)}</dd></div>
          <div><dt>Source locator</dt><dd>{technicalValue(source?.locator)}</dd></div>
          <div><dt>Digest</dt><dd>{technicalValue(digest)}</dd></div>
        </dl>
        {onRefresh && <>
          <button className={styles.secondaryButton} type="button" onClick={onRefresh}>Refresh technical reference</button>
          {refreshStatus && <div role="status" aria-live="polite">{refreshStatus}</div>}
        </>}
      </details>
    </section>
  );
}

function EntrySurface({ model, onRoot }: { readonly model: FullGraphViewModel; readonly onRoot: (nodeId: string) => void }) {
  return (
    <section className={styles.entrySurface} aria-label="Choose a graph starting point">
      <div className={styles.surfaceHeader}>
        <div>
          <div className={styles.relationshipHeading}>STARTING POINT</div>
          <h3 className={styles.surfaceTitle}>Select a node to follow connections.</h3>
        </div>
      </div>
      <p className={styles.overviewNote}>Suggested nodes are ranked by their loaded relationships. No arbitrary Movement root is chosen.</p>
      <div className={styles.suggestions} aria-label="Suggested starting nodes">
        {model.suggestedRoots.map((node) => (
          <button className={styles.suggestionButton} type="button" key={node.key} aria-label={`Start with ${node.accessibilityName}`} onClick={() => onRoot(node.key)}>
            <span className={styles.nodeKind}>{node.kindLabel}</span>
            <strong>{node.label}</strong>
            <small>{node.relationshipCount} {node.relationshipCount === 1 ? "relationship" : "relationships"}</small>
          </button>
        ))}
      </div>
      <div className={styles.entryGroups}>
        {model.entryGroups.map((group) => (
          <section className={styles.entryGroup} key={group.category} aria-label={`${group.categoryLabel} nodes`}>
            <h4>{group.categoryLabel} · {group.nodeCount}</h4>
            {group.kindGroups.map((kindGroup) => (
              <div className={styles.entryKind} key={kindGroup.kind}>
                <strong>{kindGroup.kindLabel}</strong>
                <span>{kindGroup.nodeCount} {kindGroup.nodeCount === 1 ? "node" : "nodes"}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </section>
  );
}

function GraphInventory({
  model,
  canRoot,
  onRoot,
  onRelationship,
}: {
  readonly model: FullGraphViewModel;
  readonly canRoot: boolean;
  readonly onRoot: (nodeId: string) => void;
  readonly onRelationship: (relationshipId: string, fromId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => filterFullGraphInventory(model, filter), [filter, model]);
  return (
    <section className={styles.inventory} aria-label="Complete graph inventory">
      <div className={styles.surfaceHeader}>
        <div>
          <div className={styles.relationshipHeading}>{model.inventory.isComplete ? "COMPLETE INVENTORY" : "LOADED INVENTORY"}</div>
          <h3 className={styles.surfaceTitle}>Every loaded node and relationship</h3>
        </div>
        <span className={styles.focusCount}>{model.inventory.nodes.length} nodes · {model.inventory.relationships.length} relationships</span>
      </div>
      <p className={styles.inventoryNote}>This inventory remains the authoritative route to every record in the loaded projection. Filtering does not change the active branch.</p>
      <button className={styles.secondaryButton} type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>{open ? "Close complete inventory" : "Open complete inventory"}</button>
      {open && <div className={styles.inventoryBody}>
        <label className={styles.filterLabel}>
          <span>Filter loaded graph inventory</span>
          <input type="search" value={filter} onChange={(event) => setFilter(event.currentTarget.value)} />
        </label>
        <div className={styles.filterCounts} role="status">{filtered.nodes.length} matching {filtered.nodes.length === 1 ? "node" : "nodes"} · {filtered.relationships.length} matching {filtered.relationships.length === 1 ? "relationship" : "relationships"}</div>
        <ul className={styles.inventoryList} aria-label="Filtered nodes">
          {filtered.nodes.map((node) => <li key={node.key}>
            <button type="button" disabled={!canRoot} aria-label={`Use ${node.label} as branch root`} onClick={() => onRoot(node.key)}>
              <strong>{node.label}</strong><span>{node.kindLabel} · {node.relationshipCount} {node.relationshipCount === 1 ? "relationship" : "relationships"}</span>
            </button>
          </li>)}
        </ul>
        <ul className={styles.inventoryList} aria-label="Filtered relationships">
          {filtered.relationships.map((relationship) => <li key={relationship.key}>
            <button type="button" disabled={!canRoot} aria-label={`Inspect ${relationship.storedDirectionLabel}`} onClick={() => onRelationship(relationship.key, relationship.fromId)}>
              <strong>{relationship.storedDirectionLabel}</strong><span>{relationship.kindLabel}</span>
            </button>
          </li>)}
        </ul>
      </div>}
    </section>
  );
}

export function FullGraphExplorer({
  domain,
  focusedLanes,
  fullGraph,
  expanded,
  loading = false,
  unavailableReason,
  initialNodeId,
  onExpand,
  onCollapse,
  onRetry,
  onInspect,
}: FullGraphExplorerProps) {
  const focusedTriggerRef = useRef<HTMLButtonElement>(null);
  const generationRef = useRef(0);
  const focusToken = useRef(0);
  const interactionSignatureRef = useRef<string | null>(null);
  const [interaction, setInteraction] = useState<FullGraphInteractionState | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ readonly nodeId: string; readonly token: number } | null>(null);
  const [refreshStatus, setRefreshStatus] = useState<{ readonly entityKey: string; readonly text: string } | null>(null);
  const projection = fullGraph?.status === "ready" ? fullGraph.data : null;
  const model = useMemo(() => projection ? buildFullGraphViewModel(projection, {
    loading,
    initialNodeId,
    operation: `explore:${domain}`,
  }) : null, [domain, initialNodeId, loading, projection]);
  const interactionSignature = model ? `${model.context.key}|follow:${model.completeness.canFollow}` : "unavailable";

  useEffect(() => {
    if (interactionSignatureRef.current === interactionSignature) return;
    interactionSignatureRef.current = interactionSignature;
    generationRef.current += 1;
    setInteraction(model ? initializeInteraction(model, generationRef.current) : null);
    setFocusRequest(null);
  }, [interactionSignature, model]);

  const currentInteraction = model && interaction?.contextKey === model.context.key ? interaction : null;
  const branch = model && currentInteraction ? deriveFullGraphBranch(model, currentInteraction.branch) : null;
  const selected = model ? selectedEntity(model, currentInteraction) : null;

  const update = (action: Parameters<typeof transitionFullGraphInteraction>[2]) => {
    if (!model) return;
    setInteraction((current) => transitionFullGraphInteraction(model, current ?? initializeInteraction(model, generationRef.current), action));
  };
  const selectNode = (nodeId: string) => update({ type: "select", entityKind: "node", entityId: nodeId });
  const selectRelationship = (relationshipId: string) => update({ type: "select", entityKind: "relationship", entityId: relationshipId });
  const requestNodeFocus = (nodeId: string) => setFocusRequest({ nodeId, token: ++focusToken.current });
  const rootAt = (nodeId: string) => {
    if (!model) return;
    setInteraction((current) => {
      let next = transitionFullGraphInteraction(model, current ?? initializeInteraction(model, generationRef.current), { type: "set-root", nodeId });
      next = transitionFullGraphInteraction(model, next, { type: "select", entityKind: "node", entityId: nodeId });
      return next;
    });
    requestNodeFocus(nodeId);
  };

  const collapse = () => {
    generationRef.current += 1;
    setInteraction(null);
    onCollapse();
    requestAnimationFrame(() => focusedTriggerRef.current?.focus());
  };

  const refreshDetail = selected && projection && onInspect ? () => {
    const contextKey = model?.context.key;
    const generation = generationRef.current;
    const entityKey = selected.value.key;
    setRefreshStatus({ entityKey, text: "Refreshing technical reference…" });
    void onInspect({ entityId: entityKey, entityKind: selected.kind, revisionId: projection.revisionId })
      .then((outcome) => {
        if (model?.context.key !== contextKey || generationRef.current !== generation) return;
        setRefreshStatus({
          entityKey,
          text: outcome === "refreshed"
            ? "Technical reference refreshed."
            : outcome === "unchanged"
              ? "Technical reference unchanged because the graph topology changed."
              : "Technical reference refresh failed.",
        });
      })
      .catch(() => {
        if (model?.context.key !== contextKey || generationRef.current !== generation) return;
        setRefreshStatus({ entityKey, text: "Technical reference refresh failed." });
      });
  } : undefined;
  const selectedRefreshStatus = selected && refreshStatus?.entityKey === selected.value.key ? refreshStatus.text : undefined;

  const selectionAnnouncement = selected
    ? `${selected.kind === "node" ? "Node" : "Relationship"} selected: ${selected.kind === "node" ? selected.value.label : selected.value.kindLabel}. Source and provenance details updated.`
    : branch?.path.length ? `${branch.levels.at(-1)?.node.label ?? "Graph node"} is the current branch node.` : "No node or relationship selected.";

  return (
    <section className={styles.explorer} aria-label={graphTitle(domain)}>
      <div className={styles.explorerHeader}>
        <div><div className={styles.kicker}>{graphKicker(domain)}</div><h2 className={styles.title}>{graphTitle(domain)}</h2></div>
        <div className={styles.headerActions}>
          {expanded
            ? <button className={styles.secondaryButton} type="button" onClick={collapse}>← Focused view</button>
            : <button ref={focusedTriggerRef} className={styles.primaryButton} type="button" onClick={onExpand} disabled={loading || Boolean(unavailableReason)}>{loading ? "Loading graph…" : "Show full graph"}</button>}
        </div>
      </div>
      {!expanded && <div className={styles.focusedView}>
        {focusedLanes.map((lane) => <div className={styles.focusLane} key={lane.name}><div className={styles.laneName}>{lane.name}</div><div className={styles.laneText}>{lane.text}</div><div className={styles.laneSource}>{lane.source}</div></div>)}
        {unavailableReason && <div className={styles.capabilityNote} role="status">{unavailableReason}</div>}
      </div>}
      {expanded && loading && <div className={styles.loadingPanel} role="status" aria-busy="true">{projection ? "Loading more graph context…" : "Loading the first graph page…"}</div>}
      {expanded && !loading && fullGraph && fullGraph.status !== "ready" && <div className={styles.loadingPanel} role="status">
        <strong>{fullGraph.status === "stale" ? "This graph revision is no longer active." : "Full graph unavailable."}</strong>
        <span>{fullGraph.status === "stale" ? "Return to the focused view, then try again for the active revision." : fullGraph.message}</span>
        {onRetry && <button className={styles.secondaryButton} type="button" onClick={onRetry}>Try again</button>}
      </div>}
      {expanded && projection && model && <section className={styles.completeGraph} role="region" aria-label={`${graphTitle(projection.domain)} complete graph`}>
        <div className={styles.graphMeta}>
          <span>{countCopy(model.inventory.counts.nodes.loaded, model.inventory.counts.nodes.total, "nodes")}</span>
          <span>{countCopy(model.inventory.counts.relationships.loaded, model.inventory.counts.relationships.total, "relationships")}</span>
          <span>{capitalize(projection.authority)} authority · revision pinned</span>
        </div>
        <div className={styles.selectionStatus} role="status" aria-live="polite">{selectionAnnouncement}</div>
        {!model.completeness.canFollow && <div className={styles.partialNotice} role="status">Branch controls stay unavailable until the revision-pinned projection finishes loading.</div>}
        {model.status === "empty" && <div className={styles.emptyDetail}>This revision contains no graph records.</div>}
        {model.status === "invalid" && <div className={styles.emptyDetail}>The loaded graph cannot be followed because its projection is incomplete or invalid.</div>}
        {model.completeness.canFollow && branch && branch.path.length === 0 && <EntrySurface model={model} onRoot={rootAt} />}
        {model.completeness.canFollow && branch && branch.path.length > 0 && <>
          <div className={styles.mapActions}><button className={styles.secondaryButton} type="button" onClick={() => setInteraction(initializeInteraction(model, generationRef.current))}>Reset relationship map</button></div>
          <FullGraphRelationshipMap
            key={model.context.key}
            hasRelationships={branch.levels.at(-1)?.groups.some((group) => group.candidates.length > 0) ?? false}
            branch={branch}
            selection={currentInteraction?.selection ?? null}
            focusRequest={focusRequest}
            onSelectNode={selectNode}
            onSelectRelationship={selectRelationship}
            onFollow={(candidateKey, nodeId) => {
              setInteraction((current) => {
                let next = transitionFullGraphInteraction(model, current ?? initializeInteraction(model, generationRef.current), { type: "follow", candidateKey });
                next = transitionFullGraphInteraction(model, next, { type: "select", entityKind: "node", entityId: nodeId });
                return next;
              });
              requestNodeFocus(nodeId);
            }}
            onTogglePath={(pathKey, nodeId) => {
              update({ type: "toggle-path", pathKey });
              requestNodeFocus(nodeId);
            }}
          />
        </>}
        <GraphInventory model={model} canRoot={model.completeness.canFollow} onRoot={rootAt} onRelationship={(relationshipId, fromId) => {
          if (!model.completeness.canFollow) return;
          setInteraction((current) => {
            let next = transitionFullGraphInteraction(model, current ?? initializeInteraction(model, generationRef.current), { type: "set-root", nodeId: fromId });
            next = transitionFullGraphInteraction(model, next, { type: "select", entityKind: "relationship", entityId: relationshipId });
            return next;
          });
          requestNodeFocus(fromId);
        }} />
        {selected ? <EntityDetail key={`${selected.kind}:${selected.value.key}`} entity={selected} model={model} projectionDigest={projection.sourceArtifactDigest} onRefresh={refreshDetail} refreshStatus={selectedRefreshStatus} /> : <div className={styles.emptyDetail}>Select a node or relationship to inspect its human-readable source context.</div>}
      </section>}
    </section>
  );
}
