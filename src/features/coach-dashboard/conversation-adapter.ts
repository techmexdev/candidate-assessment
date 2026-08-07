import type {
  AssertionClassification,
  AssertionSource,
  AssertionTemporal,
} from "../../domain/contracts/member-context";
import {
  COPILOT_SUPPORTING_CONTEXT_MAX_WINDOW_DAYS,
} from "../../domain/contracts/copilot";
import type {
  MemberConversationTimeline,
  ConversationAsset,
} from "../../application/use-cases/retrieve-member-conversation";
import type {
  DashboardConversationClient,
  DashboardConversationOutcome,
  DashboardConversationRequest,
} from "./dashboard-contract";

const classifications = [
  "identity",
  "source-statement",
  "observation",
  "source-provided-assessment",
  "system-derived-assessment",
  "graph-lineage",
  "publication-state",
] as const satisfies readonly AssertionClassification[];

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function decodeSource(value: unknown): AssertionSource | null {
  return isObject(value) && typeof value.locator === "string" && typeof value.artifactDigest === "string"
    ? { locator: value.locator, artifactDigest: value.artifactDigest }
    : null;
}

function decodeTemporal(value: unknown): AssertionTemporal | null {
  if (!isObject(value)) return null;
  if (value.precision === "exact-timestamp" && typeof value.effectiveAt === "string") return { precision: value.precision, effectiveAt: value.effectiveAt };
  if (value.precision === "date" && typeof value.effectiveOn === "string") return { precision: value.precision, effectiveOn: value.effectiveOn };
  if (value.precision === "relative-order" && Number.isInteger(value.sourceOrder)) return { precision: value.precision, sourceOrder: value.sourceOrder as number };
  if (value.precision === "unknown") return { precision: value.precision };
  return null;
}

function decodeAsset(value: unknown): ConversationAsset | null {
  if (!isObject(value) || (value.status !== "available" && value.status !== "missing")) return null;
  if (value.status === "missing") return { status: value.status };
  return typeof value.path === "string" && value.path.startsWith("/synthetic/")
    ? { status: value.status, path: value.path }
    : null;
}

function decodeAttachment(value: unknown): MemberConversationTimeline["messages"][number]["attachments"][number] | null {
  if (!isObject(value)
    || typeof value.evidenceId !== "string"
    || typeof value.semanticId !== "string"
    || typeof value.assertionId !== "string"
    || value.kind !== "media-attachment"
    || !classifications.includes(value.classification as AssertionClassification)
    || typeof value.mediaType !== "string"
    || typeof value.caption !== "string"
    || !Number.isInteger(value.sourceOrder)
    || value.assetStatus !== "metadata-only"
    || value.analysisStatus !== "not-analyzed") return null;
  const source = decodeSource(value.source);
  const temporal = decodeTemporal(value.temporal);
  const asset = decodeAsset(value.asset);
  return source && temporal && asset ? {
    evidenceId: value.evidenceId,
    semanticId: value.semanticId,
    assertionId: value.assertionId,
    kind: value.kind,
    source,
    classification: value.classification as AssertionClassification,
    temporal,
    mediaType: value.mediaType,
    caption: value.caption,
    sourceOrder: value.sourceOrder as number,
    assetStatus: value.assetStatus,
    analysisStatus: value.analysisStatus,
    asset,
  } : null;
}

function decodeMessage(value: unknown): MemberConversationTimeline["messages"][number] | null {
  if (!isObject(value)
    || typeof value.evidenceId !== "string"
    || typeof value.semanticId !== "string"
    || typeof value.assertionId !== "string"
    || value.kind !== "message"
    || (value.senderRole !== "member" && value.senderRole !== "coach")
    || typeof value.text !== "string"
    || !classifications.includes(value.classification as AssertionClassification)) return null;
  const attachmentEvidenceIds = stringArray(value.attachmentEvidenceIds);
  const attachments = Array.isArray(value.attachments) ? value.attachments.map(decodeAttachment) : null;
  const source = decodeSource(value.source);
  const temporal = decodeTemporal(value.temporal);
  if (!attachmentEvidenceIds || !attachments || attachments.some((item) => item === null) || !source || !temporal
    || attachmentEvidenceIds.length !== attachments.length
    || attachments.some((item) => item !== null && !attachmentEvidenceIds.includes(item.evidenceId))
    || attachmentEvidenceIds.some((evidenceId) => !attachments.some((item) => item?.evidenceId === evidenceId))) return null;
  return {
    evidenceId: value.evidenceId,
    semanticId: value.semanticId,
    assertionId: value.assertionId,
    kind: value.kind,
    source,
    classification: value.classification as AssertionClassification,
    temporal,
    senderRole: value.senderRole,
    text: value.text,
    attachmentEvidenceIds,
    attachments: attachments as NonNullable<typeof attachments[number]>[],
  };
}

function validTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function validWindow(value: unknown): value is { readonly fromInclusive: string; readonly toExclusive: string } {
  if (!isObject(value) || typeof value.fromInclusive !== "string" || typeof value.toExclusive !== "string") return false;
  const from = Date.parse(value.fromInclusive);
  const to = Date.parse(value.toExclusive);
  return Number.isFinite(from)
    && Number.isFinite(to)
    && from < to
    && to - from <= COPILOT_SUPPORTING_CONTEXT_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1_000;
}

