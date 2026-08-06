import { describe, expect, it, vi } from "vitest";
import { createRetrieveMemberContext } from "../../src/application/use-cases/retrieve-member-context";
import type {
  MemberContextReadHandle,
  MemberContextReadProvider,
} from "../../src/domain/contracts/member-context-queries";

const emptyResult = () => ({
  status: "empty" as const,
  memberId: "member-1",
  contextRevisionId: "revision-1",
  authority: "canonical" as const,
  evidenceIds: [],
  message: "No matching evidence.",
});

describe("member context authorization lifetime", () => {
  it("rechecks authorization before every operation on an opened revision-pinned handle", async () => {
    const operations = {
      getSummary: vi.fn(async () => emptyResult()),
      getEvidence: vi.fn(async () => emptyResult()),
      getLongitudinalSeries: vi.fn(async () => emptyResult()),
      getConversation: vi.fn(async () => emptyResult()),
      getCoachBrief: vi.fn(async () => emptyResult()),
      getRelatedEvidence: vi.fn(async () => emptyResult()),
      getCitations: vi.fn(async () => emptyResult()),
    };
    const providerHandle: MemberContextReadHandle = {
      memberId: "member-1",
      coachId: "coach-1",
      contextRevisionId: "revision-1",
      authority: "canonical",
      ...operations,
    };
    const provider: MemberContextReadProvider = {
      openActive: vi.fn(async () => ({ status: "ready" as const, handle: providerHandle })),
      openRevision: vi.fn(async () => ({ status: "ready" as const, handle: providerHandle })),
    };
    let grantActive = true;
    const authorizeMemberContext = vi.fn(async () => grantActive);
    const retrieve = createRetrieveMemberContext({ memberContext: provider, authorizeMemberContext });
    const opened = await retrieve({
      coachId: "coach-1",
      memberId: "member-1",
      authorizationId: "grant-1",
      contextRevisionId: "revision-1",
    });
    if (opened.status !== "ready") throw new Error(opened.status);

    await expect(opened.handle.getSummary({ limit: 1, timeoutMs: 100 }))
      .resolves.toMatchObject({ status: "empty", contextRevisionId: "revision-1" });
    expect(operations.getSummary).toHaveBeenCalledOnce();

    grantActive = false;
    const window = { fromInclusive: "2026-01-01", toExclusive: "2026-02-01" };
    const deniedOperations = [
      opened.handle.getSummary({ limit: 1, timeoutMs: 100 }),
      opened.handle.getEvidence({ domains: ["labs"], limit: 1, timeoutMs: 100 }),
      opened.handle.getLongitudinalSeries({ metric: "hrv", window, minimumPoints: 1, limit: 1, timeoutMs: 100 }),
      opened.handle.getConversation({ window, limit: 1, timeoutMs: 100 }),
      opened.handle.getCoachBrief({ limit: 1, timeoutMs: 100 }),
      opened.handle.getRelatedEvidence({ evidenceId: "assertion:0000000000000000", maxDepth: 1, limit: 1, timeoutMs: 100 }),
      opened.handle.getCitations({ evidenceIds: ["assertion:0000000000000000"], limit: 1, timeoutMs: 100 }),
    ];

    for (const operation of deniedOperations) {
      await expect(operation).resolves.toEqual({
        status: "denied",
        memberId: "member-1",
        contextRevisionId: "revision-1",
        authority: "canonical",
        evidenceIds: [],
        message: "Member context is unavailable.",
      });
    }
    expect(authorizeMemberContext).toHaveBeenCalledTimes(9);
    expect(operations.getSummary).toHaveBeenCalledOnce();
    expect(operations.getEvidence).not.toHaveBeenCalled();
    expect(operations.getLongitudinalSeries).not.toHaveBeenCalled();
    expect(operations.getConversation).not.toHaveBeenCalled();
    expect(operations.getCoachBrief).not.toHaveBeenCalled();
    expect(operations.getRelatedEvidence).not.toHaveBeenCalled();
    expect(operations.getCitations).not.toHaveBeenCalled();
  });
});
