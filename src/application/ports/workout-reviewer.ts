import type { WorkoutComposerInput, WorkoutComposerProposal } from "./workout-composer";
import type { WorkoutReviewTrace } from "../../domain/contracts/workout-provenance";

/**
 * The reviewer sees a projection of the composition envelope, never the
 * authority envelope itself. In particular, citation/evidence IDs and graph
 * revision identifiers stay on the orchestrator side of this port.
 */
export type WorkoutReviewInput = {
  readonly schemaVersion: "workout-review-input/v1";
  readonly canonicalIntent: Readonly<WorkoutComposerInput["canonicalIntent"]>;
  readonly candidates: readonly {
    readonly exerciseConceptId: string;
    readonly allowedSections: readonly WorkoutComposerInput["candidates"][number]["allowedSections"][number][];
    readonly doseBounds: Readonly<WorkoutComposerInput["candidates"][number]["doseBounds"]>;
    readonly safetyStatus: WorkoutComposerInput["candidates"][number]["safetyStatus"];
    readonly reasonCodes: readonly string[];
  }[];
  readonly proposal: {
    readonly schemaVersion: "workout-proposal/v1";
    readonly sections: readonly {
      readonly kind: WorkoutComposerProposal["sections"][number]["kind"];
      readonly items: readonly {
        readonly exerciseConceptId: string;
        readonly dose: WorkoutComposerProposal["sections"][number]["items"][number]["dose"];
        readonly restSeconds: number;
        readonly rationale: string;
      }[];
    }[];
  };
};

export const WORKOUT_REVIEW_DEFECTS = Object.freeze([
  "dose-imbalance",
  "section-coverage",
  "redundant-pattern",
  "rationale-quality",
] as const);

export type WorkoutReviewDefect = (typeof WORKOUT_REVIEW_DEFECTS)[number];

export type WorkoutReviewerResult =
  | { readonly status: "accepted" }
  | {
      readonly status: "revise";
      readonly defects: readonly WorkoutReviewDefect[];
      /** Optional diagnostic echo used to detect an attempted envelope widening. */
      readonly requestedCandidateConceptIds?: readonly string[];
      /** A reviewer may not change a deterministic safety decision. */
      readonly safetyOverrides?: readonly string[];
    }
  | { readonly status: "failed"; readonly reason: "unavailable" | "timeout" | "invalid-structured-output" };

export type WorkoutReviewer = {
  review(input: Readonly<WorkoutReviewInput>, options?: { readonly signal?: AbortSignal }): Promise<WorkoutReviewerResult>;
};

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return expected.length === actual.length && expected.every((key, index) => key === actual[index]);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Validate the untrusted response before it can influence recomposition. */
export function parseWorkoutReviewerResult(
  value: unknown,
  eligibleCandidateConceptIds: readonly string[],
): WorkoutReviewerResult {
  const candidate = record(value);
  if (!candidate || typeof candidate.status !== "string") {
    return { status: "failed", reason: "invalid-structured-output" };
  }
  if (candidate.status === "accepted") {
    return exactKeys(candidate, ["status"])
      ? { status: "accepted" }
      : { status: "failed", reason: "invalid-structured-output" };
  }
  if (candidate.status === "failed") {
    return exactKeys(candidate, ["status", "reason"])
      && ["unavailable", "timeout", "invalid-structured-output"].includes(String(candidate.reason))
      ? { status: "failed", reason: candidate.reason as "unavailable" | "timeout" | "invalid-structured-output" }
      : { status: "failed", reason: "invalid-structured-output" };
  }
  if (candidate.status !== "revise") return { status: "failed", reason: "invalid-structured-output" };
  const allowedKeys = ["status", "defects", "requestedCandidateConceptIds", "safetyOverrides"];
  if (!exactKeys(candidate, allowedKeys.filter((key) => candidate[key] !== undefined))) {
    return { status: "failed", reason: "invalid-structured-output" };
  }
  if (!Array.isArray(candidate.defects) || candidate.defects.length < 1 || candidate.defects.length > 4
    || candidate.defects.some((defect) => typeof defect !== "string" || !WORKOUT_REVIEW_DEFECTS.includes(defect as WorkoutReviewDefect))
    || new Set(candidate.defects).size !== candidate.defects.length) {
    return { status: "failed", reason: "invalid-structured-output" };
  }
  const eligible = new Set(eligibleCandidateConceptIds);
  if (candidate.requestedCandidateConceptIds !== undefined) {
    if (!Array.isArray(candidate.requestedCandidateConceptIds)
      || candidate.requestedCandidateConceptIds.length > eligible.size
      || candidate.requestedCandidateConceptIds.some((id) => typeof id !== "string" || !eligible.has(id))) {
      return { status: "failed", reason: "invalid-structured-output" };
    }
  }
  if (candidate.safetyOverrides !== undefined) {
    if (!Array.isArray(candidate.safetyOverrides) || candidate.safetyOverrides.length > 0) {
      return { status: "failed", reason: "invalid-structured-output" };
    }
  }
  return {
    status: "revise",
    defects: [...candidate.defects] as WorkoutReviewDefect[],
    ...(candidate.requestedCandidateConceptIds !== undefined
      ? { requestedCandidateConceptIds: [...candidate.requestedCandidateConceptIds] as string[] }
      : {}),
    ...(candidate.safetyOverrides !== undefined ? { safetyOverrides: [] } : {}),
  };
}

export function reviewTraceForResult(
  result: WorkoutReviewerResult,
  proposalDigests: readonly string[],
  recompositionCount: 0 | 1,
): WorkoutReviewTrace {
  if (result.status === "accepted") {
    return {
      schemaVersion: "workout-review-trace/v1",
      outcome: "accepted",
      defects: [],
      recompositionCount,
      proposalDigests: [...proposalDigests],
    };
  }
  if (result.status === "revise") {
    return {
      schemaVersion: "workout-review-trace/v1",
      outcome: recompositionCount > 0 ? "recomposed" : "ignored",
      defects: [...result.defects],
      recompositionCount,
      proposalDigests: [...proposalDigests],
    };
  }
  return {
    schemaVersion: "workout-review-trace/v1",
    outcome: "ignored",
    defects: [],
    recompositionCount,
    proposalDigests: [...proposalDigests],
    ignoredReason: result.reason,
  };
}
