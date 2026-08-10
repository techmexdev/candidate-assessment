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

export const COPILOT_PRESENTATION_GROUP_IDS = ["analysis", "facts", "trend", "risk", "sources", "additional"] as const;
export type CopilotPresentationGroupId = (typeof COPILOT_PRESENTATION_GROUP_IDS)[number];

export type CopilotDecisionSupport = {
  readonly label: "Why" | "Priority" | "Latest";
  readonly text: string;
  readonly evidenceIds: readonly string[];
  readonly meta: string | null;
};

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
  readonly countLabel: string;
};

export type CopilotAnswerViewModel = {
  readonly answer: CopilotAnswerPacket;
  readonly primarySections: readonly CopilotAnswerSection[];
  readonly nextAction: CopilotAnswerSection | null;
  readonly tasks: readonly CopilotMorningTask[];
  readonly freshness: CopilotBriefFreshness | null;
  readonly headlineRisk: CopilotDerivedChurnLevel | null;
  readonly decisionSupport: CopilotDecisionSupport | null;
  readonly groups: readonly CopilotPresentationGroup[];
};

export type CopilotWorkbenchViewModel = {
  readonly primary: CopilotAnswerViewModel | null;
  readonly previous: readonly CopilotAnswerViewModel[];
};

const groupLabels: Readonly<Record<CopilotPresentationGroupId, string>> = {
  analysis: "Full analysis",
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

function sectionWithClauses(
  section: CopilotAnswerSection,
  clauses: CopilotAnswerSection["clauses"],
): CopilotAnswerSection | null {
  return clauses.length > 0 ? { ...section, clauses } : null;
}

function firstClause(section: CopilotAnswerSection | null): CopilotAnswerSection | null {
  return section ? sectionWithClauses(section, section.clauses.slice(0, 1)) : null;
}

function remainingClauses(section: CopilotAnswerSection | null): CopilotAnswerSection | null {
  return section ? sectionWithClauses(section, section.clauses.slice(1)) : null;
}

function mergeSections(sections: readonly (CopilotAnswerSection | null)[]): readonly CopilotAnswerSection[] {
  const merged = new Map<string, CopilotAnswerSection>();
  for (const section of sections) {
    if (!section || !hasContent(section)) continue;
    const current = merged.get(section.sectionId);
    merged.set(section.sectionId, current
      ? { ...current, clauses: [...current.clauses, ...section.clauses] }
      : section);
  }
  return [...merged.values()];
}

function compactTrendCopy(text: string): string {
  return text.replace(
    /\bfrom\s+(-?\d+(?:\.\d+)?%?)\s+to\s+(-?\d+(?:\.\d+)?%?)/gi,
    "$1 → $2",
  );
}

function decisionSupportFor(
  answer: CopilotAnswerPacket,
  orderedTasks: readonly CopilotMorningTask[],
): CopilotDecisionSupport | null {
  if (answer.intentId === "churn-risk") {
    const reason = answer.churn?.source?.reasons.find((candidate) => candidate.basisStatus === "supported");
    return reason ? { label: "Why", text: compactTrendCopy(reason.text), evidenceIds: reason.evidenceIds, meta: null } : null;
  }

  if (answer.intentId === "morning-brief") {
    const task = orderedTasks[0];
    const remainingCount = Math.max(0, orderedTasks.length - 1);
    return task ? {
      label: "Priority",
      text: task.text,
      evidenceIds: task.evidenceIds,
      meta: remainingCount > 0 ? `${remainingCount} more ${remainingCount === 1 ? "task" : "tasks"}` : null,
    } : null;
  }

  if ((answer.intentId === "adherence" || answer.intentId === "sleep") && answer.chart) {
    const latest = answer.chart.points.at(-1);
    if (latest) return {
      label: "Latest",
      text: `${latest.label} · ${answer.chart.unit === "percent" ? `${latest.value}%` : `${latest.value} ${answer.chart.unit}`}`,
      evidenceIds: latest.evidenceIds,
      meta: null,
    };
  }

  return null;
}

function analysisCountLabel(itemCount: number): string {
  return `${itemCount} ${itemCount === 1 ? "statement" : "statements"}`;
}

function groupCountLabel(
  id: CopilotPresentationGroupId,
  itemCount: number,
  sections: readonly CopilotAnswerSection[],
  chart: CopilotChart | null,
  churn: CopilotChurnView | null,
  citations: readonly CopilotCitation[],
): string {
  if (id === "analysis" || id === "additional") return analysisCountLabel(itemCount);
  if (id === "facts") {
    const count = sections.reduce((total, section) => total + section.clauses.length, 0);
    return `${count} ${count === 1 ? "fact" : "facts"}`;
  }
  if (id === "trend") {
    const count = chart?.points.length ?? sections.reduce((total, section) => total + section.clauses.length, 0);
    return `${count} ${chart ? (count === 1 ? "data point" : "data points") : (count === 1 ? "statement" : "statements")}`;
  }
  if (id === "risk" && churn) {
    const count = churn.derived.reasons.length + churn.derived.excludedSourceReasons.length + (churn.source?.reasons.length ?? 0);
    return `${count} ${count === 1 ? "reason" : "reasons"}`;
  }
  if (id === "sources") {
    if (citations.length === 0) return "Revision details";
    return `${citations.length} ${citations.length === 1 ? "reference" : "references"}`;
  }
  return `${itemCount} ${itemCount === 1 ? "item" : "items"}`;
}

function taskIsRepresented(task: CopilotMorningTask, sections: readonly CopilotAnswerSection[]): boolean {
  const text = task.text.trim().toLocaleLowerCase();
  return sections.some((section) => section.clauses.some((clause) => clause.text.trim().toLocaleLowerCase().includes(text)));
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
    countLabel: groupCountLabel(id, itemCount, sections, chart, churn, citations),
  };
}

