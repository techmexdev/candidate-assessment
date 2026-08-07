import { describe, expect, it, vi } from "vitest";
import {
  createMovementSafetyReadCache,
  evaluateMovementSafety,
  evaluateMovementSafetyFactsWithHandle,
} from "../../src/application/use-cases/evaluate-movement-safety";
import type { MovementGraphReadHandle } from "../../src/domain/contracts/movement-clinical-queries";
import { decideMovementSafety } from "../../src/domain/policies/movement-safety";
import type { MatchedClinicalRulePath, MovementSafetyContext } from "../../src/domain/contracts/movement-safety";
import { compileDefaultMovementGraph } from "../../src/graph/ingest/movement-clinical";
import { InMemoryMovementGraphReadProvider } from "../../src/graph/repositories/movement-graph";

const BARBELL_LUNGE = "exercise:00b26731-066f-4b69-96e8-3472fc6fbc09";

function snapshot() {
  const result = compileDefaultMovementGraph();
  if (result.status !== "valid") throw new Error(JSON.stringify(result.report));
  return result.snapshot;
}

function withPfpsRuleTarget(targetConceptId: "joint:knee" | "joint:patellofemoral") {
  const graph = structuredClone(snapshot());
  const edge = graph.edges.find((item) => item.fromConceptId === "clinical-rule:pfps-deep-loaded-knee-flexion:v1" && item.kind === "contraindicates");
  if (!edge) throw new Error("PFPS rule edge missing");
  Object.assign(edge, { toConceptId: targetConceptId, toKind: "joint" });
  return graph;
}

const activePfps: MovementSafetyContext = {
  conditionConceptId: "condition:patellofemoral-pain-syndrome",
  affectedAnatomyConceptId: "joint:knee",
  conditionStatus: "active",
  recoveryStage: "return-to-training",
  severityBand: "moderate",
  affectedLaterality: "left",
  loadedLaterality: "unknown",
};

function path(effect: MatchedClinicalRulePath["effect"], ruleConceptId: string): MatchedClinicalRulePath {
  return {
    conditionConceptId: "condition:test", conditionAssertionId: "assertion:condition", ruleConceptId,
    affectedAnatomyConceptId: "joint:test",
    ruleAssertionId: `assertion:${ruleConceptId}`, effect,
    applicability: { conditionStatuses: ["active"], recoveryStages: ["managed"], severityBands: ["low"], lateralityPolicy: "either-side" },
    overridePolicy: { allowed: true, rationaleRequired: true }, targetConceptId: "movement-demand:test", targetKind: "movement-demand",
    pathAssertionIds: [`assertion:path:${ruleConceptId}`], mappingAssertionIds: [`assertion:mapping:${ruleConceptId}`], evidenceAssertionIds: [`assertion:evidence:${ruleConceptId}`],
    exercisePathAssertionIds: [`assertion:exercise:${ruleConceptId}`],
    affectedAnatomyPathAssertionIds: [`assertion:anatomy:${ruleConceptId}`],
  };
}

