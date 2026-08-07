import { createGateway } from "ai";
import { createAiSdkCopilotModel } from "../../agents/copilot/ai-sdk-model";
import { createCopilotRuntime } from "../../agents/copilot-runtime";
import { createMemberContextRetrieval } from "../../agents/tools/member-context-retrieval";
import type { CopilotModel } from "../../application/ports/copilot-model";
import {
  createAnswerCopilotQuestion,
  type AnswerCopilotQuestionDependencies,
} from "../../application/use-cases/answer-copilot-question";
import type { MemberContextReadProvider } from "../../domain/contracts/member-context-queries";
import { createNeo4jClient } from "../../graph/neo4j/client";
import { createNeo4jMemberContextReadProvider } from "../../graph/repositories/neo4j-member-context";
import {
  createMockCoachSessionAuthority,
  type MockCoachSession,
} from "../auth/mock-coach-session";
import {
  COPILOT_CONTINUATION_MAX_TTL_MS,
  copilotContinuationSecret,
  createCopilotContinuationAuthority,
} from "./continuation-token";

type Environment = Readonly<Record<string, string | undefined>>;

export type CopilotComposition = {
  readonly resolveSession: (request: Request) => Promise<MockCoachSession>;
  readonly answer: ReturnType<typeof createAnswerCopilotQuestion>;
};

export type CopilotApplicationDependencies = {
  readonly memberContext: MemberContextReadProvider;
  readonly authorizeMemberContext: AnswerCopilotQuestionDependencies["authorizeMemberContext"];
  readonly model: CopilotModel;
  readonly continuation: ReturnType<typeof createCopilotContinuationAuthority>;
  readonly now?: () => string;
  readonly applicationDeadlineMs?: number;
  readonly runtimeDeadlineMs?: number;
};

/** Canonical application composition. Tests inject graph/model ports; production supplies Neo4j and AI Gateway. */
export function createCopilotApplication(dependencies: CopilotApplicationDependencies) {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const runtime = createCopilotRuntime({
    model: dependencies.model,
    retrieve: (request) => createMemberContextRetrieval({
      // Validate step scope against the already authorized sealed handle. Its
      // application wrapper separately rechecks the opaque grant per read.
      reauthorize: (scope) => scope.coachId === request.handle.coachId
        && scope.memberId === request.handle.memberId
        && scope.contextRevisionId === request.handle.contextRevisionId,
    }).retrieve(request),
    signContinuation: dependencies.continuation.sign,
    now,
    deadlineMs: dependencies.runtimeDeadlineMs ?? 4_500,
    continuationTtlMs: COPILOT_CONTINUATION_MAX_TTL_MS,
  });
  return createAnswerCopilotQuestion({
    memberContext: dependencies.memberContext,
    authorizeMemberContext: dependencies.authorizeMemberContext,
    runtime,
    verifyContinuation: dependencies.continuation.verify,
    now,
    deadlineMs: dependencies.applicationDeadlineMs ?? 4_800,
  });
}

function configuredModel(environment: Environment): CopilotModel {
  const modelId = environment.COPILOT_MODEL_ID?.trim();
  const apiKey = environment.AI_GATEWAY_API_KEY?.trim();
  if (!modelId || !apiKey) {
    return Object.freeze({
      select: async () => ({ status: "failed" as const, reason: "unavailable" as const }),
    });
  }
  return createAiSdkCopilotModel({
    model: createGateway({ apiKey })(modelId),
    timeoutMs: 1_500,
  });
}

export function createConfiguredCopilotComposition(
  environment: Environment = process.env,
): CopilotComposition {
  const runtimeEnvironment = environment.NODE_ENV ?? "production";
  const secret = copilotContinuationSecret(runtimeEnvironment, environment.COPILOT_CONTINUATION_SECRET);
  const now = () => new Date().toISOString();
  const sessionAuthority = createMockCoachSessionAuthority({
    secret: environment.COPILOT_SESSION_SECRET?.trim() || secret,
    environment: runtimeEnvironment,
    now,
    localCoachId: environment.COPILOT_LOCAL_COACH_ID?.trim() || undefined,
    localMemberIds: environment.COPILOT_LOCAL_MEMBER_IDS
      ?.split(",")
      .map((memberId) => memberId.trim())
      .filter(Boolean),
    testBypass: environment.WORKOUT_TEST_BYPASS === "1",
  });
  const client = createNeo4jClient({
    environment: runtimeEnvironment,
    ...(environment.NEO4J_URI ? { uri: environment.NEO4J_URI } : {}),
    ...(environment.NEO4J_USERNAME ? { username: environment.NEO4J_USERNAME } : {}),
    ...(environment.NEO4J_PASSWORD ? { password: environment.NEO4J_PASSWORD } : {}),
    ...(environment.NEO4J_DATABASE ? { database: environment.NEO4J_DATABASE } : {}),
  });
  const continuation = createCopilotContinuationAuthority({ secret, now });
  return Object.freeze({
    resolveSession: sessionAuthority.resolveSession,
    answer: createCopilotApplication({
      memberContext: createNeo4jMemberContextReadProvider(client),
      authorizeMemberContext: sessionAuthority.authorize,
      model: configuredModel(environment),
      continuation,
      now,
    }),
  });
}

let configured: CopilotComposition | undefined;

function composition(): CopilotComposition {
  configured ??= createConfiguredCopilotComposition(process.env);
  return configured;
}

export const configuredCopilotComposition: CopilotComposition = Object.freeze({
  resolveSession: async (request) => {
    try { return await composition().resolveSession(request); } catch { return { status: "unavailable" }; }
  },
  answer: async (input, options) => {
    try { return await composition().answer(input, options); } catch {
      return {
        status: "unavailable",
        requestId: input.request.requestId,
        code: "graph-unavailable",
        retryable: true,
        message: "Copilot is temporarily unavailable.",
      };
    }
  },
});