export function buildCopilotAnswerViewModel(answer: CopilotAnswerPacket): CopilotAnswerViewModel {
  const meaningfulAnswer = answer.sections.find((section) => section.sectionId === "answer" && hasContent(section)) ?? null;
  const meaningfulLimitation = answer.sections.find((section) => section.sectionId === "limitation" && hasContent(section)) ?? null;
  const fallback = firstMeaningfulSection(answer.sections, new Set(["next-action"]));
  const nextActionSource = answer.sections.find((section) => section.sectionId === "next-action" && hasContent(section)) ?? null;
  const orderedTasks = [...answer.tasks].sort((left, right) => left.sourceOrder - right.sourceOrder);
  const decisionSupport = meaningfulLimitation ? null : decisionSupportFor(answer, orderedTasks);
  const suppressRawPrimary = !meaningfulLimitation && answer.intentId === "churn-risk";
  const fallbackPrimary = meaningfulAnswer ?? fallback;
  const primarySource = meaningfulLimitation ?? (decisionSupport || suppressRawPrimary ? null : fallbackPrimary);
  const primarySections = uniqueSections([firstClause(primarySource)]);
  const nextAction = firstClause(nextActionSource);
  const analysisSections = mergeSections([
    meaningfulLimitation ? meaningfulAnswer : null,
    remainingClauses(primarySource),
    decisionSupport || suppressRawPrimary ? meaningfulAnswer : null,
    remainingClauses(nextActionSource),
    answer.intentId === "morning-brief" && orderedTasks.length > 1
      ? {
          sectionId: "morning-brief",
          clauses: orderedTasks
            .slice(1)
            .filter((task) => !taskIsRepresented(task, answer.sections))
            .map((task) => ({ clauseId: task.taskId, text: task.text, evidenceIds: task.evidenceIds })),
        }
      : null,
  ]);
  const consumedIds = new Set(["answer", "limitation", "next-action", ...primarySections.map((section) => section.sectionId)]);
  const facts = answer.sections.filter((section) => !consumedIds.has(section.sectionId) && FACT_SECTION_IDS.has(section.sectionId) && hasContent(section));
  const trend = answer.sections.filter((section) => !consumedIds.has(section.sectionId) && TREND_SECTION_IDS.has(section.sectionId) && hasContent(section));
  const knownIds = new Set([...consumedIds, ...facts.map((section) => section.sectionId), ...trend.map((section) => section.sectionId)]);
  const additional = answer.sections.filter((section) => !knownIds.has(section.sectionId) && hasContent(section));
  const groups = [
    buildGroup(answer, "analysis", analysisSections),
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
    decisionSupport,
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
