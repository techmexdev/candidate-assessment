import type { CatalogSafetyDecision, CatalogSafetyReadyResult } from "../../src/domain/contracts/catalog-safety";
import type {
  WorkoutCompositionCandidate,
  WorkoutCompositionProposal,
  WorkoutCompositionValidationInput,
} from "../../src/domain/policies/workout-composition";
import type { WorkoutDecision } from "../../src/domain/contracts/workout-provenance";

export const TEST_MOVEMENT_REVISION = "movement-revision:workout-test";
export const TEST_MEMBER_REVISION = "member-revision:workout-test";

export function catalogDecision(
  exerciseConceptId: string,
  classification: CatalogSafetyDecision["classification"] = "allowed",
  overrides: Partial<CatalogSafetyDecision> = {},
): CatalogSafetyDecision {
  return {
    movementGraphRevisionId: TEST_MOVEMENT_REVISION,
    memberContextRevisionId: TEST_MEMBER_REVISION,
    exerciseConceptId,
    exerciseAssertionId: `assertion:${exerciseConceptId}`,
    classification,
    loadedLaterality: "unknown",
    preferenceRank: classification === "downranked" ? 1 : 0,
    contributions: classification === "allowed" ? [] : [{
      kind: "preference",
      effect: "down-rank",
      matchKind: "exact-exercise",
      resolvedConceptId: exerciseConceptId,
      rankPenalty: 1,
      assertionIds: [`assertion:path:${exerciseConceptId}`],
      evidenceIds: [`evidence:${exerciseConceptId}`],
    }],
    assertionIds: [`assertion:${exerciseConceptId}`, `assertion:path:${exerciseConceptId}`],
    evidenceIds: [`evidence:${exerciseConceptId}`],
    ...overrides,
  };
}

export function catalogResult(decisions: readonly CatalogSafetyDecision[]): CatalogSafetyReadyResult {
  const by = (classification: CatalogSafetyDecision["classification"]) => decisions
    .filter((decision) => decision.classification === classification);
  return {
    status: "ready",
    movementGraphRevisionId: TEST_MOVEMENT_REVISION,
    memberContextRevisionId: TEST_MEMBER_REVISION,
    authority: "canonical",
    decisions,
    excluded: by("excluded"),
    caution: by("caution"),
    downranked: by("downranked"),
    allowed: by("allowed"),
    assertionIds: [...new Set(decisions.flatMap((decision) => decision.assertionIds))].sort(),
    evidenceIds: [...new Set(decisions.flatMap((decision) => decision.evidenceIds))].sort(),
  };
}

export function compositionCandidate(
  exerciseConceptId: string,
  overrides: Partial<WorkoutCompositionCandidate> = {},
): WorkoutCompositionCandidate {
  return {
    exerciseConceptId,
    allowedSections: ["warm-up", "main", "cool-down"],
    doseBounds: {
      minimumSets: 1,
      maximumSets: 12,
      minimumWorkSecondsPerSet: 30,
      maximumWorkSecondsPerSet: 3_600,
      minimumRestSeconds: 0,
      maximumRestSeconds: 300,
    },
    transitionSeconds: 0,
    ...overrides,
  };
}

export function proposalForMinutes(minutes: 30 | 45 | 60): WorkoutCompositionProposal {
  const seconds = minutes * 60;
  const warmup = Math.round(seconds * 0.2);
  const cooldown = Math.round(seconds * 0.15);
  const main = seconds - warmup - cooldown;
  const item = (exerciseConceptId: string, workSeconds: number, rationale: string) => ({
    exerciseConceptId,
    dose: { kind: "timed" as const, sets: 1, workSecondsPerSet: workSeconds },
    restSeconds: 0,
    rationale,
  });
  return {
    schemaVersion: "workout-proposal/v1",
    sections: [
      { kind: "warm-up", items: [item("exercise:warm-up", warmup, "Prepare movement quality")] },
      { kind: "main", items: [item("exercise:main", main, "Address the session intent")] },
      { kind: "cool-down", items: [item("exercise:cool-down", cooldown, "Return toward baseline")] },
    ],
  };
}

export function validationInput(
  minutes: 30 | 45 | 60 = 45,
  proposal: WorkoutCompositionProposal = proposalForMinutes(minutes),
): WorkoutCompositionValidationInput {
  const decisions = [
    catalogDecision("exercise:warm-up"),
    catalogDecision("exercise:main", "caution"),
    catalogDecision("exercise:cool-down", "downranked"),
    catalogDecision("exercise:excluded", "excluded"),
  ];
  return {
    runId: "workout-run:test",
    claimGeneration: 3,
    requestedDurationMinutes: minutes,
    movementGraphRevisionId: TEST_MOVEMENT_REVISION,
    memberContextRevisionId: TEST_MEMBER_REVISION,
    revisionSealDigest: "sha256:revision-seals",
    requestDigest: "sha256:request",
    resolvedConstraintDigest: "sha256:constraints",
    safetyEnvelopeDigest: "sha256:safety-envelope",
    completeDecisionSetDigest: "sha256:decision-set",
    modelProposalDigest: "sha256:proposal",
    workoutPayloadDigest: "sha256:workout",
    provenanceDigest: "sha256:provenance",
    proposal,
    candidates: decisions.map((decision) => compositionCandidate(decision.exerciseConceptId)),
    catalogSafety: catalogResult(decisions),
  };
}

export function workoutDecision(
  exerciseConceptId: string,
  kind: WorkoutDecision["kind"] = "selected",
  overrides: Partial<WorkoutDecision> = {},
): WorkoutDecision {
  return {
    decisionId: `decision:${exerciseConceptId}:${kind}`,
    kind,
    exerciseConceptId,
    movementGraphRevisionId: TEST_MOVEMENT_REVISION,
    memberContextRevisionId: TEST_MEMBER_REVISION,
    sourceAssertionIds: [`assertion:${exerciseConceptId}`],
    contributingPathIds: [`path:${exerciseConceptId}`],
    evidenceIds: [`evidence:${exerciseConceptId}`],
    explanation: `${kind} by deterministic policy`,
    ...overrides,
  };
}
