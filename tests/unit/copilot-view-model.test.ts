import { describe, expect, it } from "vitest";

import type {
  CopilotAnswerPacket,
  CopilotChart,
  CopilotChurnView,
  CopilotCitation,
} from "../../src/domain/contracts/copilot";
import { buildCopilotWorkbenchViewModel } from "../../src/features/coach-dashboard/copilot-view-model";

const scope = {
  memberId: "mbr_jordan",
  contextRevisionId: "member-context:r1",
  authority: "canonical" as const,
};

const continuation = {
  schemaVersion: "signed-copilot-continuation/v1" as const,
  algorithm: "hmac-sha256" as const,
  claims: {
    schemaVersion: "copilot-continuation-claims/v1" as const,
    coachId: "coach:casey",
    memberId: scope.memberId,
    contextRevisionId: scope.contextRevisionId,
    answerId: "answer:latest",
    intentId: "morning-brief" as const,
    selectedEvidenceIds: ["evidence:answer"],
    issuedAt: "2026-07-08T10:00:00.000Z",
    expiresAt: "2026-07-08T11:00:00.000Z",
  },
  signature: "signed-continuation",
};

const chart: CopilotChart = {
  ...scope,
  chartId: "chart:adherence",
  recipeId: "adherence-four-weeks",
  type: "bar",
  unit: "percent",
  precision: "date",
  temporalMode: "calendar",
  points: [
    { pointId: "point:one", label: "Jun 1", value: 75, evidenceIds: ["evidence:answer"] },
    { pointId: "point:two", label: "Jun 8", value: 100, evidenceIds: ["evidence:answer"] },
  ],
  textSummary: "Jun 1: 75 percent; Jun 8: 100 percent.",
};

const churn: CopilotChurnView = {
  derived: {
    ...scope,
    methodVersion: "churn-v1",
    level: "watch",
    reasons: [{ code: "missed-session", evidenceIds: ["evidence:answer"] }],
    excludedSourceReasons: [],
    evidenceIds: ["evidence:answer"],
  },
  source: {
    ...scope,
    level: "high",
    reasons: [{ text: "Coach-entered concern", basisStatus: "supported", evidenceIds: ["evidence:answer"] }],
    evidenceIds: ["evidence:answer"],
  },
};

const citation: CopilotCitation = {
  ...scope,
  citationId: "citation:answer",
  evidenceId: "evidence:answer",
  label: "Weekly completion",
  source: { locator: "/adherence/weekly", artifactDigest: "sha256:source" },
  classification: "observation",
  temporal: { precision: "date", effectiveOn: "2026-06-08" },
  unit: "percent",
};

function packet(
  answerId: string,
  overrides: Partial<CopilotAnswerPacket> = {},
): CopilotAnswerPacket {
  const answerScope = { ...scope, contextRevisionId: `member-context:${answerId}` };
  return {
    schemaVersion: "copilot-answer/v1",
    requestId: `request:${answerId}`,
    answerId,
    ...answerScope,
    intentId: "morning-brief",
    requestedFor: "2026-07-08",
    evidenceAsOf: "2026-06-08T23:59:59.999-05:00",
    memberTimezone: "America/Chicago",
    briefFreshness: { status: "latest-recorded", generatedFor: "2026-06-08" },
    evidence: {
      ...answerScope,
      atoms: [{
        ...answerScope,
        atomKind: "fact",
        evidenceId: "evidence:answer",
        evidenceKind: "observation",
        source: { locator: "/adherence/weekly", artifactDigest: "sha256:source" },
        classification: "observation",
        temporal: { precision: "date", effectiveOn: "2026-06-08" },
        unit: "percent",
        value: 100,
      }],
    },
    sections: [
      { sectionId: "answer", clauses: [{ clauseId: `clause:${answerId}`, text: `Primary ${answerId}`, evidenceIds: ["evidence:answer"] }] },
      { sectionId: "next-action", clauses: [{ clauseId: `action:${answerId}`, text: "Review this with the member.", evidenceIds: ["evidence:answer"] }] },
      { sectionId: "recent-facts", clauses: [{ clauseId: `fact:${answerId}`, text: "Completion reached 100 percent.", evidenceIds: ["evidence:answer"] }] },
      { sectionId: "trend", clauses: [{ clauseId: `trend:${answerId}`, text: "Adherence is improving.", evidenceIds: ["evidence:answer"] }] },
      { sectionId: "limitation", clauses: [{ clauseId: `limitation:${answerId}`, text: "The packet is limited to recorded sessions.", evidenceIds: ["evidence:answer"] }] },
    ],
    tasks: [],
    chart: { ...chart, ...answerScope },
    citations: [{ ...citation, ...answerScope }],
    churn: { derived: { ...churn.derived, ...answerScope }, source: churn.source ? { ...churn.source, ...answerScope } : null },
    continuation: { ...continuation, claims: { ...continuation.claims, answerId, contextRevisionId: answerScope.contextRevisionId } },
    ...overrides,
  };
}

