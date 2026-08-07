import type { CopilotRuntime } from "../ports/copilot-runtime";
import type {
  CopilotContinuationClaims,
  CopilotOutcome,
  CopilotRequest,
  SignedCopilotContinuation,
} from "../../domain/contracts/copilot";
import type { MemberContextReadBoundary } from "../ports/graph-repositories";
import { authorizeMemberContextSafely } from "../ports/graph-repositories";
import { createRetrieveMemberContext } from "./retrieve-member-context";

export type AnswerCopilotQuestionRequest = {
  readonly coachId: string;
  readonly authorizationId: string;
  readonly request: CopilotRequest;
};

export type AnswerCopilotQuestionDependencies = MemberContextReadBoundary & {
  readonly runtime: CopilotRuntime;
  readonly verifyContinuation: (
    continuation: Readonly<SignedCopilotContinuation>,
  ) => Promise<Readonly<CopilotContinuationClaims> | null> | Readonly<CopilotContinuationClaims> | null;
  readonly now?: () => string;
  readonly deadlineMs?: number;
};

type AwaitedStage<Value> =
  | { readonly status: "ready"; readonly value: Value }
  | { readonly status: "aborted" }
  | { readonly status: "failed" };

async function waitFor<Value>(promise: PromiseLike<Value> | Value, signal: AbortSignal): Promise<AwaitedStage<Value>> {
  if (signal.aborted) return { status: "aborted" };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: AwaitedStage<Value>) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => finish({ status: "aborted" });
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish({ status: "ready", value }),
      () => finish({ status: "failed" }),
    );
  });
}

function validContinuationBinding(
  claims: Readonly<CopilotContinuationClaims>,
  request: Readonly<AnswerCopilotQuestionRequest>,
  now: string,
): boolean {
  const issuedAt = Date.parse(claims.issuedAt);
  const expiresAt = Date.parse(claims.expiresAt);
  const current = Date.parse(now);
  return claims.schemaVersion === "copilot-continuation-claims/v1"
    && claims.coachId === request.coachId
    && claims.memberId === request.request.memberId
    && Number.isFinite(issuedAt)
    && Number.isFinite(expiresAt)
    && Number.isFinite(current)
    && issuedAt <= current
    && current < expiresAt
    && claims.selectedEvidenceIds.length <= 100
    && new Set(claims.selectedEvidenceIds).size === claims.selectedEvidenceIds.length;
}

function timedOutOrCancelled(requestId: string, cancelled: boolean): CopilotOutcome {
  return cancelled
    ? { status: "cancelled", requestId }
    : { status: "unavailable", requestId, code: "graph-timeout", retryable: true, message: "Member context retrieval timed out." };
}

/** Trusted application boundary: raw authorization data stops here; agents receive only the pinned handle. */
export function createAnswerCopilotQuestion(dependencies: AnswerCopilotQuestionDependencies) {
  const retrieveMemberContext = createRetrieveMemberContext(dependencies);
  const now = dependencies.now ?? (() => new Date().toISOString());
  const deadlineMs = dependencies.deadlineMs ?? 5_000;

  return async (
    input: Readonly<AnswerCopilotQuestionRequest>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CopilotOutcome> => {
    const deadline = AbortSignal.timeout(deadlineMs);
    const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const requestId = input.request.requestId;
    const cancelled = () => options?.signal?.aborted === true;

    const authorized = await waitFor(authorizeMemberContextSafely(dependencies.authorizeMemberContext, {
      coachId: input.coachId,
      memberId: input.request.memberId,
      authorizationId: input.authorizationId,
    }), signal);
    if (authorized.status === "aborted") return timedOutOrCancelled(requestId, cancelled());
    if (authorized.status === "failed") return { status: "denied", requestId, message: "Member context is unavailable." };
    if (!authorized.value) return { status: "denied", requestId, message: "Member context is unavailable." };

    let continuationClaims: Readonly<CopilotContinuationClaims> | undefined;
    if (input.request.continuation) {
      const verified = await waitFor(dependencies.verifyContinuation(input.request.continuation), signal);
      if (verified.status === "aborted") return timedOutOrCancelled(requestId, cancelled());
      if (verified.status === "failed" || !verified.value || !validContinuationBinding(verified.value, input, now())) {
        return { status: "continuation-expired", requestId, message: "The saved Copilot context is no longer valid. Refresh deliberately to start from the active revision." };
      }
      continuationClaims = verified.value;
    }

    const opened = await waitFor(retrieveMemberContext({
      coachId: input.coachId,
      memberId: input.request.memberId,
      authorizationId: input.authorizationId,
      ...(continuationClaims ? { contextRevisionId: continuationClaims.contextRevisionId } : {}),
    }), signal);
    if (opened.status === "aborted") return timedOutOrCancelled(requestId, cancelled());
    if (opened.status === "failed") return { status: "unavailable", requestId, code: "graph-unavailable", retryable: true, message: "Member context is temporarily unavailable." };
    if (opened.value.status === "denied") return { status: "denied", requestId, message: "Member context is unavailable." };
    if (opened.value.status === "empty") return { status: "empty", requestId, message: "Member context is not available." };
    if (opened.value.status === "stale") return { status: "stale", requestId, requestedRevisionId: opened.value.requestedRevisionId, activeRevisionId: opened.value.activeRevisionId, message: "The saved Copilot revision is no longer available." };
    if (opened.value.status === "invalid") return { status: "invalid", requestId, code: "invalid-context", message: "The Copilot request is invalid." };
    if (opened.value.status === "unavailable") return { status: "unavailable", requestId, code: "graph-unavailable", retryable: true, message: "Member context is temporarily unavailable." };

    if (continuationClaims?.selectedEvidenceIds.length) {
      const priorEvidence = await waitFor(opened.value.handle.getCitations({
        evidenceIds: continuationClaims.selectedEvidenceIds,
        limit: continuationClaims.selectedEvidenceIds.length,
        timeoutMs: 1_000,
      }), signal);
      if (priorEvidence.status === "aborted") return timedOutOrCancelled(requestId, cancelled());
      if (priorEvidence.status === "failed"
        || priorEvidence.value.status !== "ready"
        || priorEvidence.value.contextRevisionId !== continuationClaims.contextRevisionId
        || priorEvidence.value.evidenceIds.length !== continuationClaims.selectedEvidenceIds.length
        || continuationClaims.selectedEvidenceIds.some((id) => !priorEvidence.value.evidenceIds.includes(id))) {
        return { status: "stale", requestId, requestedRevisionId: continuationClaims.contextRevisionId, activeRevisionId: null, message: "The saved Copilot evidence is no longer available." };
      }
    }

    if (signal.aborted) return timedOutOrCancelled(requestId, cancelled());
    return dependencies.runtime.answer({
      requestId,
      requestedFor: input.request.requestedFor,
      input: input.request.input,
      memberContext: opened.value.handle,
      ...(continuationClaims ? { continuation: continuationClaims } : {}),
    }, { signal });
  };
}
