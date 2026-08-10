import { describe, expect, it } from "vitest";

import jordan from "../../data/member-context.json";
import type {
  FullGraphNode,
  FullGraphProjection,
  FullGraphRelationship,
} from "../../src/domain/contracts/full-graph-view";
import { projectMemberContextGraphSnapshot } from "../../src/domain/contracts/full-graph-view";
import {
  FULL_GRAPH_BUNDLE_PREVIEW_LIMIT,
  FULL_GRAPH_HIGH_DEGREE_THRESHOLD,
  buildFullGraphViewModel,
  createFullGraphInteractionState,
  deriveFullGraphBranch,
  filterFullGraphInventory,
  humanizeGraphKind,
  isFullGraphInteractionCurrent,
  transitionFullGraphInteraction,
} from "../../src/features/coach-dashboard/full-graph-view-model";
import { compileMemberContextGraph } from "../../src/graph/ingest/member-context";

const revisionId = "movement:one";

function node(
  id: string,
  kind: FullGraphNode["kind"],
  label: string,
  category: FullGraphNode["category"] = "domain",
): FullGraphNode {
  return {
    id,
    kind,
    label,
    category,
    revisionId,
    detail: [],
    provenance: {
      directAssertion: "present",
      assertionId: `assertion:${id}`,
      source: {
        locator: `fixture.json#/${id}`,
        artifactDigest: "sha256:private-source-digest",
      },
      lineageIds: [],
    },
  };
}

function relationship(
  id: string,
  kind: string,
  fromId: string,
  toId: string,
): FullGraphRelationship {
  return {
    id,
    kind,
    fromId,
    toId,
    revisionId,
    detail: [],
    provenance: {
      directAssertion: "present",
      assertionId: id,
      source: { locator: `fixture.json#/relationships/${id}` },
      lineageIds: [],
    },
  };
}

const projection: FullGraphProjection = {
  domain: "movement-clinical",
  revisionId,
  sourceArtifactDigest: "sha256:projection-one",
  authority: "canonical",
  counts: { nodes: 8, relationships: 8 },
  nodes: [
    node("publication:catalog", "evidence-source", "Catalog", "publication"),
    node("body-region:unnamed", "body-region", ""),
    node("joint:knee", "joint", "Knee"),
    node("joint:patella", "joint", "Patella"),
    node("graph:one", "graph-revision", "Revision one", "lineage"),
    node("exercise:squat", "exercise", "Squat"),
    node("exercise:split-squat", "exercise", "Squat"),
    node("member:one", "member", "Jordan", "identity"),
  ],
  relationships: [
    relationship("assertion:revision", "in-revision", "exercise:squat", "graph:one"),
    relationship("assertion:targets", "targets", "exercise:squat", "joint:knee"),
    relationship("assertion:catalog", "published-in", "exercise:squat", "publication:catalog"),
    relationship("assertion:split", "targets", "exercise:split-squat", "joint:knee"),
    relationship("assertion:identity", "describes", "member:one", "exercise:squat"),
    relationship("assertion:part-of", "part-of", "joint:patella", "joint:knee"),
    relationship("assertion:region", "targets", "exercise:split-squat", "body-region:unnamed"),
    relationship("assertion:cycle", "related-to", "joint:knee", "exercise:squat"),
  ],
};

function candidateFor(
  model: ReturnType<typeof buildFullGraphViewModel>,
  state: ReturnType<typeof createFullGraphInteractionState>,
  parentNodeId: string,
  neighborNodeId: string,
  direction?: "outgoing" | "incoming",
) {
  const candidate = deriveFullGraphBranch(model, state.branch).levels
    .find((level) => level.node.key === parentNodeId)
    ?.groups.flatMap((group) => group.candidates)
    .find((item) => item.neighbor?.key === neighborNodeId && (!direction || item.direction === direction));
  expect(candidate, `${parentNodeId} should connect to ${neighborNodeId}`).toBeDefined();
  return candidate!;
}

