import type {
  ConversationProjection,
  MediaAttachmentEvidenceProjection,
  MessageProjection,
  MemberContextReadOpenResult,
  MemberContextQueryResult,
} from "../../domain/contracts/member-context-queries";

export type ConversationAsset = {
  readonly status: "available" | "missing";
  readonly path?: string;
};

export type MemberConversationTimeline = {
  readonly contextRevisionId: string;
  readonly conversationEvidenceId: string;
  readonly messages: readonly (Omit<MessageProjection, "attachments"> & {
    readonly attachments: readonly (MediaAttachmentEvidenceProjection & {
      readonly asset: ConversationAsset;
    })[];
  })[];
};

export type RetrieveMemberConversationResult =
  | { readonly status: "ready"; readonly timeline: MemberConversationTimeline; readonly nextCursor?: string }
  | { readonly status: "empty" | "denied" | "unavailable" | "invalid" | "stale"; readonly message: string };

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

function projectResult(
  result: MemberContextQueryResult<ConversationProjection>,
  assetAllowlist: Readonly<Record<string, string>>,
): RetrieveMemberConversationResult {
  if (result.status !== "ready") {
    const status = result.status === "empty" ? "empty"
      : result.status === "stale" ? "stale"
        : result.status === "denied" ? "denied"
          : result.status === "invalid" ? "invalid" : "unavailable";
    return { status, message: "message" in result ? result.message : "Conversation is unavailable." };
  }
  return {
    status: "ready",
    timeline: {
      contextRevisionId: result.contextRevisionId,
      conversationEvidenceId: result.data.conversationEvidenceId,
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

/** Retrieve one revision-pinned timeline from the member context graph. */
export function createRetrieveMemberConversation(dependencies: RetrieveMemberConversationDependencies) {
  return async (input: {
    readonly coachId: string;
    readonly memberId: string;
    readonly sessionAuthorizationId: string;
    readonly contextRevisionId?: string;
    readonly conversationId?: string;
    readonly fromInclusive: string;
    readonly toExclusive: string;
    readonly cursor?: string;
  }): Promise<RetrieveMemberConversationResult> => {
    if (!input.coachId.trim() || !input.memberId.trim() || !input.sessionAuthorizationId.trim()
      || !input.fromInclusive || !input.toExclusive || Date.parse(input.fromInclusive) >= Date.parse(input.toExclusive)) {
      return { status: "invalid", message: "Conversation is unavailable." };
    }
    const opened = await dependencies.retrieveMemberContext({
      coachId: input.coachId,
      memberId: input.memberId,
      authorizationId: input.sessionAuthorizationId,
      ...(input.contextRevisionId ? { contextRevisionId: input.contextRevisionId } : {}),
    });
    if (opened.status !== "ready") {
      const status = opened.status === "empty" ? "empty"
        : opened.status === "stale" ? "stale"
          : opened.status === "denied" ? "denied" : "unavailable";
      return { status, message: "message" in opened ? opened.message : "Conversation is unavailable." };
    }
    const result = await opened.handle.getConversation({
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      window: { fromInclusive: input.fromInclusive, toExclusive: input.toExclusive },
      limit: 50,
      timeoutMs: 1_000,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
    return projectResult(result, dependencies.assetAllowlist);
  };
}
