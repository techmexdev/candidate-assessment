import type {
  CopilotAnswerPacket,
  CopilotAnswerSection,
  CopilotBriefFreshness,
  CopilotCitation,
  CopilotChart,
  CopilotChurnView,
  CopilotDerivedChurnLevel,
  CopilotMorningTask,
} from "../../domain/contracts/copilot";

export const COPILOT_PRESENTATION_GROUP_IDS = ["facts", "trend", "risk", "sources", "additional"] as const;
export type CopilotPresentationGroupId = (typeof COPILOT_PRESENTATION_GROUP_IDS)[number];

export type CopilotPresentationRevision = {
  readonly contextRevisionId: string;
  readonly evidenceAsOf: string;
  readonly memberTimezone: string;
};

export type CopilotPresentationGroup = {
  readonly id: CopilotPresentationGroupId;
  readonly label: string;
  readonly sections: readonly CopilotAnswerSection[];
  readonly chart: CopilotChart | null;
  readonly churn: CopilotChurnView | null;
  readonly citations: readonly CopilotCitation[];
  readonly revision: CopilotPresentationRevision;
  readonly itemCount: number;
};

export type CopilotAnswerViewModel = {
  readonly answer: CopilotAnswerPacket;
  readonly primarySections: readonly CopilotAnswerSection[];
  readonly nextAction: CopilotAnswerSection | null;
  readonly tasks: readonly CopilotMorningTask[];
  readonly freshness: CopilotBriefFreshness | null;
  readonly headlineRisk: CopilotDerivedChurnLevel | null;
  readonly groups: readonly CopilotPresentationGroup[];
};

export type CopilotWorkbenchViewModel = {
  readonly primary: CopilotAnswerViewModel | null;
  readonly previous: readonly CopilotAnswerViewModel[];
};

const groupLabels: Readonly<Record<CopilotPresentationGroupId, string>> = {
  facts: "Facts and context",
  trend: "Trend and chart",
  risk: "Risk reasoning",
  sources: "Sources and revision",
  additional: "Additional context",
};

const FACT_SECTION_IDS = new Set(["recent-facts", "stable-context", "morning-brief"]);
const TREND_SECTION_IDS = new Set(["trend"]);

function hasContent(section: CopilotAnswerSection): boolean {
  return section.clauses.some((clause) => clause.text.trim().length > 0);
}

function firstMeaningfulSection(
  sections: readonly CopilotAnswerSection[],
  excludeIds: ReadonlySet<string> = new Set(),
): CopilotAnswerSection | null {
  return sections.find((section) => !excludeIds.has(section.sectionId) && hasContent(section)) ?? null;
}

function uniqueSections(sections: readonly (CopilotAnswerSection | null)[]): readonly CopilotAnswerSection[] {
  const seen = new Set<string>();
  return sections.filter((section): section is CopilotAnswerSection => {
    if (!section || seen.has(section.sectionId) || !hasContent(section)) return false;
    seen.add(section.sectionId);
    return true;
  });
}

function groupItemCount(
  sections: readonly CopilotAnswerSection[],
  chart: CopilotChart | null,
  churn: CopilotChurnView | null,
  citations: readonly CopilotCitation[],
  includesRevision: boolean,
): number {
  return sections.reduce((count, section) => count + section.clauses.length, 0)
    + (chart ? chart.points.length : 0)
    + (churn ? 1 : 0)
    + citations.length
    + (includesRevision ? 1 : 0);
}

function buildGroup(
  answer: CopilotAnswerPacket,
  id: CopilotPresentationGroupId,
  sections: readonly CopilotAnswerSection[],
  options: {
    readonly chart?: CopilotChart | null;
    readonly churn?: CopilotChurnView | null;
    readonly citations?: readonly CopilotCitation[];
    readonly includesRevision?: boolean;
  } = {},
): CopilotPresentationGroup | null {
  const chart = options.chart ?? null;
  const churn = options.churn ?? null;
  const citations = options.citations ?? [];
  const includesRevision = options.includesRevision ?? false;
  const itemCount = groupItemCount(sections, chart, churn, citations, includesRevision);
  if (itemCount === 0) return null;

  return {
    id,
    label: groupLabels[id],
    sections,
    chart,
    churn,
    citations,
    revision: {
      contextRevisionId: answer.contextRevisionId,
      evidenceAsOf: answer.evidenceAsOf,
      memberTimezone: answer.memberTimezone,
    },
    itemCount,
  };
}

export function buildCopilotAnswerViewModel(answer: CopilotAnswerPacket): CopilotAnswerViewModel {
  const meaningfulAnswer = answer.sections.find((section) => section.sectionId === "answer" && hasContent(section)) ?? null;
  const meaningfulLimitation = answer.sections.find((section) => section.sectionId === "limitation" && hasContent(section)) ?? null;
  const fallback = firstMeaningfulSection(answer.sections, new Set(["next-action"]));
  const primarySections = uniqueSections([meaningfulAnswer ?? meaningfulLimitation ?? fallback, meaningfulAnswer ? meaningfulLimitation : null]);
  const primaryIds = new Set(primarySections.map((section) => section.sectionId));
  const nextAction = answer.sections.find((section) => section.sectionId === "next-action" && hasContent(section)) ?? null;
  const consumedIds = new Set([...primaryIds, "next-action"]);
  const facts = answer.sections.filter((section) => !consumedIds.has(section.sectionId) && FACT_SECTION_IDS.has(section.sectionId) && hasContent(section));
  const trend = answer.sections.filter((section) => !consumedIds.has(section.sectionId) && TREND_SECTION_IDS.has(section.sectionId) && hasContent(section));
  const knownIds = new Set([...consumedIds, ...facts.map((section) => section.sectionId), ...trend.map((section) => section.sectionId)]);
  const additional = answer.sections.filter((section) => !knownIds.has(section.sectionId) && hasContent(section));
  const groups = [
    buildGroup(answer, "facts", facts),
    buildGroup(answer, "trend", trend, { chart: answer.chart }),
    buildGroup(answer, "risk", [], { churn: answer.churn }),
    buildGroup(answer, "sources", [], { citations: answer.citations, includesRevision: true }),
    buildGroup(answer, "additional", additional),
  ].filter((group): group is CopilotPresentationGroup => Boolean(group));

  return {
    answer,
    primarySections,
    nextAction,
    tasks: answer.tasks,
    freshness: answer.briefFreshness,
    headlineRisk: answer.churn?.derived.level ?? null,
    groups,
  };
}

export function buildCopilotWorkbenchViewModel(answers: readonly CopilotAnswerPacket[]): CopilotWorkbenchViewModel {
  if (answers.length === 0) return { primary: null, previous: [] };
  const latestIndex = answers.length - 1;
  return {
    primary: buildCopilotAnswerViewModel(answers[latestIndex]),
    previous: answers.slice(0, latestIndex).map(buildCopilotAnswerViewModel),
  };
}