describe("full graph view model", () => {
  it("replaces production member-context identifier fallback labels with human-safe labels", () => {
    const memberProjection = projectMemberContextGraphSnapshot(compileMemberContextGraph(jordan), "canonical");
    const unsafeNodes = memberProjection.nodes.filter((item) => {
      const source = item.provenance.source;
      return [
        item.id,
        item.revisionId,
        memberProjection.revisionId,
        memberProjection.sourceArtifactDigest,
        item.provenance.assertionId,
        source?.sourceId,
        source?.sourceRevision,
        source?.sourceRecordId,
        source?.locator,
        source?.artifactDigest,
        ...item.provenance.lineageIds,
      ].includes(item.label.trim());
    });
    const model = buildFullGraphViewModel(memberProjection);

    expect(unsafeNodes).not.toHaveLength(0);
    for (const node of unsafeNodes) {
      const descriptor = model.nodeById.get(node.id)!;
      expect(descriptor.label).toMatch(new RegExp(`^${humanizeGraphKind(node.kind)} \\(unnamed\\)( · ${humanizeGraphKind(node.kind)} \\d+)?$`));
      expect(descriptor.accessibilityName).not.toContain(node.label.trim());
    }
  });

  it("humanizes future kinds and produces deterministic, duplicate-safe descriptors without machine references", () => {
    const futureNode = node("future:one", "FutureNode_KIND" as FullGraphNode["kind"], "Future record");
    const withFuture = {
      ...projection,
      counts: { nodes: projection.nodes.length + 1, relationships: projection.relationships.length },
      nodes: [...projection.nodes, futureNode],
    };
    const reversed = {
      ...withFuture,
      nodes: [...withFuture.nodes].reverse(),
      relationships: [...withFuture.relationships].reverse(),
    };
    const first = buildFullGraphViewModel(withFuture, { initialNodeId: "exercise:squat" });
    const second = buildFullGraphViewModel(reversed, { initialNodeId: "exercise:squat" });

    expect(humanizeGraphKind("FutureNode_KIND", "node")).toBe("Future node kind");
    expect(humanizeGraphKind("SUPPORTED_BY", "relationship")).toBe("supported by");
    expect(first.entryGroups.map((group) => group.category)).toEqual(["domain", "identity", "lineage", "publication"]);
    expect(first.inventory.nodes.map((item) => item.key)).toEqual(second.inventory.nodes.map((item) => item.key));
    expect(first.inventory.relationships.map((item) => item.key)).toEqual(second.inventory.relationships.map((item) => item.key));
    expect(first.inventory.nodes.filter((item) => item.node.kind === "exercise").map((item) => item.label)).toEqual([
      "Squat · Exercise 1",
      "Squat · Exercise 2",
    ]);
    expect(first.nodeById.get("body-region:unnamed")?.label).toBe("Body region (unnamed)");
    expect(first.nodeById.get("future:one")?.kindLabel).toBe("Future node kind");
    expect(first.focusedAnchor?.key).toBe("exercise:squat");

    const descriptors = [
      ...first.inventory.nodes.flatMap((item) => [item.label, item.kindLabel, item.accessibilityName]),
      ...first.inventory.relationships.flatMap((item) => [
        item.kindLabel,
        item.storedDirectionLabel,
        item.accessibilityName,
      ]),
    ].join(" | ");
    for (const machineReference of [
      "exercise:squat",
      "assertion:targets",
      "movement:one",
      "fixture.json",
      "sha256:private-source-digest",
    ]) {
      expect(descriptors).not.toContain(machineReference);
    }
  });

  it("indexes outgoing and incoming relationships separately and keeps stored direction in reverse-follow language", () => {
    const model = buildFullGraphViewModel(projection);
    let state = createFullGraphInteractionState(model);
    state = transitionFullGraphInteraction(model, state, { type: "set-root", nodeId: "joint:knee" });

    expect(model.outgoingByNodeId.get("joint:knee")?.map((item) => item.key)).toEqual(["assertion:cycle"]);
    expect(model.incomingByNodeId.get("joint:knee")?.map((item) => item.key)).toEqual([
      "assertion:part-of",
      "assertion:split",
      "assertion:targets",
    ]);

    const reversePart = candidateFor(model, state, "joint:knee", "joint:patella", "incoming");
    expect(reversePart.followLabel).toBe("has part · reverse of part of");
    expect(reversePart.relationship.storedDirectionLabel).toBe("Patella → part of → Knee");
    expect(reversePart.accessibilityName).toBe("Follow Patella through has part · reverse of part of. Stored direction: Patella → part of → Knee");

    const memberProjection: FullGraphProjection = {
      domain: "member-context",
      memberId: "mbr-jordan",
      revisionId: "context:one",
      sourceArtifactDigest: "sha256:member-context",
      authority: "canonical",
      counts: { nodes: 2, relationships: 1 },
      nodes: [
        { ...node("member:mbr-jordan", "member", "Jordan", "identity"), revisionId: "context:one" },
        { ...node("message:one", "message", "Check-in message"), revisionId: "context:one" },
      ],
      relationships: [
        { ...relationship("assertion:sent", "SENT_BY", "message:one", "member:mbr-jordan"), revisionId: "context:one" },
      ],
    };
    const memberModel = buildFullGraphViewModel(memberProjection);
    const memberState = createFullGraphInteractionState(memberModel);
    const reverseSentBy = candidateFor(memberModel, memberState, "member:mbr-jordan", "message:one", "incoming");

    expect(memberModel.seededRoot?.key).toBe("member:mbr-jordan");
    expect(memberState.branch.path.map((entry) => entry.nodeId)).toEqual(["member:mbr-jordan"]);
    expect(reverseSentBy.followLabel).toBe("has sent · reverse of sent by");
    expect(reverseSentBy.relationship.storedDirectionLabel).toBe("Check-in message → sent by → Jordan");
  });

  it("follows progressively, prunes sibling descendants, collapses descendants, and keeps selection independent", () => {
    const branchProjection: FullGraphProjection = {
      ...projection,
      counts: { nodes: 7, relationships: 8 },
      nodes: [
        node("root", "movement-pattern", "Root"),
        node("sibling:a", "exercise", "Sibling A"),
        node("sibling:b", "exercise", "Sibling B"),
        node("descendant:a", "joint", "A descendant"),
        node("descendant:b", "joint", "B descendant"),
        node("shared", "body-region", "Shared region"),
        node("isolated", "equipment", "Isolated"),
      ],
      relationships: [
        relationship("edge:root-a", "has-option", "root", "sibling:a"),
        relationship("edge:root-b", "has-option", "root", "sibling:b"),
        relationship("edge:a-child", "targets", "sibling:a", "descendant:a"),
        relationship("edge:b-child", "targets", "sibling:b", "descendant:b"),
        relationship("edge:root-shared", "related-to", "root", "shared"),
        relationship("edge:a-shared", "related-to", "sibling:a", "shared"),
        relationship("edge:b-shared", "related-to", "sibling:b", "shared"),
        relationship("edge:cycle", "related-to", "shared", "root"),
      ],
    };
    const model = buildFullGraphViewModel(branchProjection);
    let state = createFullGraphInteractionState(model);
    state = transitionFullGraphInteraction(model, state, { type: "set-root", nodeId: "root" });
    state = transitionFullGraphInteraction(model, state, {
      type: "select",
      entityKind: "relationship",
      entityId: "edge:root-a",
    });
    state = transitionFullGraphInteraction(model, state, {
      type: "follow",
      candidateKey: candidateFor(model, state, "root", "sibling:a").key,
    });
    state = transitionFullGraphInteraction(model, state, {
      type: "follow",
      candidateKey: candidateFor(model, state, "sibling:a", "descendant:a").key,
    });

    expect(state.branch.path.map((entry) => entry.nodeId)).toEqual(["root", "sibling:a", "descendant:a"]);
    expect(state.selection).toEqual({ entityKind: "relationship", entityId: "edge:root-a" });

    state = transitionFullGraphInteraction(model, state, {
      type: "follow",
      candidateKey: candidateFor(model, state, "root", "sibling:b").key,
    });
    expect(state.branch.path.map((entry) => entry.nodeId)).toEqual(["root", "sibling:b"]);
    expect(state.selection).toEqual({ entityKind: "relationship", entityId: "edge:root-a" });

    state = transitionFullGraphInteraction(model, state, {
      type: "follow",
      candidateKey: candidateFor(model, state, "sibling:b", "descendant:b").key,
    });
    const siblingPathKey = state.branch.path.find((entry) => entry.nodeId === "sibling:b")!.pathKey;
    state = transitionFullGraphInteraction(model, state, { type: "toggle-path", pathKey: siblingPathKey });
    expect(state.branch.path.map((entry) => entry.nodeId)).toEqual(["root", "sibling:b"]);

    const branch = deriveFullGraphBranch(model, state.branch);
    const sharedCandidates = branch.levels.flatMap((level) => level.groups.flatMap((group) => group.candidates))
      .filter((candidate) => candidate.neighbor?.key === "shared");
    expect(sharedCandidates.filter((candidate) => candidate.ownsCanonicalCard)).toHaveLength(1);
    expect(sharedCandidates.filter((candidate) => candidate.marker === "shared-connection"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ canFollow: false, ownsCanonicalCard: false }),
      ]));

    const sharedConnection = candidateFor(model, state, "sibling:b", "shared");
    const unchangedSharedConnection = transitionFullGraphInteraction(model, state, {
      type: "follow",
      candidateKey: sharedConnection.key,
    });
    expect(unchangedSharedConnection.branch).toEqual(state.branch);

    state = transitionFullGraphInteraction(model, state, {
      type: "follow",
      candidateKey: candidateFor(model, state, "root", "shared").key,
    });
    const cycle = candidateFor(model, state, "shared", "root", "outgoing");
    expect(cycle.marker).toBe("existing-path");
    expect(cycle.canFollow).toBe(false);
    const unchanged = transitionFullGraphInteraction(model, state, { type: "follow", candidateKey: cycle.key });
    expect(unchanged.branch).toEqual(state.branch);
  });

  it("bundles high-degree relationships by kind and direction with a 12-neighbor preview while retaining every relationship", () => {
    const outgoingNodes = Array.from({ length: 14 }, (_, index) => node(`out:${index}`, "exercise", `Outgoing ${index}`));
    const incomingNodes = Array.from({ length: 15 }, (_, index) => node(`in:${index}`, "joint", `Incoming ${index}`));
    const hubRelationships = [
      ...outgoingNodes.map((item, index) => relationship(`edge:out:${index}`, "SUPPORTED_BY", "hub", item.id)),
      ...incomingNodes.map((item, index) => relationship(`edge:in:${index}`, "SUPPORTED_BY", item.id, "hub")),
    ];
    const denseProjection: FullGraphProjection = {
      ...projection,
      counts: { nodes: 1 + outgoingNodes.length + incomingNodes.length, relationships: hubRelationships.length },
      nodes: [node("hub", "clinical-rule", "Dense hub"), ...outgoingNodes, ...incomingNodes],
      relationships: hubRelationships,
    };
    const model = buildFullGraphViewModel(denseProjection);
    let state = createFullGraphInteractionState(model);
    state = transitionFullGraphInteraction(model, state, { type: "set-root", nodeId: "hub" });
    const level = deriveFullGraphBranch(model, state.branch).levels[0]!;

    expect(model.degreeByNodeId.get("hub")).toBe(29);
    expect(model.degreeByNodeId.get("hub")).toBeGreaterThan(FULL_GRAPH_HIGH_DEGREE_THRESHOLD);
    expect(level.isHighDegree).toBe(true);
    expect(level.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: "incoming", kindLabel: "supported by", visibleCount: 12, totalCount: 15, isBundle: true }),
      expect.objectContaining({ direction: "outgoing", kindLabel: "supported by", visibleCount: 12, totalCount: 14, isBundle: true }),
    ]));
    expect(level.groups.every((group) => group.candidates.length <= FULL_GRAPH_BUNDLE_PREVIEW_LIMIT)).toBe(true);
    expect(model.inventory.relationships).toHaveLength(hubRelationships.length);
    expect(new Set(model.inventory.relationships.map((item) => item.key)).size).toBe(hubRelationships.length);
  });

  it("guards partial and invalid projections, uses human missing-endpoint copy, and reports loaded versus total provenance truthfully", () => {
    const partial: FullGraphProjection = {
      ...projection,
      counts: { nodes: 4, relationships: 3 },
      nodes: [node("exercise:loaded", "exercise", "Loaded exercise")],
      relationships: [relationship("edge:missing", "targets", "exercise:loaded", "joint:not-loaded")],
      page: {
        nodeOffset: 0,
        relationshipOffset: 0,
        pageSize: 1,
        hasMoreNodes: true,
        hasMoreRelationships: true,
      },
    };
    const model = buildFullGraphViewModel(partial);
    const missing = model.inventory.relationships[0]!;

    expect(model.status).toBe("partial");
    expect(model.completeness).toMatchObject({ isComplete: false, canFollow: false, missingEndpointCount: 1 });
    expect(model.inventory.counts.nodes).toEqual({ loaded: 1, total: 4, totalSource: "authoritative-metadata" });
    expect(model.inventory.counts.relationships).toEqual({ loaded: 1, total: 3, totalSource: "authoritative-metadata" });
    expect(missing.toLabel).toBe("Loading node details");
    expect(missing.accessibilityName).not.toContain("joint:not-loaded");
    expect(createFullGraphInteractionState(model).branch.path).toEqual([]);

    const unavailableTotals = buildFullGraphViewModel({
      ...partial,
      counts: { nodes: 0, relationships: Number.NaN },
    });
    expect(unavailableTotals.inventory.counts.nodes.total).toBeNull();
    expect(unavailableTotals.inventory.counts.relationships.total).toBeNull();
    expect(unavailableTotals.inventory.counts.nodes.totalSource).toBe("unavailable");

    const invalidComplete = buildFullGraphViewModel({ ...partial, page: undefined });
    expect(invalidComplete.status).toBe("invalid");
    expect(invalidComplete.completeness.canFollow).toBe(false);
  });

  it("exposes deterministic context reset identity and rejects branch state from another member, revision, source, projection, or generation", () => {
    const memberBase: FullGraphProjection = {
      ...projection,
      domain: "member-context",
      memberId: "member-one",
      revisionId: "context:one",
      sourceArtifactDigest: "sha256:one",
      counts: { nodes: 1, relationships: 0 },
      nodes: [{ ...node("member:member-one", "member", "Jordan", "identity"), revisionId: "context:one" }],
      relationships: [],
    };
    const model = buildFullGraphViewModel(memberBase, { projectionIdentity: "projection-a", operation: "browse" });
    const state = createFullGraphInteractionState(model, 7);

    expect(model.context.resetInputs).toEqual({
      domain: "member-context",
      memberId: "member-one",
      revisionId: "context:one",
      sourceArtifactDigest: "sha256:one",
      projectionIdentity: "projection-a",
      operation: "browse",
    });
    expect(isFullGraphInteractionCurrent(model, state, 7)).toBe(true);
    expect(isFullGraphInteractionCurrent(model, state, 8)).toBe(false);

    const changes: readonly Partial<FullGraphProjection>[] = [
      { domain: "movement-clinical" },
      { memberId: "member-two" },
      { revisionId: "context:two" },
      { sourceArtifactDigest: "sha256:two" },
    ];
    for (const change of changes) {
      const changed = buildFullGraphViewModel({ ...memberBase, ...change }, { projectionIdentity: "projection-a", operation: "browse" });
      expect(isFullGraphInteractionCurrent(changed, state, 7)).toBe(false);
    }
    const changedProjection = buildFullGraphViewModel(memberBase, { projectionIdentity: "projection-b", operation: "browse" });
    const changedOperation = buildFullGraphViewModel(memberBase, { projectionIdentity: "projection-a", operation: "inspect" });
    expect(isFullGraphInteractionCurrent(changedProjection, state, 7)).toBe(false);
    expect(isFullGraphInteractionCurrent(changedOperation, state, 7)).toBe(false);
  });

  it("filters the complete loaded inventory by label, kind, category, and relationship kind without changing branch ownership", () => {
    const model = buildFullGraphViewModel(projection);
    let state = createFullGraphInteractionState(model);
    state = transitionFullGraphInteraction(model, state, { type: "set-root", nodeId: "exercise:squat" });
    const originalPath = state.branch.path;

    expect(filterFullGraphInventory(model, "patella").nodes.map((item) => item.label)).toEqual(["Patella"]);
    expect(filterFullGraphInventory(model, { kinds: ["body-region"] }).nodes.map((item) => item.label)).toEqual(["Body region (unnamed)"]);
    expect(filterFullGraphInventory(model, { categories: ["publication"] }).nodes.map((item) => item.label)).toEqual(["Catalog"]);
    expect(filterFullGraphInventory(model, { relationshipKinds: ["part-of"] }).relationships.map((item) => item.kindLabel)).toEqual(["part of"]);
    expect(filterFullGraphInventory(model, "targets").relationships).toHaveLength(3);
    expect(model.inventory.nodes).toHaveLength(projection.nodes.length);
    expect(model.inventory.relationships).toHaveLength(projection.relationships.length);
    expect(state.branch.path).toBe(originalPath);
  });

  it("returns stable non-throwing empty and isolated states", () => {
    const empty = buildFullGraphViewModel({
      ...projection,
      counts: { nodes: 0, relationships: 0 },
      nodes: [],
      relationships: [],
    });
    const isolated = buildFullGraphViewModel({
      ...projection,
      counts: { nodes: 1, relationships: 0 },
      nodes: [node("equipment:mat", "equipment", "Mat")],
      relationships: [],
    });

    expect(empty.status).toBe("empty");
    expect(empty.entryGroups).toEqual([]);
    expect(empty.inventory.nodes).toEqual([]);
    expect(deriveFullGraphBranch(empty, createFullGraphInteractionState(empty).branch).levels).toEqual([]);
    expect(isolated.status).toBe("complete");
    expect(isolated.suggestedRoots.map((item) => item.label)).toEqual(["Mat"]);
    expect(isolated.degreeByNodeId.get("equipment:mat")).toBe(0);
  });

  it("indexes the larger origin-plan bound without dropping inventory records", () => {
    const nodes = Array.from({ length: 5_000 }, (_, index) => node(`node:${index}`, "exercise", `Exercise ${index}`));
    const relationships = Array.from({ length: 10_000 }, (_, index) => relationship(
      `assertion:scale-${index}`,
      "targets",
      `node:${index % nodes.length}`,
      `node:${(index * 13 + 1) % nodes.length}`,
    ));
    const model = buildFullGraphViewModel({
      ...projection,
      revisionId: "movement:scale",
      counts: { nodes: nodes.length, relationships: relationships.length },
      nodes: nodes.map((item) => ({ ...item, revisionId: "movement:scale" })),
      relationships: relationships.map((item) => ({ ...item, revisionId: "movement:scale" })),
    });

    expect(model.inventory.nodes).toHaveLength(5_000);
    expect(model.inventory.relationships).toHaveLength(10_000);
    expect(model.completeness).toMatchObject({ isComplete: true, canFollow: true });
  });
});