describe("Copilot presentation view model", () => {
  it("makes the newest answer primary and keeps complete supporting content grouped by meaning", () => {
    const older = packet("answer:older");
    const latest = packet("answer:latest");

    const model = buildCopilotWorkbenchViewModel([older, latest]);

    expect(model.primary?.answer).toBe(latest);
    expect(model.previous.map((item) => item.answer.answerId)).toEqual(["answer:older"]);
    expect(model.primary?.primarySections.map((section) => section.sectionId)).toEqual(["answer", "limitation"]);
    expect(model.primary?.nextAction?.sectionId).toBe("next-action");
    expect(model.primary?.freshness).toBe(latest.briefFreshness);
    expect(model.primary?.headlineRisk).toBe("watch");

    expect(model.primary?.groups.map((group) => group.id)).toEqual(["facts", "trend", "risk", "sources"]);
    expect(model.primary?.groups.find((group) => group.id === "facts")?.sections.map((section) => section.sectionId)).toEqual(["recent-facts"]);
    expect(model.primary?.groups.find((group) => group.id === "trend")?.chart).toBe(latest.chart);
    expect(model.primary?.groups.find((group) => group.id === "risk")?.churn).toBe(latest.churn);
    expect(model.primary?.groups.find((group) => group.id === "sources")?.citations).toBe(latest.citations);
    expect(model.primary?.groups.find((group) => group.id === "sources")?.revision.contextRevisionId).toBe(latest.contextRevisionId);
  });

  it("uses a truthful limitation or first meaningful section when an answer section is absent", () => {
    const limitationOnly = packet("answer:limited", {
      sections: [{ sectionId: "limitation", clauses: [{ clauseId: "limitation", text: "Insufficient history.", evidenceIds: ["evidence:answer"] }] }],
      chart: null,
      citations: [],
      churn: null,
    });

    const model = buildCopilotWorkbenchViewModel([limitationOnly]);

    expect(model.primary?.primarySections.map((section) => section.sectionId)).toEqual(["limitation"]);
    expect(model.primary?.groups.map((group) => group.id)).toEqual(["sources"]);
    expect(model.primary?.groups.find((group) => group.id === "sources")?.itemCount).toBe(1);
  });

  it("omits empty groups and preserves every unknown section in additional context", () => {
    const sparse = packet("answer:sparse", {
      sections: [
        { sectionId: "answer", clauses: [{ clauseId: "answer", text: "A bounded answer.", evidenceIds: ["evidence:answer"] }] },
        { sectionId: "morning-brief", clauses: [{ clauseId: "brief", text: "A brief detail.", evidenceIds: ["evidence:answer"] }] },
      ],
      chart: null,
      citations: [],
      churn: null,
    });

    const model = buildCopilotWorkbenchViewModel([sparse]);

    expect(model.primary?.groups.map((group) => group.id)).toEqual(["facts", "sources"]);
    expect(model.primary?.groups.find((group) => group.id === "facts")?.sections).toEqual([sparse.sections[1]]);
    expect(model.primary?.groups.some((group) => group.itemCount === 0)).toBe(false);
    expect(buildCopilotWorkbenchViewModel([])).toEqual({ primary: null, previous: [] });
  });
});
