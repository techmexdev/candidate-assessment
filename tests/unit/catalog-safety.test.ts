import { describe, expect, it } from "vitest";
import { classifyCatalogSafety } from "../../src/domain/policies/catalog-safety";
import type {
  CatalogSafetyCandidateInput,
  CatalogSafetyPolicyInput,
  ClinicalCatalogContributionInput,
} from "../../src/domain/contracts/catalog-safety";

const MOVEMENT_REVISION = "movement-revision:test";
const MEMBER_REVISION = "member-revision:test";

function clinical(
  effect: ClinicalCatalogContributionInput["effect"] = "hard-contraindication",
  overrides: Partial<ClinicalCatalogContributionInput> = {},
): ClinicalCatalogContributionInput {
  return {
    kind: "clinical",
    conditionConceptId: "condition:test",
    conditionAssertionId: "assertion:condition",
    conditionEvidenceId: "evidence:condition",
    affectedAnatomyConceptId: "joint:knee",
    ruleConceptId: "clinical-rule:test",
    ruleAssertionId: "assertion:rule",
    targetConceptId: "movement-demand:test",
    effect,
    applicabilityMatched: true,
    targetPathAssertionIds: ["assertion:rule-target", "assertion:exercise-target"],
    anatomyPathAssertionIds: ["assertion:affected-knee", "assertion:part-of", "assertion:stress"],
    mappingAssertionIds: ["assertion:mapping"],
    evidenceAssertionIds: ["assertion:clinical-evidence"],
    ...overrides,
  };
}

function candidate(
  exerciseConceptId: string,
  overrides: Partial<CatalogSafetyCandidateInput> = {},
): CatalogSafetyCandidateInput {
  return {
    movementGraphRevisionId: MOVEMENT_REVISION,
    memberContextRevisionId: MEMBER_REVISION,
    exerciseConceptId,
    exerciseAssertionId: `assertion:${exerciseConceptId}`,
    isBilateral: false,
    evaluationComplete: true,
    requiredEquipment: [],
    clinicalEvaluations: [],
    explicitExclusions: [],
    preferences: [],
    ...overrides,
  };
}

function input(
  candidates: readonly CatalogSafetyCandidateInput[],
  overrides: Partial<CatalogSafetyPolicyInput> = {},
): CatalogSafetyPolicyInput {
  return {
    movementGraphRevisionId: MOVEMENT_REVISION,
    memberContextRevisionId: MEMBER_REVISION,
    authority: "canonical",
    expectedExerciseConceptIds: candidates.map((item) => item.exerciseConceptId),
    availableEquipment: [],
    equipmentEvidenceIds: ["evidence:equipment-set"],
    candidates,
    ...overrides,
  };
}

