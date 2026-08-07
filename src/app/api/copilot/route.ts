import type { AnswerCopilotQuestionRequest } from "../../../application/use-cases/answer-copilot-question";
import {
  COPILOT_QUICK_PROMPT_IDS,
  type CopilotOutcome,
  type CopilotRequest,
} from "../../../domain/contracts/copilot";
import { COPILOT_MAX_QUESTION_LENGTH } from "../../../domain/policies/copilot-retrieval-plan";
import { configuredCopilotComposition } from "../../../server/copilot/composition";
import type { MockCoachSession } from "../../../server/auth/mock-coach-session";
import { isSyntacticallyValidCopilotContinuation } from "../../../server/copilot/continuation-token";

export const COPILOT_MAX_BODY_BYTES = 16_384;
export const COPILOT_TOTAL_DEADLINE_MS = 5_000;

const noStoreHeaders = {
  "cache-control": "private, no-store, max-age=0",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
} as const;

type RouteControls = {
  readonly retry: boolean;
  readonly refresh: boolean;
  readonly keepLastReadyAnswer: boolean;
};

export type CopilotPostHandlerDependencies = {
  readonly resolveSession: (request: Request) => Promise<MockCoachSession>;
  readonly answer: (
    input: Readonly<AnswerCopilotQuestionRequest>,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<CopilotOutcome>;
  readonly deadlineMs?: number;
};

function response(value: unknown, status: number): Response {
  return Response.json(value, { status, headers: noStoreHeaders });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function boundedId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 200
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function clientDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function decodeRequest(value: unknown): CopilotRequest | null {
  if (!record(value)
    || !exactKeys(value, ["schemaVersion", "requestId", "memberId", "requestedFor", "input"], ["continuation"])
    || value.schemaVersion !== "copilot-request/v1"
    || !boundedId(value.requestId)
    || !boundedId(value.memberId)
    || !clientDate(value.requestedFor)
    || !record(value.input)) return null;

  if (value.input.kind === "quick-prompt") {
    if (!exactKeys(value.input, ["kind", "promptId"])
      || !COPILOT_QUICK_PROMPT_IDS.includes(value.input.promptId as never)) return null;
  } else if (value.input.kind === "free-text") {
    if (!exactKeys(value.input, ["kind", "question"])
      || typeof value.input.question !== "string"
      || value.input.question.trim().length === 0
      || value.input.question.length > COPILOT_MAX_QUESTION_LENGTH) return null;
  } else return null;

  if (Object.hasOwn(value, "continuation")
    && !isSyntacticallyValidCopilotContinuation(value.continuation)) return null;
  return value as CopilotRequest;
}

async function readBoundedJson(request: Request): Promise<{ status: "ready"; value: unknown } | { status: "invalid" | "too-large" }> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0) return { status: "invalid" };
    if (bytes > COPILOT_MAX_BODY_BYTES) return { status: "too-large" };
  }
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > COPILOT_MAX_BODY_BYTES) return { status: "too-large" };
    return { status: "ready", value: JSON.parse(text) as unknown };
  } catch { return { status: "invalid" }; }
}

const deniedPayload = Object.freeze({
  status: "denied",
  requestId: "request:unavailable",
  message: "Member context is unavailable.",
  controls: { retry: false, refresh: false, keepLastReadyAnswer: false },
});

