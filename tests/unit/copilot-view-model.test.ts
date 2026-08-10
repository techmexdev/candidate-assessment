import { describe, expect, it } from "vitest";

import type {
  CopilotAnswerPacket,
  CopilotChart,
  CopilotChurnView,
  CopilotCitation,
} from "../../src/domain/contracts/copilot";
import { buildCopilotAnswerViewModel, buildCopilotWorkbenchViewModel } from "../../src/features/coach-dashboard/copilot-view-model";

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
  it("bounds a rich churn-risk answer to one supported reason and one action while preserving omitted clauses", () => {
    const rich = packet("answer:rich-churn", {
      intentId: "churn-risk",
      sections: [
        { sectionId: "answer", clauses: [
          { clauseId: "answer:one", text: "weekly-workout-completion: 100 percent.", evidenceIds: ["evidence:answer"] },
          { clauseId: "answer:two", text: "weekly-workout-completion: 50 percent.", evidenceIds: ["evidence:answer"] },
          { clauseId: "answer:three", text: "Member message: skipped Thursday because work was exhausting.", evidenceIds: ["evidence:answer"] },
        ] },
        { sectionId: "next-action", clauses: [
          { clauseId: "action:one", text: "Review the missed-session pattern with the member.", evidenceIds: ["evidence:answer"] },
          { clauseId: "action:two", text: "Consider a shorter session.", evidenceIds: ["evidence:answer"] },
        ] },
      ],
      churn: {
        ...churn,
        source: {
          ...churn.source!,
          reasons: [
            { text: "Adherence fell from 100% to 50% over two weeks.", basisStatus: "supported", evidenceIds: ["evidence:answer"] },
            { text: "The member may cancel.", basisStatus: "unsupported-source", evidenceIds: ["evidence:answer"] },
          ],
        },
      },
    });

    const model = buildCopilotAnswerViewModel(rich);

    expect(model.primarySections).toEqual([]);
    expect(model.decisionSupport).toEqual({
      label: "Why",
      text: "Adherence fell 100% → 50% over two weeks.",
      evidenceIds: ["evidence:answer"],
      meta: null,
    });
    expect(model.nextAction?.clauses.map((clause) => clause.text)).toEqual([
      "Review the missed-session pattern with the member.",
    ]);
    const analysis = model.groups.find((group) => group.id === "analysis");
    expect(analysis?.label).toBe("Full analysis");
    expect(analysis?.sections.flatMap((section) => section.clauses.map((clause) => clause.text))).toEqual([
      "weekly-workout-completion: 100 percent.",
      "weekly-workout-completion: 50 percent.",
      "Member message: skipped Thursday because work was exhausting.",
      "Consider a shorter session.",
    ]);
    expect(analysis?.countLabel).toBe("4 statements");
  });

  it("omits the churn why when no human-readable source reason is supported", () => {
    const unsupportedOnly = packet("answer:unsupported-churn", {
      intentId: "churn-risk",
      sections: [
        { sectionId: "answer", clauses: [{ clauseId: "answer:raw", text: "weekly-workout-completion: 50 percent.", evidenceIds: ["evidence:answer"] }] },
        { sectionId: "next-action", clauses: [{ clauseId: "action", text: "Review risk with the member.", evidenceIds: ["evidence:answer"] }] },
      ],
      churn: {
        ...churn,
        source: {
          ...churn.source!,
          reasons: [{ text: "The member may cancel.", basisStatus: "unsupported-source", evidenceIds: ["evidence:answer"] }],
        },
      },
    });

    const model = buildCopilotAnswerViewModel(unsupportedOnly);

    expect(model.decisionSupport).toBeNull();
    expect(model.primarySections).toEqual([]);
    expect(model.groups.find((group) => group.id === "analysis")?.sections[0]?.clauses[0]?.text).toBe("weekly-workout-completion: 50 percent.");
  });

  it("makes the newest answer primary and keeps complete supporting content grouped by meaning", () => {
    const older = packet("answer:older");
    const latest = packet("answer:latest");

    const model = buildCopilotWorkbenchViewModel([older, latest]);

    expect(model.primary?.answer).toBe(latest);
    expect(model.previous.map((item) => item.answer.answerId)).toEqual(["answer:older"]);
    expect(model.primary?.primarySections.map((section) => section.sectionId)).toEqual(["limitation"]);
    expect(model.primary?.primarySections[0]?.clauses).toHaveLength(1);
    expect(model.primary?.nextAction?.sectionId).toBe("next-action");
    expect(model.primary?.nextAction?.clauses).toHaveLength(1);
    expect(model.primary?.freshness).toBe(latest.briefFreshness);
    expect(model.primary?.headlineRisk).toBe("watch");

    expect(model.primary?.groups.map((group) => group.id)).toEqual(["analysis", "facts", "trend", "risk", "sources"]);
    expect(model.primary?.groups.find((group) => group.id === "analysis")?.sections.map((section) => section.sectionId)).toEqual(["answer"]);
    expect(model.primary?.groups.find((group) => group.id === "facts")).toMatchObject({ countLabel: "1 fact" });
    expect(model.primary?.groups.find((group) => group.id === "facts")?.sections.map((section) => section.sectionId)).toEqual(["recent-facts"]);
    expect(model.primary?.groups.find((group) => group.id === "trend")?.countLabel).toBe("2 data points");
    expect(model.primary?.groups.find((group) => group.id === "trend")?.chart).toBe(latest.chart);
    expect(model.primary?.groups.find((group) => group.id === "risk")?.countLabel).toBe("2 reasons");
    expect(model.primary?.groups.find((group) => group.id === "risk")?.churn).toBe(latest.churn);
    expect(model.primary?.groups.find((group) => group.id === "sources")?.countLabel).toBe("1 reference");
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

  it("uses one highest-priority morning task and preserves additional tasks on demand", () => {
    const morning = packet("answer:morning", {
      intentId: "morning-brief",
      sections: [
        { sectionId: "answer", clauses: [
          { clauseId: "brief:one", text: "Coach task: Celebrate the completed session.", evidenceIds: ["evidence:celebrate"] },
          { clauseId: "brief:two", text: "Coach task: Review the missed session.", evidenceIds: ["evidence:risk"] },
        ] },
        { sectionId: "next-action", clauses: [{ clauseId: "action", text: "Check in with the member.", evidenceIds: ["evidence:action"] }] },
      ],
      tasks: [
        { taskId: "task:second", taskType: "review_risk", actionId: "review-churn-risk", text: "Review the missed session.", evidenceIds: ["evidence:risk"], sourceOrder: 1 },
        { taskId: "task:first", taskType: "celebrate", actionId: "celebrate-progress", text: "Celebrate the completed session.", evidenceIds: ["evidence:celebrate"], sourceOrder: 0 },
      ],
    });

    const model = buildCopilotAnswerViewModel(morning);

    expect(model.primarySections).toEqual([]);
    expect(model.decisionSupport).toMatchObject({ label: "Priority", text: "Celebrate the completed session.", meta: "1 more task" });
    expect(model.groups.find((group) => group.id === "analysis")?.sections.flatMap((section) => section.clauses.map((clause) => clause.text))).toEqual([
      "Coach task: Celebrate the completed session.",
      "Coach task: Review the missed session.",
    ]);
  });

  it("omits a morning next action that repeats the priority task evidence", () => {
    const morning = packet("answer:duplicate-action", {
      intentId: "morning-brief",
      sections: [
        { sectionId: "answer", clauses: [{ clauseId: "brief", text: "Coach task: Celebrate the completed session.", evidenceIds: ["evidence:celebrate"] }] },
        { sectionId: "next-action", clauses: [{ clauseId: "action", text: "Celebrate the completed session.", evidenceIds: ["evidence:celebrate"] }] },
      ],
      tasks: [{ taskId: "task:first", taskType: "celebrate", actionId: "celebrate-progress", text: "Celebrate the completed session.", evidenceIds: ["evidence:celebrate"], sourceOrder: 0 }],
    });

    const model = buildCopilotAnswerViewModel(morning);

    expect(model.nextAction).toBeNull();
    expect(model.groups.find((group) => group.id === "analysis")?.sections.flatMap((section) => section.clauses.map((clause) => clause.text))).toEqual([
      "Coach task: Celebrate the completed session.",
      "Celebrate the completed session.",
    ]);
  });

  it("keeps a distinct morning next action even when it shares priority evidence", () => {
    const morning = packet("answer:shared-evidence-action", {
      intentId: "morning-brief",
      sections: [
        { sectionId: "answer", clauses: [{ clauseId: "brief", text: "Coach task: Recognize the completed travel session.", evidenceIds: ["evidence:travel"] }] },
        { sectionId: "next-action", clauses: [{ clauseId: "action", text: "Check shoulder comfort before the next session.", evidenceIds: ["evidence:travel"] }] },
      ],
      tasks: [{ taskId: "task:first", taskType: "celebrate", actionId: "celebrate-progress", text: "Recognize the completed travel session.", evidenceIds: ["evidence:travel"], sourceOrder: 0 }],
    });

    const model = buildCopilotAnswerViewModel(morning);

    expect(model.nextAction?.clauses[0]?.text).toBe("Check shoulder comfort before the next session.");
  });

  it("uses the latest chart point for chart-backed intents and bounds fallback answers to one clause", () => {
    const adherence = packet("answer:adherence", {
      intentId: "adherence",
      churn: null,
      sections: [
        { sectionId: "answer", clauses: [
          { clauseId: "answer:first", text: "A long adherence explanation.", evidenceIds: ["evidence:answer"] },
          { clauseId: "answer:second", text: "Another adherence detail.", evidenceIds: ["evidence:answer"] },
        ] },
        { sectionId: "next-action", clauses: [{ clauseId: "action", text: "Review adherence.", evidenceIds: ["evidence:answer"] }] },
      ],
    });
    const generic = packet("answer:changes", {
      intentId: "changes-since-last-week",
      churn: null,
      chart: null,
      sections: [
        { sectionId: "answer", clauses: [
          { clauseId: "answer:first", text: "First supported change.", evidenceIds: ["evidence:answer"] },
          { clauseId: "answer:second", text: "Second supported change.", evidenceIds: ["evidence:answer"] },
        ] },
      ],
    });

    const adherenceModel = buildCopilotAnswerViewModel(adherence);
    expect(adherenceModel.decisionSupport).toMatchObject({ label: "Latest", text: "Jun 8 · 100%" });
    expect(adherenceModel.primarySections).toEqual([]);
    expect(adherenceModel.groups.find((group) => group.id === "analysis")?.itemCount).toBe(2);

    const genericModel = buildCopilotAnswerViewModel(generic);
    expect(genericModel.primarySections[0]?.clauses.map((clause) => clause.text)).toEqual(["First supported change."]);
    expect(genericModel.groups.find((group) => group.id === "analysis")?.sections[0]?.clauses.map((clause) => clause.text)).toEqual(["Second supported change."]);
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
