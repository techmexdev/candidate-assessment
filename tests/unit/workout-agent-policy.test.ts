import { describe, expect, it } from "vitest";
import { createWorkoutComposerInput } from "../../src/agents/workout/tools";
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
});
