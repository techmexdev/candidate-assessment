import type { RetrieveMemberConversationResult } from "../../../../application/use-cases/retrieve-member-conversation";
import {
  COPILOT_SUPPORTING_CONTEXT_MAX_WINDOW_DAYS,
  createCopilotSupportingContextReference,
  type CopilotContinuationClaims,
  type CopilotSupportingContextReference,
  type SignedCopilotContinuation,
} from "../../../../domain/contracts/copilot";
import { isSyntacticallyValidCopilotContinuation } from "../../../../server/copilot/continuation-token";
import { configuredWorkoutRouteComposition } from "../../../../server/workout-route-composition";

type Session = Awaited<ReturnType<typeof configuredWorkoutRouteComposition.resolveSession>>;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      vary: "cookie",
    },
  });
}

function invalidDate(value: string | null): boolean {
  return !value || !Number.isFinite(Date.parse(value));
}

function validWindow(fromInclusive: string | null, toExclusive: string | null): boolean {
  if (invalidDate(fromInclusive) || invalidDate(toExclusive)) return false;
  const from = Date.parse(fromInclusive!);
  const to = Date.parse(toExclusive!);
  return from < to && to - from <= COPILOT_SUPPORTING_CONTEXT_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1_000;
}

function validTimeZone(value: string | null): value is string {
  if (!value || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function decodeContinuation(value: string | null): SignedCopilotContinuation | null {
  if (!value || value.length > 16_384) return null;
  try {
    const decoded: unknown = JSON.parse(value);
    return isSyntacticallyValidCopilotContinuation(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function outcomeStatus(status: Exclude<RetrieveMemberConversationResult["status"], "ready">): number {
  switch (status) {
    case "empty": return 200;
    case "denied": return 404;
    case "stale": return 409;
    case "invalid": return 400;
    case "cancelled": return 499;
    case "unavailable": return 503;
  }
}

export function createMemberConversationHandler(dependencies: {
  readonly resolveSession: (request: Request) => Promise<Session>;
  readonly conversation: (input: {
    readonly coachId: string;
    readonly memberId: string;
    readonly sessionAuthorizationId: string;
    readonly contextRevisionId?: string;
    readonly conversationId?: string;
    readonly fromInclusive: string;
    readonly toExclusive: string;
    readonly cursor?: string;
    readonly supportingContext?: CopilotSupportingContextReference;
    readonly signal?: AbortSignal;
  }) => Promise<RetrieveMemberConversationResult>;
  readonly verifyCopilotContinuation?: (
    continuation: Readonly<SignedCopilotContinuation>,
  ) => Promise<Readonly<CopilotContinuationClaims> | null>;
}) {
  return async (request: Request): Promise<Response> => {
    const session = await dependencies.resolveSession(request);
    if (session.status !== "authorized") return response({ status: session.status === "unavailable" ? "unavailable" : "not-found" }, session.status === "unavailable" ? 503 : 404);
    const params = new URL(request.url).searchParams;
    const memberId = params.get("memberId");
    const fromInclusive = params.get("from");
    const toExclusive = params.get("to");
    const contextRevisionId = params.get("contextRevisionId");
    const conversationId = params.get("conversationId");
    const cursor = params.get("cursor");
    if (!memberId || memberId.length > 200 || !validWindow(fromInclusive, toExclusive)
      || (conversationId !== null && (conversationId.length === 0 || conversationId.length > 200))
      || (cursor !== null && (cursor.length === 0 || cursor.length > 200))) return response({ status: "not-found" }, 404);
    let supportingContext: CopilotSupportingContextReference | undefined;
    const continuationValue = params.get("continuation");
    if (continuationValue !== null) {
      const continuation = decodeContinuation(continuationValue);
      const answerId = params.get("answerId");
      const anchorEvidenceId = params.get("anchorEvidenceId");
      const evidenceAsOf = params.get("evidenceAsOf");
      const memberTimezone = params.get("memberTimezone");
      if (!continuation || !dependencies.verifyCopilotContinuation || !contextRevisionId || !answerId || !anchorEvidenceId
        || invalidDate(evidenceAsOf) || !validTimeZone(memberTimezone)
        || continuation.claims.memberId !== memberId
        || continuation.claims.contextRevisionId !== contextRevisionId
        || continuation.claims.answerId !== answerId
        || !continuation.claims.selectedEvidenceIds.includes(anchorEvidenceId)) {
        return response({ status: "not-found" }, 404);
      }
      const verified = await dependencies.verifyCopilotContinuation(continuation);
      if (!verified
        || verified.coachId !== session.coachId
        || verified.memberId !== memberId
        || verified.contextRevisionId !== contextRevisionId
        || verified.answerId !== answerId
        || !verified.selectedEvidenceIds.includes(anchorEvidenceId)) return response({ status: "not-found" }, 404);
      try {
        supportingContext = createCopilotSupportingContextReference({
          schemaVersion: "copilot-supporting-context/v1",
          memberId,
          contextRevisionId,
          authority: "canonical",
          answerId,
          anchor: { kind: "conversation", evidenceId: anchorEvidenceId },
          evidenceAsOf: evidenceAsOf!,
          memberTimezone,
          window: { fromInclusive: fromInclusive!, toExclusive: toExclusive! },
          continuation,
        });
      } catch {
        return response({ status: "not-found" }, 404);
      }
    }
    const result = await dependencies.conversation({
      coachId: session.coachId,
      memberId,
      sessionAuthorizationId: session.authorizationId,
      ...(contextRevisionId ? { contextRevisionId } : {}),
      ...(conversationId ? { conversationId } : {}),
      fromInclusive: fromInclusive!,
      toExclusive: toExclusive!,
      ...(cursor ? { cursor } : {}),
      ...(supportingContext ? { supportingContext } : {}),
      signal: request.signal,
    });
    if (result.status === "ready") return response(result);
    return response({ status: result.status, message: result.message }, outcomeStatus(result.status));
  };
}

export const GET = createMemberConversationHandler({
  resolveSession: configuredWorkoutRouteComposition.resolveSession,
  conversation: configuredWorkoutRouteComposition.conversation!,
  verifyCopilotContinuation: configuredWorkoutRouteComposition.verifyCopilotContinuation,
});
