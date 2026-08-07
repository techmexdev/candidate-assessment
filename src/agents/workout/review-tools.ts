import type { WorkoutComposerInput, WorkoutComposerProposal } from "../../application/ports/workout-composer";
import type { WorkoutReviewInput } from "../../application/ports/workout-reviewer";

/** Build the privacy-minimized packet used by either review implementation. */
export function createWorkoutReviewInput(
  input: Readonly<WorkoutComposerInput>,
  proposal: Readonly<WorkoutComposerProposal>,
): WorkoutReviewInput {
  return Object.freeze({
    schemaVersion: "workout-review-input/v1" as const,
    canonicalIntent: Object.freeze({
      focusConceptIds: Object.freeze([...input.canonicalIntent.focusConceptIds]),
      requestedDurationMinutes: input.canonicalIntent.requestedDurationMinutes,
    }),
    candidates: Object.freeze(input.candidates.map((candidate) => Object.freeze({
      exerciseConceptId: candidate.exerciseConceptId,
      allowedSections: Object.freeze([...candidate.allowedSections]),
      doseBounds: Object.freeze({ ...candidate.doseBounds }),
      safetyStatus: candidate.safetyStatus,
      reasonCodes: Object.freeze([...candidate.reasonCodes]),
    }))),
    proposal: Object.freeze({
      schemaVersion: "workout-proposal/v1" as const,
      sections: Object.freeze(proposal.sections.map((section) => Object.freeze({
        kind: section.kind,
        items: Object.freeze(section.items.map((item) => Object.freeze({
          exerciseConceptId: item.exerciseConceptId,
          dose: Object.freeze({ ...item.dose }),
          restSeconds: item.restSeconds,
          rationale: item.rationale,
        }))),
      }))),
    }),
  });
}

export function workoutReviewInputCandidateIds(input: Readonly<WorkoutReviewInput>) {
  return input.candidates.map((candidate) => candidate.exerciseConceptId);
}

