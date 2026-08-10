import { createOpenAI } from "@ai-sdk/openai";
import { createGateway } from "ai";

export type AiProvider = "gateway" | "openai";
export type AiEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Select a model backend without exposing provider credentials to application code.
 * An explicit AI_PROVIDER wins; otherwise a configured OpenAI key opts into the
 * direct provider so local users do not need a Gateway-specific key or model ID.
 */
export function resolveAiProvider(environment: AiEnvironment = process.env): AiProvider {
  const configured = environment.AI_PROVIDER?.trim().toLowerCase();
  if (configured === "openai" || configured === "gateway") return configured;
  if (configured) throw new Error("AI_PROVIDER must be either openai or gateway");
  return environment.OPENAI_API_KEY?.trim() ? "openai" : "gateway";
}

export function aiApiKeyName(provider: AiProvider): "OPENAI_API_KEY" | "AI_GATEWAY_API_KEY" {
  return provider === "openai" ? "OPENAI_API_KEY" : "AI_GATEWAY_API_KEY";
}

export function configuredAiApiKey(environment: AiEnvironment, provider: AiProvider): string | undefined {
  return environment[aiApiKeyName(provider)]?.trim() || undefined;
}

export function createConfiguredLanguageModel(input: {
  readonly modelId: string;
  readonly provider?: AiProvider;
  readonly apiKey?: string;
  readonly environment?: AiEnvironment;
}) {
  const environment = input.environment ?? process.env;
  const provider = input.provider ?? resolveAiProvider(environment);
  const apiKey = input.apiKey?.trim() || configuredAiApiKey(environment, provider);
  if (!apiKey) throw new Error(`${aiApiKeyName(provider)} must be configured for the ${provider} model provider`);
  const modelId = input.modelId.trim();
  if (!modelId) throw new Error("Model ID must be configured for the model provider");
  return provider === "openai"
    ? createOpenAI({ apiKey })(modelId)
    : createGateway({ apiKey })(modelId);
}
