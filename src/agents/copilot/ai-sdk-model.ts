import { NoObjectGeneratedError, Output, generateText, jsonSchema, type LanguageModel } from "ai";
import type { CopilotModel, CopilotModelInput, CopilotModelResult } from "../../application/ports/copilot-model";
import { decodeCopilotModelCandidate } from "../../application/ports/copilot-model";
import { COPILOT_INTENT_SYSTEM_INSTRUCTIONS } from "../copilot-prompt";

export type AiSdkCopilotModelOptions = {
  readonly model: LanguageModel;
  readonly timeoutMs?: number;
};

function schema(input: Readonly<CopilotModelInput>): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "intentId", "selections"],
    properties: {
      schemaVersion: { const: "copilot-model-candidate/v1" },
      intentId: { enum: input.intentIds },
      selections: { type: "array", maxItems: 0, items: false },
    },
  };
}

/** AI SDK outer edge: structured ID classification only, with no tool registry or retained telemetry payload. */
export function createAiSdkCopilotModel(options: AiSdkCopilotModelOptions): CopilotModel {
  const timeoutMs = options.timeoutMs ?? 1_500;
  return {
    async select(input, selectOptions): Promise<CopilotModelResult> {
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        const abortSignal = selectOptions?.signal ? AbortSignal.any([selectOptions.signal, timeout]) : timeout;
        const result = await generateText({
          model: options.model,
          system: COPILOT_INTENT_SYSTEM_INSTRUCTIONS,
          prompt: JSON.stringify(input),
          output: Output.object({
            name: "copilot_intent_selection",
            description: "One canonical Copilot intent ID and no authored content.",
            schema: jsonSchema(schema(input)),
          }),
          maxRetries: 0,
          abortSignal,
          telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
        });
        const decoded = decodeCopilotModelCandidate(result.output, {
          intentIds: input.intentIds,
          sectionIds: [],
          evidenceIds: [],
          actionIds: [],
        });
        return decoded.status === "accepted"
          ? { status: "selected", candidate: decoded.candidate }
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
