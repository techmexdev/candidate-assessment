import { describe, expect, it } from "vitest";
import type { CatalogSafetyResult } from "../../src/domain/contracts/catalog-safety";
import {
  calculateWorkoutTiming,
  DEFAULT_WORKOUT_DURATION_POLICY,
  validateWorkoutComposition,
  verifyValidationReceipt,
} from "../../src/domain/policies/workout-composition";
import {
  catalogDecision,
  catalogResult,
  compositionCandidate,
  TEST_MEMBER_REVISION,
  TEST_MOVEMENT_REVISION,
  validationInput,
} from "../fixtures/workout-runtime-builder";

describe("workout composition policy", () => {
  it.each([30, 45, 60] as const)("validates a complete %i-minute workout with deterministic totals", (minutes) => {
    const input = validationInput(minutes);
    const first = validateWorkoutComposition(input);
    const second = validateWorkoutComposition(input);

    expect(first.status).toBe("valid");
    expect(second).toEqual(first);
    if (first.status !== "valid") return;
    expect(first.workout.sections.map((section) => section.kind)).toEqual(["warm-up", "main", "cool-down"]);
    expect(first.workout.timing.totalSeconds).toBe(minutes * 60);
    expect(first.workout.timing).toEqual(calculateWorkoutTiming(first.workout.sections));
    expect(first.receipt.durationPolicyVersion).toBe(DEFAULT_WORKOUT_DURATION_POLICY.version);
  });

  it.each([
    ["unknown exercise", (input: ReturnType<typeof validationInput>) => ({
      ...input,
      proposal: { ...input.proposal, sections: input.proposal.sections.map((section, index) => index === 1
        ? { ...section, items: [{ ...section.items[0]!, exerciseConceptId: "exercise:invented" }] }
        : section) },
    }), "unknown-exercise"],
    ["duplicate exercise", (input: ReturnType<typeof validationInput>) => ({
      ...input,
      proposal: { ...input.proposal, sections: input.proposal.sections.map((section, index) => index === 2
        ? { ...section, items: [{ ...section.items[0]!, exerciseConceptId: "exercise:main" }] }
        : section) },
    }), "duplicate-exercise"],
    ["missing section", (input: ReturnType<typeof validationInput>) => ({
      ...input,
      proposal: { ...input.proposal, sections: input.proposal.sections.filter((section) => section.kind !== "cool-down") },
    }), "missing-section"],
    ["invalid dose", (input: ReturnType<typeof validationInput>) => ({
      ...input,
      proposal: { ...input.proposal, sections: input.proposal.sections.map((section, index) => index === 1
        ? { ...section, items: [{ ...section.items[0]!, dose: { kind: "timed" as const, sets: 0, workSecondsPerSet: 10 } }] }
        : section) },
    }), "invalid-dose"],
    ["missing rest", (input: ReturnType<typeof validationInput>) => ({
      ...input,
      proposal: { ...input.proposal, sections: input.proposal.sections.map((section, index) => index === 1
        ? { ...section, items: [{ ...section.items[0]!, restSeconds: Number.NaN }] }
        : section) },
    }), "invalid-rest"],
    ["budget overflow", (input: ReturnType<typeof validationInput>) => ({
      ...input,
      proposal: { ...input.proposal, sections: input.proposal.sections.map((section, index) => index === 1
        ? { ...section, items: [{ ...section.items[0]!, dose: { kind: "timed" as const, sets: 2, workSecondsPerSet: 1_800 }, restSeconds: 300 }] }
        : section) },
    }), "budget-overflow"],
  ] as const)("rejects %s without emitting a receipt", (_name, mutate, reason) => {
    const result = validateWorkoutComposition(mutate(validationInput(45)));
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.violations.map((violation) => violation.code)).toContain(reason);
    expect(result).not.toHaveProperty("receipt");
  });

  it.each(["excluded", "fail_closed", "fixture", "mixed_revision"] as const)("fails closed for %s candidate authority", (kind) => {
    const input = validationInput();
    const base = catalogDecision("exercise:main");
    const catalogSafety = kind === "fail_closed"
      ? { status: "fail_closed" as const, reason: "graph_consistency_failure" as const, assertionIds: [], evidenceIds: [] }
      : kind === "fixture"
        ? { ...catalogResult([base]), authority: "fixture" as const } as unknown as CatalogSafetyResult
        : kind === "mixed_revision"
          ? catalogResult([{ ...base, memberContextRevisionId: "member-revision:other" }])
          : catalogResult([{ ...base, classification: "excluded" as const }]);
    const result = validateWorkoutComposition({
      ...input,
      catalogSafety,
      candidates: [compositionCandidate("exercise:main")],
      proposal: {
        ...input.proposal,
        sections: input.proposal.sections.map((section) => ({
          ...section,
          items: section.kind === "main" ? section.items : [],
        })),
      },
    });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") expect(result.violations.some((item) => item.code === "unsafe-candidate" || item.code === "invalid-authority" || item.code === "mixed-revision")).toBe(true);
  });

  it("retains caution and down-rank decision paths as visible warnings", () => {
    const result = validateWorkoutComposition(validationInput());
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.workout.sections.flatMap((section) => section.items).filter((item) => item.warnings.length > 0)).toEqual([
      expect.objectContaining({ exerciseConceptId: "exercise:main", warnings: [expect.objectContaining({ kind: "caution" })] }),
      expect.objectContaining({ exerciseConceptId: "exercise:cool-down", warnings: [expect.objectContaining({ kind: "downranked" })] }),
    ]);
  });

  it("rejects incomplete evidence anywhere in the complete decision set", () => {
    const input = validationInput();
    const decisions = input.catalogSafety.status === "ready"
      ? input.catalogSafety.decisions.map((decision) => decision.classification === "excluded"
        ? { ...decision, assertionIds: [] }
        : decision)
      : [];
    const result = validateWorkoutComposition({ ...input, catalogSafety: catalogResult(decisions) });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.violations).toContainEqual(expect.objectContaining({
        code: "incomplete-decision-evidence",
        exerciseConceptId: "exercise:excluded",
      }));
    }
  });

  it("returns a deeply immutable workout that preserves order and dose through serialization", () => {
    const result = validateWorkoutComposition(validationInput());
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(Object.isFrozen(result.workout)).toBe(true);
    expect(Object.isFrozen(result.workout.sections)).toBe(true);
    expect(Object.isFrozen(result.workout.sections[0]?.items[0]?.dose)).toBe(true);
    expect(JSON.parse(JSON.stringify(result.workout))).toEqual(result.workout);
  });

  it("binds completion to every validation receipt field", () => {
    const result = validateWorkoutComposition(validationInput());
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(verifyValidationReceipt(result.receipt, result.receipt)).toBe(true);
    for (const field of [
      "runId", "claimGeneration", "requestDigest", "revisionSealDigest", "resolvedConstraintDigest",
      "safetyEnvelopeDigest", "completeDecisionSetDigest", "modelProposalDigest", "workoutPayloadDigest",
      "provenanceDigest", "movementGraphRevisionId", "memberContextRevisionId", "durationPolicyVersion",
      "policyVersion", "schemaVersion",
    ] as const) {
      const changed = { ...result.receipt, [field]: field === "claimGeneration" ? result.receipt.claimGeneration + 1 : `${result.receipt[field]}:tampered` };
      expect(verifyValidationReceipt(result.receipt, changed), field).toBe(false);
    }
  });

  it("rejects a valid-looking proposal when its pinned revisions do not match", () => {
    const result = validateWorkoutComposition({
      ...validationInput(),
      movementGraphRevisionId: `${TEST_MOVEMENT_REVISION}:other`,
      memberContextRevisionId: TEST_MEMBER_REVISION,
    });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") expect(result.violations.some((item) => item.code === "mixed-revision")).toBe(true);
  });
});
