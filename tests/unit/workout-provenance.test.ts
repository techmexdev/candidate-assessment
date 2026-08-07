import { describe, expect, it } from "vitest";
import {
  createWorkoutProvenanceBundle,
  validateWorkoutProvenance,
} from "../../src/domain/contracts/workout-provenance";
import { workoutDecision, TEST_MEMBER_REVISION, TEST_MOVEMENT_REVISION } from "../fixtures/workout-runtime-builder";
import {
  WORKOUT_GENERATION_SCENARIOS,
  renderWorkoutRuntimeDemoScenarios,
  renderWorkoutRuntimeEvaluation,
  scoreWorkoutGenerationCorpus,
  scoreWorkoutGenerationScenario,
} from "../fixtures/workout-generation-scenarios";

describe("workout provenance", () => {
  it("creates a complete PROV-O projection for selected and rejected decisions", () => {
    const decisions = [
      workoutDecision("exercise:selected", "selected"),
      workoutDecision("exercise:excluded", "excluded"),
      workoutDecision("exercise:caution", "cautioned"),
      workoutDecision("exercise:downrank", "downranked"),
      workoutDecision("exercise:substitute", "substituted"),
    ];
    const bundle = createWorkoutProvenanceBundle({
      runId: "workout-run:test",
      workoutVersionId: "workout-version:test",
      promptEntityId: "entity:prompt:test",
      candidateSetEntityId: "entity:candidates:test",
      modelProposalEntityId: "entity:proposal:test",
      policyEntityId: "entity:policy:test",
      movementGraphRevisionId: TEST_MOVEMENT_REVISION,
      memberContextRevisionId: TEST_MEMBER_REVISION,
      decisions,
      traceSchemaVersion: "workout-provenance/v1",
      digest: "sha256:provenance",
    });

    expect(validateWorkoutProvenance(bundle)).toEqual({ status: "valid" });
    expect(bundle.activity.kind).toBe("workout-generation");
    expect(bundle.relations.filter((relation) => relation.kind === "used")).toHaveLength(6);
    expect(bundle.relations).toContainEqual({ kind: "wasGeneratedBy", entityId: "workout-version:test", activityId: "workout-run:test" });
    expect(bundle.decisions.map((decision) => decision.kind)).toEqual(["selected", "excluded", "cautioned", "downranked", "substituted"]);
  });

  it.each([
    ["source assertion", { sourceAssertionIds: [] }, "missing-assertion"],
    ["path", { contributingPathIds: [] }, "missing-path"],
    ["movement revision", { movementGraphRevisionId: "movement-revision:other" }, "mixed-revision"],
    ["member revision", { memberContextRevisionId: "member-revision:other" }, "mixed-revision"],
  ] as const)("rejects a decision missing its pinned %s", (_name, override, code) => {
    const bundle = createWorkoutProvenanceBundle({
      runId: "workout-run:test",
      workoutVersionId: "workout-version:test",
      promptEntityId: "entity:prompt:test",
      candidateSetEntityId: "entity:candidates:test",
      modelProposalEntityId: "entity:proposal:test",
      policyEntityId: "entity:policy:test",
      movementGraphRevisionId: TEST_MOVEMENT_REVISION,
      memberContextRevisionId: TEST_MEMBER_REVISION,
      decisions: [workoutDecision("exercise:test", "selected", override)],
      traceSchemaVersion: "workout-provenance/v1",
      digest: "sha256:provenance",
    });
    expect(validateWorkoutProvenance(bundle)).toMatchObject({ status: "invalid", violations: [expect.objectContaining({ code })] });
  });

  it("round-trips immutable trace data without changing IDs, order, kinds, or digests", () => {
    const bundle = createWorkoutProvenanceBundle({
      runId: "workout-run:test",
      workoutVersionId: "workout-version:test",
      promptEntityId: "entity:prompt:test",
      candidateSetEntityId: "entity:candidates:test",
      modelProposalEntityId: "entity:proposal:test",
      policyEntityId: "entity:policy:test",
      movementGraphRevisionId: TEST_MOVEMENT_REVISION,
      memberContextRevisionId: TEST_MEMBER_REVISION,
      decisions: [workoutDecision("exercise:b", "selected"), workoutDecision("exercise:a", "excluded")],
      traceSchemaVersion: "workout-provenance/v1",
      digest: "sha256:exact-input",
    });
    expect(JSON.parse(JSON.stringify(bundle))).toEqual(bundle);
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.decisions)).toBe(true);
  });
});

describe("workout runtime deterministic evaluation", () => {
  it("hard-gates every required synthetic scenario at 100% safety validity and provenance completeness", () => {
    const evaluation = scoreWorkoutGenerationCorpus(WORKOUT_GENERATION_SCENARIOS);

    expect(evaluation.scenarios.map((scenario) => scenario.scenarioId)).toEqual([
      "jordan-knee-applicability",
      "limited-equipment",
      "deadlift-zero-match",
      "split-squat-family-exclusion",
      "ambiguous-safety",
      "malformed-proposal",
      "duplicate-submission",
      "worker-reclaim",
      "authorization-revocation",
      "cancel-complete-race",
      "cursor-pruning",
      "receipt-tamper",
      "provider-canary",
      "historical-trace",
      "restart-safety-reevaluation",
    ]);
    expect(evaluation.recommendationValidity).toBe(1);
    expect(evaluation.provenanceCompleteness).toBe(1);
    expect(evaluation.releaseReady).toBe(true);
    expect(evaluation.scenarios.every((scenario) => scenario.synthetic)).toBe(true);
  });

  it("fails provenance completeness when a selected decision loses its assertion source", () => {
    const baseline = WORKOUT_GENERATION_SCENARIOS.find((scenario) => scenario.id === "jordan-knee-applicability");
    expect(baseline).toBeDefined();
    if (!baseline) return;
    const corrupted = {
      ...baseline,
      provenance: {
        ...baseline.provenance,
        decisions: baseline.provenance.decisions.map((decision, index) => index === 0
          ? { ...decision, sourceAssertionIds: [] }
          : decision),
      },
    };

    const score = scoreWorkoutGenerationScenario(corrupted);
    expect(score.provenanceCompleteness).toBeLessThan(1);
    expect(score.hardGateFailures).toContain("provenance-completeness");
    expect(score.releaseReady).toBe(false);
  });

  it("renders documentation from the same fixture IDs and expected outcomes used by evaluation", () => {
    const demo = renderWorkoutRuntimeDemoScenarios(WORKOUT_GENERATION_SCENARIOS);
    const evaluation = renderWorkoutRuntimeEvaluation(scoreWorkoutGenerationCorpus(WORKOUT_GENERATION_SCENARIOS));

    for (const scenario of WORKOUT_GENERATION_SCENARIOS) {
      expect(demo).toContain(`\`${scenario.id}\``);
      expect(evaluation).toContain(`\`${scenario.id}\``);
    }
    expect(demo).toContain("Synthetic data only");
    expect(evaluation).toContain("100.0%");
  });
});
