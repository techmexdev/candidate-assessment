import { describe, expect, it } from "vitest";
import {
  createWorkoutProvenanceBundle,
  validateWorkoutProvenance,
} from "../../src/domain/contracts/workout-provenance";
import { canonicalWorkoutDecisionSetDigest } from "../../src/graph/schema/workout-run-schema";
import { workoutDecision, TEST_MEMBER_REVISION, TEST_MOVEMENT_REVISION } from "../fixtures/workout-runtime-builder";
import {
  WORKOUT_GENERATION_SCENARIOS,
  executeWorkoutGenerationCorpus,
  renderWorkoutRuntimeDemoScenarios,
  renderWorkoutRuntimeExamples,
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
    expect(bundle.decisions.map(({ selectionDisposition, safetyClassification }) => ({ selectionDisposition, safetyClassification }))).toEqual([
      { selectionDisposition: "selected", safetyClassification: "allowed" },
      { selectionDisposition: "not-selected", safetyClassification: "excluded" },
      { selectionDisposition: "selected", safetyClassification: "caution" },
      { selectionDisposition: "selected", safetyClassification: "downranked" },
      { selectionDisposition: "selected", safetyClassification: "allowed" },
    ]);
  });

  it("binds selection disposition and safety classification into the canonical decision digest", () => {
    const selected = workoutDecision("exercise:test", "cautioned", {
      selectionDisposition: "selected",
      safetyClassification: "caution",
    });
    const omitted = { ...selected, selectionDisposition: "not-selected" as const };

    expect(canonicalWorkoutDecisionSetDigest([selected])).not.toBe(canonicalWorkoutDecisionSetDigest([omitted]));
  });

  it("rejects incomplete or contradictory explicit decision dimensions", () => {
    const base = {
      runId: "workout-run:test",
      workoutVersionId: "workout-version:test",
      promptEntityId: "entity:prompt:test",
      candidateSetEntityId: "entity:candidates:test",
      modelProposalEntityId: "entity:proposal:test",
      policyEntityId: "entity:policy:test",
      movementGraphRevisionId: TEST_MOVEMENT_REVISION,
      memberContextRevisionId: TEST_MEMBER_REVISION,
      traceSchemaVersion: "workout-provenance/v1" as const,
      digest: "sha256:provenance",
    };
    const incomplete = createWorkoutProvenanceBundle({
      ...base,
      decisions: [workoutDecision("exercise:incomplete", "selected", { safetyClassification: undefined })],
    });
    const contradictory = createWorkoutProvenanceBundle({
      ...base,
      decisions: [workoutDecision("exercise:contradictory", "selected", { safetyClassification: "excluded" })],
    });

    expect(validateWorkoutProvenance(incomplete)).toMatchObject({
      status: "invalid",
      violations: [expect.objectContaining({ code: "incomplete-decision-dimensions" })],
    });
    expect(validateWorkoutProvenance(contradictory)).toMatchObject({
      status: "invalid",
      violations: [expect.objectContaining({ code: "inconsistent-decision-dimensions" })],
    });
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
  it("hard-gates every required synthetic scenario at 100% safety validity and provenance completeness", async () => {
    const captures = await executeWorkoutGenerationCorpus(WORKOUT_GENERATION_SCENARIOS);
    const evaluation = scoreWorkoutGenerationCorpus(WORKOUT_GENERATION_SCENARIOS, captures);

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

  it("fails the release gate when an executed capture is deliberately corrupted", async () => {
    const baseline = WORKOUT_GENERATION_SCENARIOS.find((scenario) => scenario.id === "jordan-knee-applicability");
    expect(baseline).toBeDefined();
    if (!baseline) return;
    const capture = (await executeWorkoutGenerationCorpus([baseline]))[0]!;
    const corrupted = {
      ...capture,
      provenance: capture.provenance ? {
        ...capture.provenance,
        decisions: capture.provenance.decisions.map((decision, index) => index === 0
          ? { ...decision, sourceAssertionIds: [] }
          : decision),
      } : undefined,
      observed: {
        ...capture.observed,
        selectedExerciseIds: [...capture.observed.selectedExerciseIds, "exercise:runtime-corruption"],
      },
    };

    const score = scoreWorkoutGenerationScenario(baseline, corrupted);
    expect(score.recommendationValidity).toBeLessThan(1);
    expect(score.provenanceCompleteness).toBeLessThan(1);
    expect(score.hardGateFailures).toContain("recommendation-validity");
    expect(score.hardGateFailures).toContain("provenance-completeness");
    expect(score.releaseReady).toBe(false);
  });

  it("renders documentation from executed captures and the same fixture IDs used by evaluation", async () => {
    const captures = await executeWorkoutGenerationCorpus(WORKOUT_GENERATION_SCENARIOS);
    const demo = renderWorkoutRuntimeDemoScenarios(WORKOUT_GENERATION_SCENARIOS);
    const examples = renderWorkoutRuntimeExamples(WORKOUT_GENERATION_SCENARIOS, captures);
    const evaluation = renderWorkoutRuntimeEvaluation(scoreWorkoutGenerationCorpus(WORKOUT_GENERATION_SCENARIOS, captures));

    for (const scenario of WORKOUT_GENERATION_SCENARIOS) {
      expect(demo).toContain(`\`${scenario.id}\``);
      expect(evaluation).toContain(`\`${scenario.id}\``);
    }
    expect(demo).toContain("Synthetic data only");
    expect(examples).toContain("jordan-knee-applicability");
    expect(examples).toContain("limited-equipment");
    expect(examples).toContain("split-squat-family-exclusion");
    expect(examples).toContain("Hard-filtered before the model");
    expect(examples).toContain("Provenance trace");
    expect(evaluation).toContain("100.0%");
  });
});
