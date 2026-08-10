import type { Page } from "@playwright/test";

import type { CopilotAnswerPacket, CopilotRequest } from "../../src/domain/contracts/copilot";

const REVISION = `member-context:sha256:${"c".repeat(64)}`;
const EVIDENCE_AS_OF = "2026-06-04T23:59:59.999-05:00";
const SOURCE = { locator: "/synthetic/copilot-presentation", artifactDigest: `sha256:${"d".repeat(64)}` };

function richAnswer(request: CopilotRequest): CopilotAnswerPacket {
  const intentId = request.input.kind === "quick-prompt" ? request.input.promptId : "morning-brief";
  const answerId = intentId === "morning-brief" ? "answer:presentation" : `answer:presentation:${intentId}`;
  const scope = { memberId: request.memberId, contextRevisionId: REVISION, authority: "canonical" as const };
  const evidenceIds = {
    answer: `${answerId}:answer`,
    facts: `${answerId}:facts`,
    trend: `${answerId}:trend`,
    risk: `${answerId}:risk`,
    source: `${answerId}:source`,
  } as const;
  const evidence = Object.values(evidenceIds).map((evidenceId) => ({
    ...scope,
    atomKind: "fact" as const,
    evidenceId,
    evidenceKind: "observation" as const,
    source: SOURCE,
    classification: "observation" as const,
    temporal: { precision: "date" as const, effectiveOn: "2026-06-04" },
    unit: "percent",
    value: 50,
  }));
  const continuation = {
    schemaVersion: "signed-copilot-continuation/v1" as const,
    algorithm: "hmac-sha256" as const,
    claims: {
      schemaVersion: "copilot-continuation-claims/v1" as const,
      coachId: "coach:presentation",
      memberId: request.memberId,
      contextRevisionId: REVISION,
      answerId,
      intentId,
      selectedEvidenceIds: Object.values(evidenceIds),
      issuedAt: "2026-06-04T10:00:00.000Z",
      expiresAt: "2026-06-04T10:15:00.000Z",
    },
    signature: "presentation-test-signature",
  };

  return {
    schemaVersion: "copilot-answer/v1",
    requestId: request.requestId,
    answerId,
    ...scope,
    intentId,
    requestedFor: request.requestedFor,
    evidenceAsOf: EVIDENCE_AS_OF,
    memberTimezone: "America/Chicago",
    briefFreshness: intentId === "morning-brief" ? { status: "latest-recorded", generatedFor: "2026-06-04" } : null,
    evidence: { ...scope, atoms: evidence },
    sections: [
      { sectionId: "answer", clauses: intentId === "churn-risk" ? [
        { clauseId: `${answerId}:completion-one`, text: "weekly-workout-completion: 100 percent.", evidenceIds: [evidenceIds.answer] },
        { clauseId: `${answerId}:completion-two`, text: "weekly-workout-completion: 50 percent.", evidenceIds: [evidenceIds.answer] },
        { clauseId: `${answerId}:workout`, text: "Full Body: not completed.", evidenceIds: [evidenceIds.facts] },
        { clauseId: `${answerId}:message`, text: "Member message: Skipped Thursday because work was exhausting.", evidenceIds: [evidenceIds.source] },
      ] : [{ clauseId: `${answerId}:answer-clause`, text: "The member is progressing with steady adherence.", evidenceIds: [evidenceIds.answer] }] },
      { sectionId: "recent-facts", clauses: [{ clauseId: `${answerId}:facts-clause`, text: "Two recent sessions were completed as planned.", evidenceIds: [evidenceIds.facts] }] },
      { sectionId: "trend", clauses: [{ clauseId: `${answerId}:trend-clause`, text: "Adherence is steady across the recorded period.", evidenceIds: [evidenceIds.trend] }] },
      { sectionId: "stable-context", clauses: [{ clauseId: `${answerId}:context-clause`, text: "The member is traveling this week.", evidenceIds: [evidenceIds.source] }] },
      { sectionId: "next-action", clauses: [{ clauseId: `${answerId}:action-clause`, text: "Celebrate the supported progress with the member.", evidenceIds: [evidenceIds.answer] }] },
    ],
    tasks: [],
    chart: {
      ...scope,
      chartId: `${answerId}:chart`,
      recipeId: "presentation-test",
      type: "bar",
      unit: "percent",
      precision: "date",
      temporalMode: "calendar",
      points: [
        { pointId: `${answerId}:point-1`, label: "May 28", value: 40, evidenceIds: [evidenceIds.trend] },
        { pointId: `${answerId}:point-2`, label: "Jun 4", value: 50, evidenceIds: [evidenceIds.trend] },
      ],
      textSummary: "May 28: 40 percent. Jun 4: 50 percent.",
    },
    citations: Object.entries(evidenceIds).map(([key, evidenceId]) => ({
      ...scope,
      citationId: `${answerId}:citation:${key}`,
      evidenceId,
      label: key === "source" ? "Member check-in" : `Synthetic ${key}`,
      source: SOURCE,
      classification: "observation" as const,
      temporal: { precision: "date" as const, effectiveOn: "2026-06-04" },
      unit: "percent",
    })),
    churn: {
      derived: {
        ...scope,
        methodVersion: "churn-v1" as const,
        level: "watch" as const,
        reasons: [{ code: "travel-week", evidenceIds: [evidenceIds.risk] }],
        excludedSourceReasons: [{ code: "unsupported-risk-note", basisStatus: "unsupported-source" as const, evidenceIds: [evidenceIds.source] }],
        evidenceIds: [evidenceIds.risk],
      },
      source: {
        ...scope,
        level: "watch",
        reasons: [{ text: "Travel may affect the next session.", basisStatus: "supported" as const, evidenceIds: [evidenceIds.source] }],
        evidenceIds: [evidenceIds.source],
      },
    },
    continuation,
  };
}

export async function installRichCopilotRoute(page: Page): Promise<void> {
  await page.route("**/api/copilot", async (route) => {
    const request = route.request().postDataJSON() as CopilotRequest;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ready",
        requestId: request.requestId,
        controls: { retry: false, refresh: false, keepLastReadyAnswer: false },
        answer: richAnswer(request),
      }),
    });
  });
}