function externalOutcome(outcome: CopilotOutcome): { readonly status: number; readonly payload: unknown } {
  let controls: RouteControls;
  let status: number;
  switch (outcome.status) {
    case "ready": controls = { retry: false, refresh: false, keepLastReadyAnswer: false }; status = 200; break;
    case "empty": controls = { retry: false, refresh: true, keepLastReadyAnswer: true }; status = 200; break;
    case "insufficient-history": controls = { retry: false, refresh: false, keepLastReadyAnswer: true }; status = 200; break;
    case "stale": controls = { retry: false, refresh: true, keepLastReadyAnswer: true }; status = 409; break;
    case "continuation-expired": controls = { retry: false, refresh: true, keepLastReadyAnswer: true }; status = 409; break;
    case "denied": return { status: 404, payload: deniedPayload };
    case "invalid": controls = { retry: false, refresh: false, keepLastReadyAnswer: true }; status = 400; break;
    case "unavailable": controls = { retry: true, refresh: false, keepLastReadyAnswer: true }; status = outcome.code === "graph-timeout" ? 504 : 503; break;
    case "model-error": controls = { retry: true, refresh: false, keepLastReadyAnswer: true }; status = outcome.code === "provider-timeout" ? 504 : 503; break;
    case "unsupported": controls = { retry: false, refresh: false, keepLastReadyAnswer: true }; status = 200; break;
    case "cancelled": controls = { retry: false, refresh: false, keepLastReadyAnswer: true }; status = 499; break;
  }
  if (outcome.status === "stale") {
    return {
      status,
      payload: {
        status: outcome.status,
        requestId: outcome.requestId,
        message: "The saved Copilot revision is no longer available.",
        controls,
      },
    };
  }
  return { status, payload: { ...outcome, controls } };
}

async function waitForOutcome(
  pending: Promise<CopilotOutcome>,
  signal: AbortSignal,
  requestId: string,
  clientSignal: AbortSignal,
): Promise<CopilotOutcome> {
  if (signal.aborted) return clientSignal.aborted
    ? { status: "cancelled", requestId }
    : { status: "unavailable", requestId, code: "graph-timeout", retryable: true, message: "Copilot request timed out." };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: CopilotOutcome) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(clientSignal.aborted
      ? { status: "cancelled", requestId }
      : { status: "unavailable", requestId, code: "graph-timeout", retryable: true, message: "Copilot request timed out." });
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => finish(value),
      () => finish({ status: "unavailable", requestId, code: "graph-unavailable", retryable: true, message: "Copilot is temporarily unavailable." }),
    );
  });
}

export function createCopilotPostHandler(dependencies: CopilotPostHandlerDependencies) {
  const deadlineMs = dependencies.deadlineMs ?? COPILOT_TOTAL_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > COPILOT_TOTAL_DEADLINE_MS) {
    throw new Error(`Copilot deadline must be between 1 and ${COPILOT_TOTAL_DEADLINE_MS} milliseconds`);
  }
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    if (!origin) return response({ status: "forbidden" }, 403);
    try {
      if (new URL(origin).origin !== new URL(request.url).origin) return response({ status: "forbidden" }, 403);
    } catch { return response({ status: "forbidden" }, 403); }
    const parsed = await readBoundedJson(request);
    if (parsed.status !== "ready") {
      return response({
        status: "invalid",
        requestId: "request:invalid",
        code: parsed.status === "too-large" ? "body-too-large" : "invalid-body",
        message: "The Copilot request is invalid.",
        controls: { retry: false, refresh: false, keepLastReadyAnswer: true },
      }, parsed.status === "too-large" ? 413 : 400);
    }
    const decoded = decodeRequest(parsed.value);
    if (!decoded) return response({
      status: "invalid",
      requestId: "request:invalid",
      code: "invalid-body",
      message: "The Copilot request is invalid.",
      controls: { retry: false, refresh: false, keepLastReadyAnswer: true },
    }, 400);

    let session: MockCoachSession;
    try { session = await dependencies.resolveSession(request); } catch { session = { status: "unavailable" }; }
    if (session.status !== "authorized" || !session.entitledMemberIds.includes(decoded.memberId)) {
      return response(deniedPayload, 404);
    }

    const timeout = AbortSignal.timeout(deadlineMs);
    const signal = AbortSignal.any([request.signal, timeout]);
    const outcome = await waitForOutcome(dependencies.answer({
      coachId: session.coachId,
      authorizationId: session.authorizationId,
      request: decoded,
    }, { signal }), signal, decoded.requestId, request.signal);
    const mapped = externalOutcome(outcome);
    return response(mapped.payload, mapped.status);
  };
}

export const POST = createCopilotPostHandler({
  resolveSession: configuredCopilotComposition.resolveSession,
  answer: configuredCopilotComposition.answer,
});