describe("movement safety", () => {
  it("applies a canonical rule through the exercise demand and returns complete provenance", async () => {
    const graph = snapshot();
    const provider = new InMemoryMovementGraphReadProvider([graph], { authority: "canonical" });
    const result = await evaluateMovementSafety(provider, { exerciseConceptId: BARBELL_LUNGE, conditions: [activePfps] });

    expect(result).toMatchObject({ status: "excluded", exerciseConceptId: BARBELL_LUNGE, graphRevisionId: graph.graphRevisionId, authority: "canonical" });
    if (result.status !== "excluded") return;
    expect(result.contributingPaths).toHaveLength(1);
    expect(result.contributingPaths[0]).toMatchObject({
      effect: "hard-contraindication",
      targetConceptId: "movement-demand:deep-loaded-knee-flexion",
    });
    expect(result.contributingPaths[0]!.assertionIds.length).toBeGreaterThan(5);
    expect(result.assertionIds).toEqual([...result.assertionIds].sort());
  });

  it("walks anatomy from rule target down to loaded descendants, never the opposite direction", async () => {
    const descendantGraph = withPfpsRuleTarget("joint:knee");
    Object.assign(descendantGraph, { edges: descendantGraph.edges.filter((edge) => !(
      edge.kind === "stresses" && edge.fromConceptId === BARBELL_LUNGE && edge.toConceptId === "joint:knee"
    )) });
    const anatomyEdge = descendantGraph.edges.find((edge) => edge.kind === "part-of" && edge.fromConceptId === "joint:patellofemoral");
    const descendantProvider = new InMemoryMovementGraphReadProvider([descendantGraph], { authority: "canonical" });
    const descendant = await evaluateMovementSafety(descendantProvider, {
      exerciseConceptId: BARBELL_LUNGE,
      conditions: [activePfps],
    });
    expect(descendant.status).toBe("excluded");
    if (descendant.status === "excluded") {
      expect(descendant.contributingPaths[0]?.assertionIds).toContain(anatomyEdge?.assertionId);
    }

    const ancestorOnlyProvider = new InMemoryMovementGraphReadProvider([withPfpsRuleTarget("joint:patellofemoral")], { authority: "canonical" });
    const ancestorOnly = await evaluateMovementSafety(ancestorOnlyProvider, {
      exerciseConceptId: "exercise:0252c3c1-435f-49a2-9f79-5ef53eec3b1b",
      conditions: [activePfps],
    });
    expect(ancestorOnly.status).toBe("allowed");
  });

  it("applies conservative laterality while stress without a matching rule stays allowed", async () => {
    const provider = new InMemoryMovementGraphReadProvider([snapshot()], { authority: "canonical" });
    const stressOnly = await evaluateMovementSafety(provider, {
      exerciseConceptId: BARBELL_LUNGE,
      conditions: [{ ...activePfps, conditionConceptId: "condition:knee-pain" }],
    });
    expect(stressOnly.status).toBe("allowed");

    const missingSideProof = await evaluateMovementSafety(provider, {
      exerciseConceptId: BARBELL_LUNGE,
      conditions: [{ ...activePfps, loadedLaterality: "unknown" }],
    });
    expect(missingSideProof.status).toBe("excluded");
    const callerClaimedOpposite = await evaluateMovementSafety(provider, {
      exerciseConceptId: BARBELL_LUNGE,
      conditions: [{ ...activePfps, loadedLaterality: "right" }],
    });
    expect(callerClaimedOpposite.status).toBe("excluded");
  });

  it("fails closed on missing applicability data, unknown exercise, and fixture authority", async () => {
    const canonical = new InMemoryMovementGraphReadProvider([snapshot()], { authority: "canonical" });
    await expect(evaluateMovementSafety(canonical, {
      exerciseConceptId: BARBELL_LUNGE,
      conditions: [{ ...activePfps, recoveryStage: undefined }],
    })).resolves.toMatchObject({ status: "fail_closed", reason: "insufficient_member_context" });
    await expect(evaluateMovementSafety(canonical, { exerciseConceptId: "exercise:model-invented", conditions: [activePfps] }))
      .resolves.toMatchObject({ status: "fail_closed", reason: "unresolved_exercise" });
    const fixture = new InMemoryMovementGraphReadProvider([snapshot()], { authority: "fixture" });
    await expect(evaluateMovementSafety(fixture, { exerciseConceptId: BARBELL_LUNGE, conditions: [] }))
      .resolves.toMatchObject({ status: "fail_closed", reason: "non_authoritative_graph" });
  });

  it("fails closed when a matching rule target lacks affected-anatomy corroboration", async () => {
    const provider = new InMemoryMovementGraphReadProvider([snapshot()], { authority: "canonical" });
    await expect(evaluateMovementSafety(provider, {
      exerciseConceptId: BARBELL_LUNGE,
      conditions: [{ ...activePfps, affectedAnatomyConceptId: "joint:shoulder" }],
    })).resolves.toMatchObject({ status: "fail_closed", reason: "graph_consistency_failure" });
  });

  it("does not require anatomy corroboration for a target-matching rule outside the current applicability", async () => {
    const provider = new InMemoryMovementGraphReadProvider([snapshot()], { authority: "canonical" });
    await expect(evaluateMovementSafety(provider, {
      exerciseConceptId: BARBELL_LUNGE,
      conditions: [{
        ...activePfps,
        affectedAnatomyConceptId: "joint:shoulder",
        recoveryStage: "managed",
        severityBand: "low",
      }],
    })).resolves.toMatchObject({ status: "allowed" });
  });

  it("reuses pinned rule and anatomy reads across a catalog evaluation", async () => {
    const provider = new InMemoryMovementGraphReadProvider([snapshot()], { authority: "canonical" });
    const opened = await provider.openActive();
    if (opened.status !== "ready") throw new Error("Movement graph did not open");
    const facts = await opened.handle.getExerciseConstraintFacts({ exerciseConceptId: BARBELL_LUNGE, maxResults: 32 });
    if (facts.status !== "ok") throw new Error("Exercise facts unavailable");
    const clinical = vi.spyOn(opened.handle, "getClinicalRuleFacts");
    const anatomy = vi.spyOn(opened.handle, "getAnatomyPaths");
    const cache = createMovementSafetyReadCache();

    for (let index = 0; index < 2; index += 1) {
      await evaluateMovementSafetyFactsWithHandle(opened.handle as MovementGraphReadHandle, {
        graphRevisionId: opened.handle.graphRevisionId,
        exerciseConceptId: BARBELL_LUNGE,
        conditions: [activePfps],
      }, facts.data, cache);
    }

    expect(clinical).toHaveBeenCalledOnce();
    expect(anatomy).toHaveBeenCalledOnce();
  });

  it("keeps every applicable path while fixed precedence chooses the strongest effect", () => {
    const context: MovementSafetyContext = {
      conditionConceptId: "condition:test", affectedAnatomyConceptId: "joint:test", conditionStatus: "active", recoveryStage: "managed", severityBand: "low",
      affectedLaterality: "unknown", loadedLaterality: "unknown",
    };
    const result = decideMovementSafety({
      graphRevisionId: "graph:test", authority: "canonical", exerciseConceptId: "exercise:test", exerciseAssertionId: "assertion:exercise",
      evaluations: [{ context, matchedPaths: [path("down-rank", "rule:z"), path("hard-contraindication", "rule:a"), path("caution", "rule:m")] }],
    });
    expect(result.status).toBe("excluded");
    if (result.status !== "excluded") return;
    expect(result.contributingPaths.map((item) => item.effect)).toEqual(["hard-contraindication", "caution", "down-rank"]);
  });
});
