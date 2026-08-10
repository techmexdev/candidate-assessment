import {
  NoObjectGeneratedError,
  Output,
  generateText,
  jsonSchema,
  type LanguageModel,
} from "ai";
import type { WorkoutComposer, WorkoutComposerInput, WorkoutComposerResult } from "../../application/ports/workout-composer";
import { parseWorkoutProposal, WORKOUT_PROPOSAL_JSON_SCHEMA } from "./schemas";
import { bindWorkoutProposalCitations, createWorkoutComposerAgentInput } from "./tools";

export type AiSdkWorkoutComposerOptions = {
  readonly model: LanguageModel;
  readonly timeoutMs?: number;
};

const SYSTEM_INSTRUCTIONS = [
  "Compose exactly one workout from the supplied canonical candidates.",
  "Candidate eligibility and safety status are authoritative and cannot be changed.",
  "Return warm-up, main, and cool-down sections only.",
  "The timingBudget in the input is authoritative: calculate work plus between-set rest for every item, then adjust sets and durations until totalSeconds is within the target, allowing at most 60 seconds of underfill and no overflow.",
  "Use each candidate only in an allowed section, stay within its dose and rest bounds, and do not repeat an exercise across sections.",
  "Each item must cite one or more opaque citation references supplied on that exact candidate.",
  "Do not infer member facts, graph facts, exclusions, identities, or authorization data.",
].join(" ");

/** AI SDK 7 outer adapter. The application injects the provider/model; no provider types cross the port. */
export function createAiSdkWorkoutComposer(options: AiSdkWorkoutComposerOptions): WorkoutComposer {
  const timeoutMs = options.timeoutMs ?? 5_000;
  return {
    async compose(input: Readonly<WorkoutComposerInput>, composeOptions): Promise<WorkoutComposerResult> {
      try {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const abortSignal = composeOptions?.signal
          ? AbortSignal.any([composeOptions.signal, timeoutSignal])
          : timeoutSignal;
        const agentInput = createWorkoutComposerAgentInput(input);
        const result = await generateText({
          model: options.model,
          system: SYSTEM_INSTRUCTIONS,
          prompt: JSON.stringify({
            ...agentInput,
            timingBudget: {
              targetSeconds: input.canonicalIntent.requestedDurationMinutes * 60,
              maxUnderfillSeconds: 60,
              maxOverflowSeconds: 0,
            },
          }),
          output: Output.object({
            name: "workout_proposal",
            description: "A workout composed only from the supplied eligible candidates.",
            schema: jsonSchema(WORKOUT_PROPOSAL_JSON_SCHEMA),
          }),
          abortSignal,
        });
        const parsed = parseWorkoutProposal(result.output);
        const rebound = parsed.status === "valid" ? bindWorkoutProposalCitations(parsed.proposal, input) : undefined;
        return rebound
          ? { status: "proposed", proposal: rebound }
          : { status: "failed", reason: "invalid-structured-output" };
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