describe("catalog safety policy", () => {
  it("applies a clinical rule only with target and affected-anatomy corroboration", () => {
    const result = classifyCatalogSafety(input([
      candidate("exercise:knee-loaded", { clinicalEvaluations: [clinical()] }),
      candidate("exercise:stress-only", {
        clinicalEvaluations: [clinical("hard-contraindication", { targetPathAssertionIds: [] })],
      }),
    ]));

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.excluded[0]).toMatchObject({ exerciseConceptId: "exercise:knee-loaded", classification: "excluded" });
    expect(result.excluded[0]?.contributions[0]).toMatchObject({
      kind: "clinical",
      effect: "hard-contraindication",
    });
    expect(result.excluded[0]?.contributions[1]).toMatchObject({
      kind: "anatomy",
      effect: "corroboration",
      affectedAnatomyConceptId: "joint:knee",
      assertionIds: ["assertion:affected-knee", "assertion:part-of", "assertion:stress"],
    });
    expect(result.allowed.map((item) => item.exerciseConceptId)).toEqual(["exercise:stress-only"]);
  });

  it("fails the complete evaluation when an applicable target lacks anatomy corroboration", () => {
    const result = classifyCatalogSafety(input([
      candidate("exercise:broken", {
        clinicalEvaluations: [clinical("hard-contraindication", { anatomyPathAssertionIds: [] })],
      }),
      candidate("exercise:otherwise-allowed"),
    ]));

    expect(result).toMatchObject({
      status: "fail_closed",
      reason: "graph_consistency_failure",
      exerciseConceptId: "exercise:broken",
    });
    expect(result).not.toHaveProperty("allowed");
  });

  it("hard excludes missing equipment and records the requires path", () => {
    const result = classifyCatalogSafety(input([
      candidate("exercise:barbell", {
        requiredEquipment: [{
          equipmentConceptId: "equipment:barbell",
          equipmentAssertionId: "assertion:barbell",
          requiresAssertionId: "assertion:requires-barbell",
        }],
      }),
    ]));

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.excluded[0]?.contributions[0]).toMatchObject({
      kind: "equipment",
      effect: "hard-exclusion",
      equipmentConceptId: "equipment:barbell",
      assertionIds: ["assertion:barbell", "assertion:requires-barbell"],
    });
  });

  it("keeps an exercise eligible when every required equipment concept is available", () => {
    const result = classifyCatalogSafety(input([
      candidate("exercise:barbell", {
        requiredEquipment: [{
          equipmentConceptId: "equipment:barbell",
          equipmentAssertionId: "assertion:barbell",
          requiresAssertionId: "assertion:requires-barbell",
        }],
      }),
    ], {
      availableEquipment: [{
        equipmentConceptId: "equipment:barbell",
        assertionId: "assertion:member-barbell",
        evidenceId: "evidence:member-barbell",
      }],
    }));

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.allowed[0]).toMatchObject({
      exerciseConceptId: "exercise:barbell",
      evidenceIds: ["evidence:equipment-set", "evidence:member-barbell"],
    });
  });

  it("keeps exact and reviewed family exclusions hard without affecting unrelated exercises", () => {
    const exact = candidate("exercise:split-squat", {
      explicitExclusions: [{
        matchKind: "exact-exercise",
        resolvedConceptId: "exercise:split-squat",
        evidenceId: "evidence:exclude-exact",
        assertionIds: ["assertion:exclude-exact"],
      }],
    });
    const family = candidate("exercise:split-squat-variant", {
      explicitExclusions: [{
        matchKind: "variant-of",
        resolvedConceptId: "exercise:split-squat",
        evidenceId: "evidence:exclude-family",
        assertionIds: ["assertion:variant-edge"],
      }],
    });
    const result = classifyCatalogSafety(input([exact, family, candidate("exercise:lunge"), candidate("exercise:squat")]));

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.excluded.map((item) => item.exerciseConceptId)).toEqual([
      "exercise:split-squat",
      "exercise:split-squat-variant",
    ]);
    expect(result.allowed.map((item) => item.exerciseConceptId)).toEqual(["exercise:lunge", "exercise:squat"]);
  });

  it("retains every contribution while hard, caution, and down-rank precedence stay fixed", () => {
    const result = classifyCatalogSafety(input([
      candidate("exercise:all", {
        clinicalEvaluations: [clinical("hard-contraindication")],
        requiredEquipment: [{
          equipmentConceptId: "equipment:barbell",
          equipmentAssertionId: "assertion:barbell",
          requiresAssertionId: "assertion:requires-barbell",
        }],
        preferences: [{
          matchKind: "expresses",
          resolvedConceptId: "movement-pattern:lunge",
          evidenceId: "evidence:preference",
          rankPenalty: 2,
          assertionIds: ["assertion:expresses"],
        }],
      }),
      candidate("exercise:caution", {
        clinicalEvaluations: [clinical("caution")],
        preferences: [{
          matchKind: "exact-exercise",
          resolvedConceptId: "exercise:caution",
          evidenceId: "evidence:caution-preference",
          rankPenalty: 3,
          assertionIds: ["assertion:caution-preference"],
        }],
      }),
      candidate("exercise:clinical-downrank", { clinicalEvaluations: [clinical("down-rank")] }),
      candidate("exercise:preference", {
        preferences: [{
          matchKind: "exact-exercise",
          resolvedConceptId: "exercise:preference",
          evidenceId: "evidence:preference-two",
          rankPenalty: 1,
          assertionIds: ["assertion:preference-two"],
        }],
      }),
    ]));

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.excluded[0]?.contributions.map((item) => item.kind)).toEqual(["clinical", "anatomy", "equipment", "preference"]);
    expect(result.caution.map((item) => item.exerciseConceptId)).toEqual(["exercise:caution"]);
    expect(result.downranked.map((item) => item.exerciseConceptId)).toEqual([
      "exercise:clinical-downrank",
      "exercise:preference",
    ]);
  });

  it("sorts equal classifications by preference penalty and stable exercise ID", () => {
    const preference = (rankPenalty: number) => [{
      matchKind: "exact-exercise" as const,
      resolvedConceptId: "exercise:resolved",
      evidenceId: `evidence:preference:${rankPenalty}`,
      rankPenalty,
      assertionIds: [`assertion:preference:${rankPenalty}`],
    }];
    const result = classifyCatalogSafety(input([
      candidate("exercise:z", { preferences: preference(1) }),
      candidate("exercise:b", { preferences: preference(2) }),
      candidate("exercise:a", { preferences: preference(2) }),
    ]));

    expect(result.status === "ready" && result.downranked.map((item) => item.exerciseConceptId))
      .toEqual(["exercise:z", "exercise:a", "exercise:b"]);
  });

  it("derives loaded laterality only from typed isBilateral", () => {
    const result = classifyCatalogSafety(input([
      candidate("exercise:left-in-name", { isBilateral: false }),
      candidate("exercise:bilateral", { isBilateral: true }),
    ]));

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.decisions.map(({ exerciseConceptId, loadedLaterality }) => [exerciseConceptId, loadedLaterality])).toEqual([
      ["exercise:bilateral", "bilateral"],
      ["exercise:left-in-name", "unknown"],
    ]);
  });

  it.each([
    ["mixed revisions", input([candidate("exercise:a", { movementGraphRevisionId: "movement-revision:other" })]), "mixed_revision"],
    ["fixture authority", input([candidate("exercise:a")], { authority: "fixture" }), "non_authoritative_graph"],
    ["duplicate exercise", input([candidate("exercise:a"), candidate("exercise:a")]), "duplicate_exercise"],
    ["omitted exercise", input([candidate("exercise:a")], { expectedExerciseConceptIds: ["exercise:a", "exercise:b"] }), "incomplete_catalog"],
    ["partial evaluation", input([candidate("exercise:a", { evaluationComplete: false })]), "incomplete_evaluation"],
  ] as const)("fails closed for %s", (_label, policyInput, reason) => {
    expect(classifyCatalogSafety(policyInput)).toMatchObject({ status: "fail_closed", reason });
  });

  it("fails closed above the catalog cap without exposing a partial allowed set", () => {
    const candidates = Array.from({ length: 101 }, (_, index) => candidate(`exercise:${String(index).padStart(3, "0")}`));
    const result = classifyCatalogSafety(input(candidates));
    expect(result).toMatchObject({ status: "fail_closed", reason: "catalog_limit_exceeded" });
    expect(result).not.toHaveProperty("allowed");
  });

  it("returns only stable identifiers and codes, never raw prompt or health values", () => {
    const result = classifyCatalogSafety(input([candidate("exercise:a", { clinicalEvaluations: [clinical("caution")] })]));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("notes");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("injuryValue");
    expect(serialized).not.toContain("preferenceValue");
    expect(serialized).toContain("evidence:condition");
  });
});
