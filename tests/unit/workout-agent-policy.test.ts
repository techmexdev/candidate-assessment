import { describe, expect, it } from "vitest";
import { createWorkoutComposerAgentInput, createWorkoutComposerInput } from "../../src/agents/workout/tools";
import { createWorkoutReviewInput } from "../../src/agents/workout/review-tools";
import { createDeterministicWorkoutReviewer } from "../../src/agents/workout/deterministic-agents";
import { parseWorkoutReviewerResult } from "../../src/application/ports/workout-reviewer";
import { parseWorkoutProposal } from "../../src/agents/workout/schemas";
import { catalogDecision, catalogResult, compositionCandidate } from "../fixtures/workout-runtime-builder";

describe("bounded workout agent policy", () => {
  it("projects only eligible typed candidates and allowlisted evidence", () => {
    const safety = catalogResult([
      catalogDecision("exercise:warm-up"),
      catalogDecision("exercise:main", "caution"),
      catalogDecision("exercise:split-squat-variant", "excluded"),
    ]);
    const input = createWorkoutComposerInput({
      canonicalIntent: { focusConceptIds: ["movement-pattern:squat"], requestedDurationMinutes: 45 },
      movementGraphRevisionId: safety.movementGraphRevisionId,
      memberContextRevisionId: safety.memberContextRevisionId,
      resolvedConstraintDigest: "sha256:constraints",
      evaluationConstraintDigest: "sha256:evaluation-constraints",
      safetyEnvelopeDigest: "sha256:safety",
      catalogSafety: safety,
      candidateProfiles: [
        compositionCandidate("exercise:warm-up"),
        compositionCandidate("exercise:main"),
        compositionCandidate("exercise:split-squat-variant"),
      ],
    });

    expect(input.candidates.map((candidate) => candidate.exerciseConceptId)).toEqual([
      "exercise:warm-up",
      "exercise:main",
    ]);
    expect(input.candidates.flatMap((candidate) => candidate.citationIds)).toEqual(expect.arrayContaining([
      "evidence:exercise:warm-up",
      "evidence:exercise:main",
    ]));
    expect(JSON.stringify(input)).not.toContain("exercise:split-squat-variant");
    expect(JSON.stringify(input)).not.toMatch(/raw prompt|authorization|neo4j|recovering|mild/i);
    const agentInput = createWorkoutComposerAgentInput(input);
    expect(JSON.stringify(agentInput)).not.toContain("evidence:");
    expect(JSON.stringify(agentInput)).not.toContain("member-revision");
    expect(JSON.stringify(agentInput)).not.toContain("authorization");
    expect(agentInput.candidates[0]).toHaveProperty("citationRefs", ["candidate-ref:1"]);
  });

  it("rejects malformed output, unknown fields, and fabricated citations", () => {
    const malformed = parseWorkoutProposal({ schemaVersion: "workout-proposal/v1", sections: [] });
    expect(malformed.status).toBe("invalid");

    const injected = parseWorkoutProposal({
      schemaVersion: "workout-proposal/v1",
      authorizationId: "grant:canary",
      sections: [
        { kind: "warm-up", items: [] },
        { kind: "main", items: [] },
        { kind: "cool-down", items: [] },
      ],
    });
    expect(injected.status).toBe("invalid");
  });

  it("gives the reviewer a minimized packet with no authority or evidence identifiers", async () => {
    const safety = catalogResult([catalogDecision("exercise:warm-up"), catalogDecision("exercise:main"), catalogDecision("exercise:cool-down")]);
    const composerInput = createWorkoutComposerInput({
      canonicalIntent: { focusConceptIds: ["movement-pattern:squat"], requestedDurationMinutes: 45 },
      movementGraphRevisionId: safety.movementGraphRevisionId,
      memberContextRevisionId: safety.memberContextRevisionId,
      resolvedConstraintDigest: "sha256:constraints",
      evaluationConstraintDigest: "sha256:evaluation",
      safetyEnvelopeDigest: "sha256:safety",
      catalogSafety: safety,
      candidateProfiles: safety.decisions.map((decision) => compositionCandidate(decision.exerciseConceptId)),
    });
    const proposal = {
      schemaVersion: "workout-proposal/v1" as const,
      sections: [
        { kind: "warm-up" as const, items: [{ exerciseConceptId: "exercise:warm-up", dose: { kind: "timed" as const, sets: 1, workSecondsPerSet: 540 }, restSeconds: 0, rationale: "Prepare movement quality", citationIds: ["evidence:exercise:warm-up"] }] },
        { kind: "main" as const, items: [{ exerciseConceptId: "exercise:main", dose: { kind: "timed" as const, sets: 1, workSecondsPerSet: 1_800 }, restSeconds: 0, rationale: "Address the workout", citationIds: ["evidence:exercise:main"] }] },
        { kind: "cool-down" as const, items: [{ exerciseConceptId: "exercise:cool-down", dose: { kind: "timed" as const, sets: 1, workSecondsPerSet: 360 }, restSeconds: 0, rationale: "Return toward baseline", citationIds: ["evidence:exercise:cool-down"] }] },
      ],
    };
    const reviewInput = createWorkoutReviewInput(composerInput, proposal);
    const serialized = JSON.stringify(reviewInput);
    expect(serialized).not.toContain("member-revision");
    expect(serialized).not.toContain("sha256:constraints");
    expect(serialized).not.toContain("evidence:");
    expect(serialized).not.toContain("citation");
    expect(serialized).not.toContain("member note");
    await expect(createDeterministicWorkoutReviewer().review(reviewInput)).resolves.toMatchObject({ status: "accepted" });
  });

  it("ignores candidate widening and safety override critiques", () => {
    const eligible = ["exercise:warm-up", "exercise:main"];
    expect(parseWorkoutReviewerResult({
      status: "revise",
      defects: ["dose-imbalance"],
      requestedCandidateConceptIds: ["exercise:unknown"],
    }, eligible)).toMatchObject({ status: "failed", reason: "invalid-structured-output" });
    expect(parseWorkoutReviewerResult({
      status: "revise",
      defects: ["rationale-quality"],
      safetyOverrides: ["exercise:main"],
    }, eligible)).toMatchObject({ status: "failed", reason: "invalid-structured-output" });
  });
});
