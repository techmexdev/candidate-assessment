import type {
  ConversationProjection,
  MediaAttachmentEvidenceProjection,
  MessageProjection,
  MemberContextReadOpenResult,
  MemberContextQueryResult,
} from "../../domain/contracts/member-context-queries";
import type { MemberContextAuthority } from "../../domain/contracts/member-context";
import { deriveEvidenceAsOf } from "../../domain/policies/copilot-projections";
import type { CopilotSupportingContextReference } from "../../domain/contracts/copilot";

export type ConversationAsset = {
  readonly status: "available" | "missing";
  readonly path?: string;
};

export type MemberConversationTimeline = {
  readonly memberId: string;
  readonly contextRevisionId: string;
  readonly authority: MemberContextAuthority;
  readonly conversationEvidenceId: string;
  readonly anchorEvidenceId: string | null;
  readonly evidenceAsOf: string;
  readonly memberTimezone: string;
  readonly window: { readonly fromInclusive: string; readonly toExclusive: string };
  readonly messages: readonly (Omit<MessageProjection, "attachments"> & {
    readonly attachments: readonly (MediaAttachmentEvidenceProjection & {
      readonly asset: ConversationAsset;
    })[];
  })[];
};

export type RetrieveMemberConversationResult =
  | { readonly status: "ready"; readonly timeline: MemberConversationTimeline; readonly nextCursor?: string }
  | { readonly status: "empty" | "denied" | "unavailable" | "invalid" | "stale" | "cancelled"; readonly message: string };

export type RetrieveMemberConversationInput = {
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
};

type RetrieveMemberConversationDependencies = {
  readonly retrieveMemberContext: (input: {
    readonly coachId: string;
    readonly memberId: string;
    readonly authorizationId: string;
    readonly contextRevisionId?: string;
  }) => Promise<MemberContextReadOpenResult>;
  /** Application-owned allowlist. Graph values may select an evidence ID, never a URL/path. */
  readonly assetAllowlist: Readonly<Record<string, string>>;
};

type ConversationFailureStatus = "empty" | "denied" | "unavailable" | "invalid" | "stale";

function failureStatus(status: MemberContextQueryResult<unknown>["status"] | MemberContextReadOpenResult["status"]): ConversationFailureStatus {
  switch (status) {
    case "empty": return "empty";
    case "stale": return "stale";
    case "denied": return "denied";
    case "invalid": return "invalid";
    default: return "unavailable";
  }
}

function projectResult(
  result: MemberContextQueryResult<ConversationProjection>,
  assetAllowlist: Readonly<Record<string, string>>,
  context: {
    readonly memberId: string;
    readonly contextRevisionId: string;
    readonly authority: MemberContextAuthority;
    readonly evidenceAsOf: string;
    readonly memberTimezone: string;
    readonly fromInclusive: string;
    readonly toExclusive: string;
    readonly anchorEvidenceId: string | null;
  },
): RetrieveMemberConversationResult {
  if (result.status !== "ready") {
    const status = failureStatus(result.status);
    return { status, message: safeMessage(status) };
  }
  if (result.memberId !== context.memberId || result.contextRevisionId !== context.contextRevisionId || result.authority !== context.authority) {
    return { status: "invalid", message: safeMessage("invalid") };
  }
  if (context.anchorEvidenceId && !result.evidenceIds.includes(context.anchorEvidenceId)) {
    return { status: "stale", message: safeMessage("stale") };
  }
  return {
    status: "ready",
    timeline: {
      memberId: result.memberId,
      contextRevisionId: result.contextRevisionId,
      authority: result.authority,
      conversationEvidenceId: result.data.conversationEvidenceId,
      anchorEvidenceId: context.anchorEvidenceId,
      evidenceAsOf: context.evidenceAsOf,
      memberTimezone: context.memberTimezone,
      window: { fromInclusive: context.fromInclusive, toExclusive: context.toExclusive },
      messages: result.data.messages.map((message) => ({
        ...message,
        attachments: message.attachments.map((attachment) => ({
          ...attachment,
          asset: assetAllowlist[attachment.evidenceId]
            ? { status: "available" as const, path: assetAllowlist[attachment.evidenceId] }
            : { status: "missing" as const },
        })),
      })),
    },
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  };
}

