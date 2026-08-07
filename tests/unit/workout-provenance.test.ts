import { describe, expect, it } from "vitest";
import {
  createWorkoutProvenanceBundle,
  validateWorkoutProvenance,
} from "../../src/domain/contracts/workout-provenance";
import { workoutDecision, TEST_MEMBER_REVISION, TEST_MOVEMENT_REVISION } from "../fixtures/workout-runtime-builder";

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
