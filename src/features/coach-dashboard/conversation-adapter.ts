import type { MemberConversationTimeline } from "../../application/use-cases/retrieve-member-conversation";
import type { DashboardConversationClient } from "./dashboard-contract";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Fetches only the server-projected, revision-pinned conversation timeline. */
export function createFetchDashboardConversationClient(fetcher: typeof fetch = fetch): DashboardConversationClient {
  return {
    async load(input): Promise<MemberConversationTimeline> {
      const params = new URLSearchParams({
        memberId: input.memberId,
        from: "2026-05-01T00:00:00.000Z",
        to: "2026-07-01T00:00:00.000Z",
      });
      if (input.contextRevisionId) params.set("contextRevisionId", input.contextRevisionId);
      const response = await fetcher(`/api/member-context/conversation?${params}`, {
        headers: { accept: "application/json" },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const body: unknown = await response.json();
      if (!response.ok || !isObject(body) || body.status !== "ready" || !isObject(body.timeline)) throw new Error("Conversation timeline unavailable.");
      return body.timeline as unknown as MemberConversationTimeline;
    },
  };
}

