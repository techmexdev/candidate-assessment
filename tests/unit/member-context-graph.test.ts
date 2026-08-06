import { describe, expect, it } from "vitest";
import jordan from "../../data/member-context.json";
import {
  buildMemberContextSnapshot,
  compileMemberContextGraph,
} from "../../src/graph/ingest/member-context";
import { canonicalMemberContextDigest } from "../../src/graph/revisions/member-context";
import { buildMemberContextFixture } from "../fixtures/member-context-builder";

describe("member context graph", () => {
  it("retains the accepted aggregate compatibility projection", () => {
    const snapshot = buildMemberContextSnapshot(jordan, "dataset-v1");
    const kinds = new Set(snapshot.evidence.map((evidence) => evidence.kind));

    expect(snapshot.synthetic).toBe(true);
    expect(snapshot.contextRevision).toMatch(/^context-/);
    expect(snapshot.profile).toEqual(jordan.profile);
    expect(snapshot.goals).toHaveLength(3);
    expect(snapshot.workoutHistory).toHaveLength(4);
    expect(snapshot.chatHistory).toHaveLength(4);
    expect([...kinds]).toEqual(expect.arrayContaining([
      "profile", "goal", "preference", "equipment", "injury", "workout", "adherence",
      "biomarker", "lab", "message", "image", "coach-task", "churn-signal",
    ]));
  });

  it("compiles complete, atomic, provenance-bearing Jordan records exactly once", () => {
    const graph = compileMemberContextGraph(jordan);
    const byKind = (kind: (typeof graph.nodes)[number]["kind"]) => graph.nodes.filter((node) => node.kind === kind);
    const relationships = (kind: (typeof graph.relationships)[number]["kind"]) => graph.relationships.filter((edge) => edge.kind === kind);

    expect(byKind("member-profile")).toHaveLength(1);
    expect(byKind("goal")).toHaveLength(3);
    expect(byKind("preference")).toHaveLength(1);
    expect(byKind("equipment-availability")).toHaveLength(5);
    expect(byKind("injury-episode")).toHaveLength(1);
    expect(byKind("workout-session")).toHaveLength(4);
    expect(byKind("exercise-mention")).toHaveLength(9);
    expect(byKind("lab-panel")).toHaveLength(2);
    expect(byKind("observation")).toHaveLength(29);
    expect(byKind("message")).toHaveLength(4);
    expect(byKind("media-attachment")).toHaveLength(1);
    expect(byKind("coach-task")).toHaveLength(2);
    expect(byKind("churn-assessment")).toHaveLength(1);
    expect(byKind("churn-reason")).toHaveLength(3);
    expect(relationships("MENTIONS_EXERCISE")).toHaveLength(9);
    expect(relationships("CONTAINS_MEASUREMENT")).toHaveLength(12);
    expect(relationships("ASSERTS")).toHaveLength(graph.nodes.filter((node) => "assertionId" in node).length);

    const lowerBodyWorkout = byKind("workout-session").find((node) => (
      node.kind === "workout-session" && node.title === "Lower Body - Bands & DB"
    ));
    const orderedExerciseEdges = relationships("MENTIONS_EXERCISE")
      .filter((edge) => edge.fromSemanticId === lowerBodyWorkout?.semanticId)
      .map((edge) => edge.sourceOrder)
      .sort();
    expect(orderedExerciseEdges).toEqual([0, 1, 2]);

    const nullGoal = byKind("goal").find((node) => node.kind === "goal" && node.targetDate === null);
    const nullRpe = byKind("workout-session").find((node) => node.kind === "workout-session" && node.rpe === null);
    expect(nullGoal && "source" in nullGoal ? nullGoal.source.locator : null).toBe("/goals/goal_sleep");
    expect(nullRpe && "source" in nullRpe ? nullRpe.source.locator : null).toBe("/workout_history/2026-05-29:full-body");

    for (const node of graph.nodes.filter((candidate) => "assertionId" in candidate)) {
      expect(node).toMatchObject({
        contextRevisionId: graph.contextRevisionId,
        source: { artifactDigest: graph.sourceArtifactDigest },
        synthetic: true,
      });
    }
  });

  it("keeps exact, date, relative, and unknown time distinct without fabricating login evidence", () => {
    const graph = compileMemberContextGraph(jordan);
    const observations = graph.nodes.filter((node) => node.kind === "observation");
    const messages = graph.nodes.filter((node) => node.kind === "message");
    const reasons = graph.nodes.filter((node) => node.kind === "churn-reason");

    expect(messages.every((node) => node.temporal.precision === "exact-timestamp")).toBe(true);
    expect(observations.filter((node) => node.metric === "sleep-hours").every((node) => node.temporal.precision === "relative-order")).toBe(true);
    expect(observations.find((node) => node.metric === "resting-heart-rate")?.temporal).toEqual({ precision: "unknown" });
    expect(observations.find((node) => node.metric === "heart-rate-variability")?.temporal).toEqual({ precision: "unknown" });
    expect(observations.find((node) => node.metric === "body-weight")?.temporal.precision).toBe("date");
    expect(graph.nodes.some((node) => "metric" in node && String(node.metric).includes("login"))).toBe(false);
    expect(reasons.find((node) => node.text.startsWith("Login frequency"))?.basisStatus).toBe("unsupported-source");
  });

  it("uses reviewed mappings only and preserves unresolved exercise text", () => {
    const graph = compileMemberContextGraph(jordan);
    const equipment = graph.nodes.filter((node) => node.kind === "equipment-availability");
    const mentions = graph.nodes.filter((node) => node.kind === "exercise-mention");

    expect(equipment.every((node) => node.domainReference.state === "reviewed")).toBe(true);
    expect(mentions.every((node) => node.domainReference.state === "unresolved")).toBe(true);
    expect(mentions.find((node) => node.originalText === "Goblet Squat (box-supported)")?.domainReference).toEqual({
      state: "unresolved",
      originalText: "Goblet Squat (box-supported)",
      reason: "not-reviewed",
    });
  });

  it("is reorder-stable for unordered equipment and order-sensitive without index identities", () => {
    const original = compileMemberContextGraph(jordan);
    const equipmentReordered = compileMemberContextGraph(buildMemberContextFixture((document) => {
      document.equipment_available.reverse();
    }));
    const messagesReordered = compileMemberContextGraph(buildMemberContextFixture((document) => {
      document.chat_history.reverse();
    }));
    const semanticIds = (graph: typeof original, kind: (typeof graph.nodes)[number]["kind"]) => graph.nodes
      .filter((node) => node.kind === kind)
      .map((node) => node.semanticId)
      .sort();

    expect(equipmentReordered.contextRevisionId).toBe(original.contextRevisionId);
    expect(canonicalMemberContextDigest(equipmentReordered)).toBe(canonicalMemberContextDigest(original));
    expect(semanticIds(equipmentReordered, "equipment-availability")).toEqual(semanticIds(original, "equipment-availability"));
    expect(messagesReordered.contextRevisionId).not.toBe(original.contextRevisionId);
    expect(semanticIds(messagesReordered, "message")).toEqual(semanticIds(original, "message"));
  });

  it("is deeply immutable and changes revision only when canonical source content changes", () => {
    const first = compileMemberContextGraph(jordan);
    const identical = compileMemberContextGraph(structuredClone(jordan));
    const changed = compileMemberContextGraph(buildMemberContextFixture((document) => {
      document.biomarkers.hrv_ms += 1;
    }));

    expect(identical).toEqual(first);
    expect(changed.sourceArtifactDigest).not.toBe(first.sourceArtifactDigest);
    expect(changed.contextRevisionId).not.toBe(first.contextRevisionId);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.nodes)).toBe(true);
    expect(Object.isFrozen(first.nodes.find((node) => node.kind === "member-profile"))).toBe(true);
    expect(() => (first.nodes as unknown as unknown[]).push({})).toThrow();
  });
});