function safeMessage(status: ConversationFailureStatus | "cancelled"): string {
  switch (status) {
    case "empty": return "No conversation is available in this supporting window.";
    case "denied": return "Supporting context is unavailable.";
    case "invalid": return "The supporting context request is invalid.";
    case "stale": return "The saved supporting context is no longer available.";
    case "cancelled": return "Conversation loading was cancelled.";
    case "unavailable": return "Conversation history is temporarily unavailable.";
  }
}

function failureFromResult<T>(result: MemberContextQueryResult<T>): RetrieveMemberConversationResult {
  const status = failureStatus(result.status);
  return { status, message: safeMessage(status) };
}

function failureFromOpen(result: Exclude<MemberContextReadOpenResult, { readonly status: "ready" }>): RetrieveMemberConversationResult {
  const status = failureStatus(result.status);
  return { status, message: safeMessage(status) };
}

function validWindow(fromInclusive: string, toExclusive: string): boolean {
  const from = Date.parse(fromInclusive);
  const to = Date.parse(toExclusive);
  const maximumWindowMs = 93 * 24 * 60 * 60 * 1_000;
  return Number.isFinite(from) && Number.isFinite(to) && from < to && to - from <= maximumWindowMs;
}

/** Retrieve one revision-pinned timeline from the member context graph. */
export function createRetrieveMemberConversation(dependencies: RetrieveMemberConversationDependencies) {
  return async (input: RetrieveMemberConversationInput): Promise<RetrieveMemberConversationResult> => {
    if (!input.coachId.trim() || !input.memberId.trim() || !input.sessionAuthorizationId.trim()
      || !input.fromInclusive || !input.toExclusive || !validWindow(input.fromInclusive, input.toExclusive)) {
      return { status: "invalid", message: safeMessage("invalid") };
    }
    if (input.signal?.aborted) return { status: "cancelled", message: safeMessage("cancelled") };
    if (input.supportingContext) {
      const reference = input.supportingContext;
      if (reference.memberId !== input.memberId
        || reference.contextRevisionId !== input.contextRevisionId
        || reference.window.fromInclusive !== input.fromInclusive
        || reference.window.toExclusive !== input.toExclusive) {
        return { status: "invalid", message: safeMessage("invalid") };
      }
    }
    const opened = await dependencies.retrieveMemberContext({
      coachId: input.coachId,
      memberId: input.memberId,
      authorizationId: input.sessionAuthorizationId,
      ...(input.contextRevisionId ? { contextRevisionId: input.contextRevisionId } : {}),
    });
    if (opened.status !== "ready") {
      return failureFromOpen(opened);
    }
    if (input.signal?.aborted) return { status: "cancelled", message: safeMessage("cancelled") };
    const profileResult = await opened.handle.getEvidence({
      domains: ["profile"],
      evidenceKinds: ["member-profile"],
      limit: 1,
      timeoutMs: 1_000,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (input.signal?.aborted) return { status: "cancelled", message: safeMessage("cancelled") };
    if (profileResult.status !== "ready") return failureFromResult(profileResult);
    const profile = profileResult.data.find((item) => item.kind === "member-profile");
    if (!profile || !profileResult.authoritativeEvidenceAnchor) return { status: "invalid", message: safeMessage("invalid") };
    let evidenceAsOf: string;
    try {
      evidenceAsOf = deriveEvidenceAsOf([profileResult.authoritativeEvidenceAnchor], profile.timezone);
    } catch {
      return { status: "invalid", message: safeMessage("invalid") };
    }
    if (input.supportingContext
      && (input.supportingContext.evidenceAsOf !== evidenceAsOf
        || input.supportingContext.memberTimezone !== profile.timezone)) {
      return { status: "stale", message: safeMessage("stale") };
    }
    const result = await opened.handle.getConversation({
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      window: { fromInclusive: input.fromInclusive, toExclusive: input.toExclusive },
      limit: 50,
      timeoutMs: 1_000,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (input.signal?.aborted) return { status: "cancelled", message: safeMessage("cancelled") };
    return projectResult(result, dependencies.assetAllowlist, {
      memberId: opened.handle.memberId,
      contextRevisionId: opened.handle.contextRevisionId,
      authority: opened.handle.authority,
      evidenceAsOf,
      memberTimezone: profile.timezone,
      fromInclusive: input.fromInclusive,
      toExclusive: input.toExclusive,
      anchorEvidenceId: input.supportingContext?.anchor.evidenceId ?? null,
    });
  };
}
