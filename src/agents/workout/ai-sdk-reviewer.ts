import { NoObjectGeneratedError, Output, generateText, jsonSchema, type LanguageModel } from "ai";
import type { WorkoutReviewer, WorkoutReviewInput, WorkoutReviewerResult } from "../../application/ports/workout-reviewer";
import { parseWorkoutReviewerResult } from "../../application/ports/workout-reviewer";

export type AiSdkWorkoutReviewerOptions = {
  readonly model: LanguageModel;
  readonly timeoutMs?: number;
};

type JsonSchema = Readonly<Record<string, unknown>>;

const REVIEW_JSON_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["status", "defects"],
  properties: {
    status: { type: "string", enum: ["accepted", "revise"] },
    defects: {
      type: "array",
      maxItems: 4,
      items: { type: "string", enum: ["dose-imbalance", "section-coverage", "redundant-pattern", "rationale-quality"] },
    },
  },
});

const SYSTEM_INSTRUCTIONS = [
  "Review composition quality only inside the supplied candidate envelope.",
  "You may accept or request one revision using only the four allowlisted defect codes.",
  "Never propose candidates, safety changes, graph facts, identities, or authorization changes.",
  "Do not infer or request member facts; deterministic validation remains final authority.",
].join(" ");

/** AI SDK outer adapter. The packet is already privacy-minimized at the port boundary. */
export function createAiSdkWorkoutReviewer(options: AiSdkWorkoutReviewerOptions): WorkoutReviewer {
  const timeoutMs = options.timeoutMs ?? 5_000;
  return {
    async review(input: Readonly<WorkoutReviewInput>, reviewOptions): Promise<WorkoutReviewerResult> {
      try {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const abortSignal = reviewOptions?.signal
          ? AbortSignal.any([reviewOptions.signal, timeoutSignal])
          : timeoutSignal;
        const result = await generateText({
          model: options.model,
          system: SYSTEM_INSTRUCTIONS,
          prompt: JSON.stringify(input),
          output: Output.object({
            name: "workout_composition_review",
            description: "A bounded quality review with no safety authority.",
            schema: jsonSchema(REVIEW_JSON_SCHEMA),
          }),
          abortSignal,
        });
        return parseWorkoutReviewerResult(result.output, input.candidates.map((candidate) => candidate.exerciseConceptId));
      } catch (error) {
        if (NoObjectGeneratedError.isInstance(error)) return { status: "failed", reason: "invalid-structured-output" };
        if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
          return { status: "failed", reason: "timeout" };
        }
        return { status: "failed", reason: "unavailable" };
      }
    },
  };
}
