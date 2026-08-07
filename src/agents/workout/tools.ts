import type { CatalogSafetyReadyResult } from "../../domain/contracts/catalog-safety";
import type { WorkoutCompositionCandidate } from "../../domain/policies/workout-composition";
import type { WorkoutComposerInput, WorkoutComposerProposal } from "../../application/ports/workout-composer";

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

/** Model-facing projection. Citation IDs stay server-side and are rebound after parsing. */
export type WorkoutComposerAgentInput = {
  readonly schemaVersion: "workout-composer-agent-input/v1";
  readonly canonicalIntent: WorkoutComposerInput["canonicalIntent"];
  readonly candidates: readonly (Omit<WorkoutComposerInput["candidates"][number], "citationIds"> & {
    readonly citationRefs: readonly string[];
  })[];
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

export function createWorkoutComposerAgentInput(input: Readonly<WorkoutComposerInput>): WorkoutComposerAgentInput {
  return Object.freeze({
    schemaVersion: "workout-composer-agent-input/v1" as const,
    canonicalIntent: Object.freeze({
      focusConceptIds: Object.freeze([...input.canonicalIntent.focusConceptIds]),
      requestedDurationMinutes: input.canonicalIntent.requestedDurationMinutes,
    }),
    candidates: Object.freeze(input.candidates.map((candidate, index) => Object.freeze({
      exerciseConceptId: candidate.exerciseConceptId,
      allowedSections: Object.freeze([...candidate.allowedSections]),
      doseBounds: Object.freeze({ ...candidate.doseBounds }),
      safetyStatus: candidate.safetyStatus,
      reasonCodes: Object.freeze([...candidate.reasonCodes]),
      citationRefs: Object.freeze([`candidate-ref:${index + 1}`]),
    }))),
  });
}

/** Rebind opaque model references to the authoritative server-side citations. */
export function bindWorkoutProposalCitations(
  proposal: Readonly<WorkoutComposerProposal>,
  input: Readonly<WorkoutComposerInput>,
) {
  const refs = new Map(input.candidates.map((candidate, index) => [
    candidate.exerciseConceptId,
    { ref: `candidate-ref:${index + 1}`, citations: [...candidate.citationIds] },
  ]));
  const sections = proposal.sections.map((section) => ({
    ...section,
    items: section.items.map((item) => {
      const itemWithCitations = item as typeof item & { readonly citationIds: readonly string[] };
      const binding = refs.get(itemWithCitations.exerciseConceptId);
      if (!binding || itemWithCitations.citationIds.length === 0 || itemWithCitations.citationIds.some((ref: string) => ref !== binding.ref)) return undefined;
      return { ...itemWithCitations, citationIds: binding.citations };
    }),
  }));
  if (sections.some((section) => section.items.some((item) => item === undefined))) return undefined;
  return {
    ...proposal,
    sections: sections.map((section) => ({ ...section, items: section.items as Exclude<typeof section.items[number], undefined>[] })),
  };
}

export function proposalCitationsAreGrounded(proposal: { readonly sections: readonly { readonly items: readonly { readonly exerciseConceptId: string; readonly citationIds: readonly string[] }[] }[] }, input: WorkoutComposerInput) {
  const candidates = new Map(input.candidates.map((candidate) => [candidate.exerciseConceptId, new Set(candidate.citationIds)]));
  return proposal.sections.every((section) => section.items.every((item) => {
    const citations = candidates.get(item.exerciseConceptId);
    return citations !== undefined && item.citationIds.length > 0 && item.citationIds.every((id) => citations.has(id));
  }));
}