function decodeTimeline(value: unknown): MemberConversationTimeline | null {
  if (!isObject(value)
    || typeof value.memberId !== "string"
    || typeof value.contextRevisionId !== "string"
    || (value.authority !== "canonical" && value.authority !== "fixture")
    || typeof value.conversationEvidenceId !== "string"
    || (value.anchorEvidenceId !== null && typeof value.anchorEvidenceId !== "string")
    || typeof value.evidenceAsOf !== "string"
    || !Number.isFinite(Date.parse(value.evidenceAsOf))
    || !validTimezone(value.memberTimezone)
    || !validWindow(value.window)
    || !Array.isArray(value.messages)) return null;
  const messages = value.messages.map(decodeMessage);
  if (!messages.every((message) => message !== null)) return null;
  const evidenceIds = new Set(messages.flatMap((message) => [message.evidenceId, ...message.attachments.map((attachment) => attachment.evidenceId)]));
  if (value.anchorEvidenceId !== null && !evidenceIds.has(value.anchorEvidenceId)) return null;
  return {
    memberId: value.memberId,
    contextRevisionId: value.contextRevisionId,
    authority: value.authority,
    conversationEvidenceId: value.conversationEvidenceId,
    anchorEvidenceId: value.anchorEvidenceId,
    evidenceAsOf: value.evidenceAsOf,
    memberTimezone: value.memberTimezone,
    window: value.window,
    messages: messages as NonNullable<typeof messages[number]>[],
  };
}

function decodeOutcome(
  value: unknown,
  requestId: string,
  responseOk: boolean,
  expected: DashboardConversationRequest,
): DashboardConversationOutcome | null {
  if (!isObject(value) || typeof value.status !== "string") return null;
  if (value.status === "ready") {
    const timeline = decodeTimeline(value.timeline);
    const nextCursor = value.nextCursor;
    if (!responseOk || !timeline
      || timeline.memberId !== expected.memberId
      || (expected.contextRevisionId !== undefined && timeline.contextRevisionId !== expected.contextRevisionId)
      || timeline.window.fromInclusive !== expected.window.fromInclusive
      || timeline.window.toExclusive !== expected.window.toExclusive
      || (expected.supportingContext
        ? timeline.contextRevisionId !== expected.supportingContext.contextRevisionId
          || timeline.authority !== expected.supportingContext.authority
          || timeline.anchorEvidenceId !== expected.supportingContext.anchor.evidenceId
          || timeline.evidenceAsOf !== expected.supportingContext.evidenceAsOf
          || timeline.memberTimezone !== expected.supportingContext.memberTimezone
          || timeline.window.fromInclusive !== expected.supportingContext.window.fromInclusive
          || timeline.window.toExclusive !== expected.supportingContext.window.toExclusive
        : timeline.anchorEvidenceId !== null)
      || (nextCursor !== undefined && (typeof nextCursor !== "string" || nextCursor.length === 0 || nextCursor.length > 200))) return null;
    return {
      status: value.status,
      requestId,
      timeline,
      ...(typeof nextCursor === "string" ? { nextCursor } : {}),
    };
  }
  if (!["empty", "denied", "unavailable", "invalid", "stale", "cancelled"].includes(value.status)
    || typeof value.message !== "string") return null;
  return {
    status: value.status as Exclude<DashboardConversationOutcome["status"], "ready">,
    requestId,
    message: value.message,
  };
}

function unavailable(requestId: string): DashboardConversationOutcome {
  return { status: "unavailable", requestId, message: "Conversation history is temporarily unavailable." };
}

/** Fetches only the server-projected, revision-pinned conversation timeline. */
export function createFetchDashboardConversationClient(fetcher: typeof fetch = fetch): DashboardConversationClient {
  return {
    async load(input): Promise<DashboardConversationOutcome> {
      try {
        const params = new URLSearchParams({
          memberId: input.memberId,
          from: input.window.fromInclusive,
          to: input.window.toExclusive,
        });
        if (input.contextRevisionId) params.set("contextRevisionId", input.contextRevisionId);
        if (input.supportingContext) {
          params.set("answerId", input.supportingContext.answerId);
          params.set("anchorEvidenceId", input.supportingContext.anchor.evidenceId);
          params.set("evidenceAsOf", input.supportingContext.evidenceAsOf);
          params.set("memberTimezone", input.supportingContext.memberTimezone);
          params.set("continuation", JSON.stringify(input.supportingContext.continuation));
        }
        const response = await fetcher(`/api/member-context/conversation?${params}`, {
          headers: { accept: "application/json" },
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const decoded = decodeOutcome(await response.json(), input.requestId, response.ok, input);
        return decoded ?? unavailable(input.requestId);
      } catch {
        return input.signal?.aborted
          ? { status: "cancelled", requestId: input.requestId, message: "Conversation loading was cancelled." }
          : unavailable(input.requestId);
      }
    },
  };
}
