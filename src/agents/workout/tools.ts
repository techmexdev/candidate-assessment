import type { CatalogSafetyReadyResult } from "../../domain/contracts/catalog-safety";
import type { WorkoutCompositionCandidate } from "../../domain/policies/workout-composition";
import type { WorkoutComposerInput } from "../../application/ports/workout-composer";

export type CreateWorkoutComposerInput = {
  readonly canonicalIntent: WorkoutComposerInput["canonicalIntent"];
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly resolvedConstraintDigest: string;
  readonly evaluationConstraintDigest: string;
  readonly safetyEnvelopeDigest: string;
  readonly catalogSafety: CatalogSafetyReadyResult;
  readonly candidateProfiles: readonly WorkoutCompositionCandidate[];
};

function reasonCodes(decision: CatalogSafetyReadyResult["decisions"][number]) {
  return [...new Set([
    decision.classification,
    ...decision.contributions.map((contribution) => `${contribution.kind}:${contribution.effect}`),
  ])].sort();
}

/** Builds the only model-visible payload. Hidden and excluded candidates never enter it. */
export function createWorkoutComposerInput(input: CreateWorkoutComposerInput): WorkoutComposerInput {
  if (input.catalogSafety.authority !== "canonical"
    || input.catalogSafety.movementGraphRevisionId !== input.movementGraphRevisionId
    || input.catalogSafety.memberContextRevisionId !== input.memberContextRevisionId) {
    throw new Error("catalog safety envelope is not authoritative");
  }
  const profiles = new Map(input.candidateProfiles.map((candidate) => [candidate.exerciseConceptId, candidate]));
  const candidates = input.catalogSafety.decisions.flatMap((decision) => {
    if (decision.classification === "excluded") return [];
    const profile = profiles.get(decision.exerciseConceptId);
    if (!profile || decision.evidenceIds.length === 0 || decision.assertionIds.length === 0) return [];
    return [{
      exerciseConceptId: decision.exerciseConceptId,
      allowedSections: [...profile.allowedSections],
      doseBounds: { ...profile.doseBounds },
      safetyStatus: decision.classification,
      reasonCodes: reasonCodes(decision),
      citationIds: [...new Set([...decision.evidenceIds, ...decision.assertionIds])].sort(),
    }];
  });
  return Object.freeze({
    schemaVersion: "workout-composer-input/v1",
    authority: Object.freeze({
      movementGraphRevisionId: input.movementGraphRevisionId,
      memberContextRevisionId: input.memberContextRevisionId,
      resolvedConstraintDigest: input.resolvedConstraintDigest,
      evaluationConstraintDigest: input.evaluationConstraintDigest,
      safetyEnvelopeDigest: input.safetyEnvelopeDigest,
    }),
    canonicalIntent: Object.freeze({
      focusConceptIds: Object.freeze([...input.canonicalIntent.focusConceptIds]),
      requestedDurationMinutes: input.canonicalIntent.requestedDurationMinutes,
    }),
    candidates: Object.freeze(candidates.map((candidate) => Object.freeze(candidate))),
  });
}

export function proposalCitationsAreGrounded(proposal: { readonly sections: readonly { readonly items: readonly { readonly exerciseConceptId: string; readonly citationIds: readonly string[] }[] }[] }, input: WorkoutComposerInput) {
  const candidates = new Map(input.candidates.map((candidate) => [candidate.exerciseConceptId, new Set(candidate.citationIds)]));
  return proposal.sections.every((section) => section.items.every((item) => {
    const citations = candidates.get(item.exerciseConceptId);
    return citations !== undefined && item.citationIds.length > 0 && item.citationIds.every((id) => citations.has(id));
  }));
}
