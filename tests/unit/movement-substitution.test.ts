import { describe, expect, it } from "vitest";
import { findMovementSubstitutes } from "../../src/application/use-cases/find-movement-substitutes";
import { rankMovementSubstitutes } from "../../src/domain/policies/movement-substitution";
import { compileDefaultMovementGraph } from "../../src/graph/ingest/movement-clinical";
import { InMemoryMovementGraphReadProvider } from "../../src/graph/repositories/movement-graph";

const BARBELL_LUNGE = "exercise:00b26731-066f-4b69-96e8-3472fc6fbc09";
const MED_BALL_SPLIT_SQUAT = "exercise:0252c3c1-435f-49a2-9f79-5ef53eec3b1b";

function snapshot() {
  const result = compileDefaultMovementGraph();
  if (result.status !== "valid") throw new Error(JSON.stringify(result.report));
  return result.snapshot;
}

const condition = {
  conditionConceptId: "condition:patellofemoral-pain-syndrome",
  affectedAnatomyConceptId: "joint:knee",
  conditionStatus: "active",
  recoveryStage: "return-to-training",
  severityBand: "moderate",
  affectedLaterality: "left" as const,
  loadedLaterality: "unknown" as const,
};

describe("movement substitutions", () => {
  it("keeps only reviewed, equipment-valid candidates after every safety rule is rechecked", async () => {
    const graph = snapshot();
    const provider = new InMemoryMovementGraphReadProvider([graph], { authority: "canonical" });
    const result = await findMovementSubstitutes(provider, {
      exerciseConceptId: BARBELL_LUNGE,
      availableEquipmentConceptIds: ["equipment:medicine-ball", "equipment:dumbbell", "equipment:kettlebell", "equipment:slant-board"],
      excludedExerciseConceptIds: [],
      conditions: [condition],
    });

    expect(result).toMatchObject({ status: "substitutes_found", graphRevisionId: graph.graphRevisionId, authority: "canonical" });
    if (result.status !== "substitutes_found") return;
    expect(result.candidates.map((candidate) => candidate.exerciseConceptId)).toEqual([MED_BALL_SPLIT_SQUAT]);
    expect(result.candidates[0]!.assertionIds).toEqual([...result.candidates[0]!.assertionIds].sort());
  });

  it("does not promote explicit exclusions, unsafe candidates, or caller/model inventions", async () => {
    const provider = new InMemoryMovementGraphReadProvider([snapshot()], { authority: "canonical" });
    await expect(findMovementSubstitutes(provider, {
      exerciseConceptId: BARBELL_LUNGE,
      candidateExerciseConceptIds: ["exercise:model-invented"],
      availableEquipmentConceptIds: ["equipment:medicine-ball", "equipment:dumbbell", "equipment:kettlebell", "equipment:slant-board"],
      excludedExerciseConceptIds: [], conditions: [condition],
    })).resolves.toMatchObject({ status: "no_safe_alternative", reason: "no_reviewed_candidate" });
    await expect(findMovementSubstitutes(provider, {
      exerciseConceptId: BARBELL_LUNGE,
      availableEquipmentConceptIds: ["equipment:medicine-ball"],
      excludedExerciseConceptIds: [MED_BALL_SPLIT_SQUAT], conditions: [condition],
    })).resolves.toMatchObject({ status: "no_safe_alternative" });
  });

  it("uses stable ID as the final tie-breaker and rejects fixture reviewable results", async () => {
    const ranked = rankMovementSubstitutes({
      graphRevisionId: "graph:test", authority: "canonical", originalExerciseConceptId: "exercise:source",
      availableEquipmentConceptIds: [], excludedExerciseConceptIds: [],
      candidates: ["exercise:b", "exercise:a"].map((exerciseConceptId) => ({
        review: { exerciseConceptId, exerciseAssertionId: `assertion:${exerciseConceptId}`, substitutionAssertionId: `assertion:sub:${exerciseConceptId}`, rank: 1, preservedIntent: "intent", curator: "curator", reviewedAt: "2026-08-06" },
        requiredEquipment: [],
        safety: { status: "allowed" as const, graphRevisionId: "graph:test", authority: "canonical" as const, exerciseConceptId, exerciseAssertionId: `assertion:${exerciseConceptId}`, contributingPaths: [], assertionIds: [`assertion:${exerciseConceptId}`] },
      })),
    });
    expect(ranked.status === "substitutes_found" && ranked.candidates.map((item) => item.exerciseConceptId)).toEqual(["exercise:a", "exercise:b"]);

    const fixture = new InMemoryMovementGraphReadProvider([snapshot()], { authority: "fixture" });
    await expect(findMovementSubstitutes(fixture, {
      exerciseConceptId: BARBELL_LUNGE, availableEquipmentConceptIds: ["equipment:medicine-ball"], excludedExerciseConceptIds: [], conditions: [],
    })).resolves.toMatchObject({ status: "no_safe_alternative", reason: "non_authoritative_graph" });
  });
});
