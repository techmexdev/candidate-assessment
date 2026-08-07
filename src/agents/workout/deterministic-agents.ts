import type { WorkoutComposer, WorkoutComposerInput, WorkoutComposerProposal, WorkoutComposerResult } from "../../application/ports/workout-composer";
import type { WorkoutReviewInput, WorkoutReviewer, WorkoutReviewerResult } from "../../application/ports/workout-reviewer";
import { WORKOUT_REVIEW_DEFECTS } from "../../application/ports/workout-reviewer";

function plannedSeconds(dose: WorkoutComposerProposal["sections"][number]["items"][number]["dose"]) {
  return dose.kind === "timed"
    ? dose.sets * dose.workSecondsPerSet
    : dose.sets * dose.repetitionsPerSet * dose.secondsPerRepetition;
}

function candidateCitation(input: WorkoutComposerInput, exerciseConceptId: string) {
  return input.candidates.find((candidate) => candidate.exerciseConceptId === exerciseConceptId)?.citationIds[0];
}

/**
 * Credential-free demo composer. It deliberately uses the same application
 * port as the provider adapter and produces a stable three-section proposal.
 */
export function createDeterministicWorkoutComposer(): WorkoutComposer {
  return {
    async compose(input, options): Promise<WorkoutComposerResult> {
      if (options?.signal?.aborted || input.candidates.length < 3) {
        return { status: "failed", reason: options?.signal?.aborted ? "timeout" : "invalid-structured-output" };
      }
      const selected = input.candidates.slice(0, 3);
      const total = input.canonicalIntent.requestedDurationMinutes * 60;
      const budgets = [Math.round(total * 0.2), total - Math.round(total * 0.2) - Math.round(total * 0.15), Math.round(total * 0.15)];
      const kinds = ["warm-up", "main", "cool-down"] as const;
      const sections = selected.map((candidate, index) => {
        const citationId = candidateCitation(input, candidate.exerciseConceptId);
        return {
          kind: kinds[index]!,
          items: [{
            exerciseConceptId: candidate.exerciseConceptId,
            dose: { kind: "timed" as const, sets: 1, workSecondsPerSet: budgets[index]! },
            restSeconds: 0,
            rationale: "Deterministic connected-demo composition",
            citationIds: citationId ? [citationId] : [],
          }],
        };
      });
      return {
        status: "proposed",
        proposal: { schemaVersion: "workout-proposal/v1", sections },
      };
    },
  };
}

/**
 * Deterministic quality critic used by the one-command demo and unit tests.
 * Safety and candidate membership are intentionally outside this role.
 */
export function createDeterministicWorkoutReviewer(): WorkoutReviewer {
  return {
    async review(input: Readonly<WorkoutReviewInput>, options): Promise<WorkoutReviewerResult> {
      if (options?.signal?.aborted) return { status: "failed", reason: "timeout" };
      const defects = new Set<(typeof WORKOUT_REVIEW_DEFECTS)[number]>();
      const sectionKinds = new Set(input.proposal.sections.map((section) => section.kind));
      if (sectionKinds.size !== 3 || !["warm-up", "main", "cool-down"].every((kind) => sectionKinds.has(kind as never))) {
        defects.add("section-coverage");
      }
      const sectionSeconds = input.proposal.sections.map((section) => section.items.reduce((sum, item) => sum + plannedSeconds(item.dose), 0));
      const total = sectionSeconds.reduce((sum, seconds) => sum + seconds, 0);
      if (total > 0 && (sectionSeconds[0]! < total * 0.1 || sectionSeconds[0]! > total * 0.35
        || sectionSeconds[2]! < total * 0.05 || sectionSeconds[2]! > total * 0.3)) {
        defects.add("dose-imbalance");
      }
      const exerciseIds = input.proposal.sections.flatMap((section) => section.items.map((item) => item.exerciseConceptId));
      if (new Set(exerciseIds).size !== exerciseIds.length) defects.add("redundant-pattern");
      if (input.proposal.sections.some((section) => section.items.some((item) => item.rationale.trim().length < 12))) {
        defects.add("rationale-quality");
      }
      return defects.size === 0
        ? { status: "accepted" }
        : { status: "revise", defects: [...defects].sort() };
    },
  };
}

