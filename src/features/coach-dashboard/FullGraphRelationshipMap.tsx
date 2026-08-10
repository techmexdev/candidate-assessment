"use client";

import { useEffect, useRef, useState } from "react";

import {
  type FullGraphBranch,
  type FullGraphBranchCandidate,
  type FullGraphNodeDescriptor,
} from "./full-graph-view-model";
import styles from "./full-graph-explorer.module.css";

export type RelationshipMapSelection =
  | { readonly entityKind: "node"; readonly entityId: string }
  | { readonly entityKind: "relationship"; readonly entityId: string }
  | null;

type FullGraphRelationshipMapProps = {
  readonly hasRelationships: boolean;
  readonly branch: FullGraphBranch;
  readonly selection: RelationshipMapSelection;
  readonly focusRequest: { readonly nodeId: string; readonly token: number } | null;
  readonly onSelectNode: (nodeId: string) => void;
  readonly onSelectRelationship: (relationshipId: string) => void;
  readonly onFollow: (candidateKey: string, nodeId: string) => void;
  readonly onTogglePath: (pathKey: string, nodeId: string) => void;
};

function DirectionalEdge({ candidate, selected, onSelect }: {
  readonly candidate: FullGraphBranchCandidate;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const outgoing = candidate.direction === "outgoing";
  return (
    <div className={styles.edgeUnit}>
      <svg className={styles.edgeGraphic} viewBox="0 0 320 58" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
        <line x1="160" y1={outgoing ? 3 : 49} x2="160" y2={outgoing ? 49 : 3} />
        <polygon points={outgoing ? "154,43 166,43 160,53" : "154,9 166,9 160,0"} />
        <text x="160" y="31" textAnchor="middle">{candidate.relationship.kindLabel}</text>
      </svg>
      <button
        className={`${styles.semanticEdge} ${selected ? styles.relationshipSelected : ""}`}
        type="button"
        aria-pressed={selected}
        aria-label={`Inspect relationship: ${candidate.relationship.storedDirectionLabel}`}
        onClick={onSelect}
      >
        <span>{candidate.followLabel}</span>
        <small>Stored direction: {candidate.relationship.storedDirectionLabel}</small>
      </button>
    </div>
  );
}

function NodeCard({
  node,
  current,
  expanded,
  register,
  onActivate,
}: {
  readonly node: FullGraphNodeDescriptor;
  readonly current: boolean;
  readonly expanded: boolean;
  readonly register: (node: HTMLButtonElement | null) => void;
  readonly onActivate: () => void;
}) {
  return (
    <button
      ref={register}
      className={`${styles.branchNode} ${current ? styles.branchNodeCurrent : ""}`}
      type="button"
      aria-current={current ? "true" : undefined}
      aria-expanded={expanded}
      aria-label={node.accessibilityName}
      onClick={onActivate}
    >
      <span className={styles.nodeKind}>{node.kindLabel}</span>
      <strong>{node.label}</strong>
      <span className={styles.nodeMeta}>{node.relationshipCount} {node.relationshipCount === 1 ? "relationship" : "relationships"}</span>
    </button>
  );
}

export function FullGraphRelationshipMap({
  hasRelationships,
  branch,
  selection,
  focusRequest,
  onSelectNode,
  onSelectRelationship,
  onFollow,
  onTogglePath,
}: FullGraphRelationshipMapProps) {
  const [openBundles, setOpenBundles] = useState<ReadonlySet<string>>(new Set());
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (!focusRequest) return;
    requestAnimationFrame(() => nodeRefs.current.get(focusRequest.nodeId)?.focus());
  }, [focusRequest]);

  return (
    <section className={styles.relationshipMap} aria-label="Active relationship map">
      <div className={styles.surfaceHeader}>
        <div>
          <div className={styles.relationshipHeading}>ACTIVE BRANCH</div>
          <h3 className={styles.surfaceTitle}>Follow one relationship path</h3>
        </div>
        <span className={styles.focusCount}>{branch.path.length} {branch.path.length === 1 ? "level" : "levels"}</span>
      </div>
      <p className={styles.overviewNote}>Arrows preserve the stored source-to-target direction. Reverse controls describe traversal without changing the graph fact.</p>
      <div className={styles.branchLevels}>
        {branch.levels.map((level, levelIndex) => {
          const nextEntry = branch.path[levelIndex + 1];
          const candidates = level.groups.flatMap((group) => group.candidates);
          const activeCandidate = nextEntry
            ? candidates.find((candidate) => candidate.marker === "active-path"
              && candidate.neighbor?.key === nextEntry.nodeId
              && candidate.relationship.key === nextEntry.viaRelationshipId)
            : undefined;
          return (
            <div className={styles.branchLevel} key={level.pathEntry.pathKey} data-depth={levelIndex}>
              {levelIndex > 0 && (() => {
                const previousLevel = branch.levels[levelIndex - 1];
                const pathCandidate = previousLevel?.groups.flatMap((group) => group.candidates)
                  .find((candidate) => candidate.marker === "active-path"
                    && candidate.neighbor?.key === level.node.key
                    && candidate.relationship.key === level.pathEntry.viaRelationshipId);
                return pathCandidate ? <DirectionalEdge candidate={pathCandidate} selected={selection?.entityKind === "relationship" && selection.entityId === pathCandidate.relationship.key} onSelect={() => onSelectRelationship(pathCandidate.relationship.key)} /> : null;
              })()}
              <NodeCard
                node={level.node}
                current={level.isCurrent}
                expanded={Boolean(nextEntry)}
                register={(element) => {
                  if (element) nodeRefs.current.set(level.node.key, element);
                  else nodeRefs.current.delete(level.node.key);
                }}
                onActivate={() => {
                  onSelectNode(level.node.key);
                  if (nextEntry) onTogglePath(level.pathEntry.pathKey, level.node.key);
                }}
              />
              <div className={styles.connectionGroups}>
                {level.groups.map((group) => {
                  const open = !group.isBundle || openBundles.has(group.key);
                  const groupCandidates = group.candidates.filter((candidate) => candidate.key !== activeCandidate?.key);
                  return (
                    <section className={styles.connectionGroup} key={group.key} aria-label={`${group.direction} ${group.kindLabel} relationships`}>
                      {group.isBundle ? (
                        <button
                          className={styles.bundleControl}
                          type="button"
                          aria-expanded={open}
                          aria-label={`${group.direction === "outgoing" ? "Outgoing" : "Incoming"} ${group.kindLabel} relationships, ${open ? group.visibleCount : 0} visible of ${group.totalCount} total`}
                          onClick={() => setOpenBundles((current) => {
                            const next = new Set(current);
                            if (next.has(group.key)) next.delete(group.key);
                            else next.add(group.key);
                            return next;
                          })}
                        >
                          <span>{group.direction === "outgoing" ? "Outgoing" : "Reverse / incoming"} · {group.kindLabel}</span>
                          <strong>{open ? group.visibleCount : 0} visible / {group.totalCount} total</strong>
                        </button>
                      ) : <h4>{group.direction === "outgoing" ? "Outgoing" : "Reverse / incoming"} · {group.kindLabel}</h4>}
                      {open && <div className={styles.candidateList}>
                        {groupCandidates.map((candidate) => (
                          <div className={styles.candidate} key={candidate.key}>
                            <DirectionalEdge candidate={candidate} selected={selection?.entityKind === "relationship" && selection.entityId === candidate.relationship.key} onSelect={() => onSelectRelationship(candidate.relationship.key)} />
                            {candidate.canFollow && candidate.neighbor ? (
                              <button
                                className={styles.candidateNode}
                                type="button"
                                aria-label={candidate.accessibilityName}
                                onClick={() => {
                                  onSelectNode(candidate.neighbor!.key);
                                  onFollow(candidate.key, candidate.neighbor!.key);
                                }}
                              >
                                <span className={styles.nodeKind}>{candidate.neighbor.kindLabel}</span>
                                <strong>{candidate.neighbor.label}</strong>
                                <small>{candidate.marker === "shared-connection" ? "Shared connection" : candidate.neighbor.relationshipCount === 1 ? "1 relationship" : `${candidate.neighbor.relationshipCount} relationships`}</small>
                              </button>
                            ) : (
                              <button
                                className={styles.crossLink}
                                type="button"
                                disabled={!candidate.neighbor}
                                onClick={() => candidate.neighbor && onSelectNode(candidate.neighbor.key)}
                              >
                                <strong>{candidate.neighborLabel}</strong>
                                <span>{candidate.marker === "missing-endpoint"
                                  ? "Loading node details"
                                  : candidate.marker === "shared-connection"
                                    ? "Shared connection"
                                    : "Already in this path"}</span>
                              </button>
                            )}
                          </div>
                        ))}
                      </div>}
                    </section>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {!hasRelationships && <div className={styles.emptyDetail}>No relationships connect to this node in this snapshot.</div>}
    </section>
  );
}
