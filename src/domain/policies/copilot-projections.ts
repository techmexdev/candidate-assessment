import type {
  CopilotBriefFreshness,
  CopilotChart,
  CopilotChartPoint,
  CopilotCitation,
  CopilotEvidenceAtom,
  CopilotFactEvidenceAtom,
  CopilotScopeEnvelope,
} from "../contracts/copilot";
import type {
  CitationProjection,
  MemberEvidenceProjection,
  MessageProjection,
} from "../contracts/member-context-queries";
import type { AssertionTemporal } from "../contracts/member-context";

type TemporalValue = { readonly temporal: AssertionTemporal };

function offsetAt(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const representedAsUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  const instantAtWholeSecond = Math.trunc(instant.getTime() / 1_000) * 1_000;
  return representedAsUtc - instantAtWholeSecond;
}

function zonedInstant(
  date: string,
  timezone: string,
  time: Readonly<{ hour: number; minute: number; second: number; millisecond: number }>,
): Date {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) throw new Error("Invalid calendar date.");
  const wallClock = Date.UTC(year, month - 1, day, time.hour, time.minute, time.second, time.millisecond);
  let candidate = new Date(wallClock);
  candidate = new Date(wallClock - offsetAt(candidate, timezone));
  candidate = new Date(wallClock - offsetAt(candidate, timezone));
  return candidate;
}

function localDate(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}

export function calculateCalendarWindow(input: Readonly<{
  evidenceAsOf: string;
  timezone: string;
  lookbackDays: number;
}>): Readonly<{ fromInclusive: string; toExclusive: string }> {
  if (!Number.isInteger(input.lookbackDays) || input.lookbackDays < 1 || input.lookbackDays > 366) {
    throw new Error("Calendar window is outside the supported bound.");
  }
  const anchor = new Date(input.evidenceAsOf);
  if (!Number.isFinite(anchor.getTime())) throw new Error("Evidence as-of timestamp is invalid.");
  const anchorDate = localDate(anchor, input.timezone);
  const fromDate = addCalendarDays(anchorDate, -(input.lookbackDays - 1));
  const toDate = addCalendarDays(anchorDate, 1);
  return {
    fromInclusive: zonedInstant(fromDate, input.timezone, { hour: 0, minute: 0, second: 0, millisecond: 0 }).toISOString(),
    toExclusive: zonedInstant(toDate, input.timezone, { hour: 0, minute: 0, second: 0, millisecond: 0 }).toISOString(),
  };
}

export function deriveEvidenceAsOf(values: readonly TemporalValue[], timezone: string): string {
  const candidates = values.flatMap((value) => {
    if (value.temporal.precision === "exact-timestamp") {
      const instant = new Date(value.temporal.effectiveAt);
      return [{ timestamp: instant.getTime(), rendered: instant.toISOString() }];
    }
    if (value.temporal.precision === "date") {
      if (!isCalendarDate(value.temporal.effectiveOn)) return [];
      const instant = zonedInstant(value.temporal.effectiveOn, timezone, {
        hour: 23,
        minute: 59,
        second: 59,
        millisecond: 999,
      });
      return [{
        timestamp: instant.getTime(),
        rendered: `${value.temporal.effectiveOn}T23:59:59.999${formatOffset(instant, timezone)}`,
      }];
    }
    return [];
  }).filter((candidate) => Number.isFinite(candidate.timestamp));
  if (candidates.length === 0) throw new Error("Authoritative evidence has no timestamp anchor.");
  return candidates.sort((left, right) => left.timestamp - right.timestamp).at(-1)!.rendered;
}

function formatOffset(instant: Date, timezone: string): string {
  const offsetMinutes = Math.round(offsetAt(instant, timezone) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

export function deriveBriefFreshness(requestedFor: string, generatedFor: string): CopilotBriefFreshness {
  return {
    status: requestedFor === generatedFor ? "requested-date" : "latest-recorded",
    generatedFor,
  };
}

function atomLabel(atom: CopilotFactEvidenceAtom, temporalMode: CopilotChart["temporalMode"]): string {
  if (temporalMode === "relative-order") {
    if (atom.temporal.precision !== "relative-order") throw new Error("Relative-order chart requires relative-order evidence.");
    return `Recorded ${atom.temporal.sourceOrder + 1}`;
  }
  if (atom.temporal.precision === "date") return atom.temporal.effectiveOn;
  if (atom.temporal.precision === "exact-timestamp") return atom.temporal.effectiveAt;
  throw new Error("Calendar chart requires dated evidence.");
}

function temporalRank(atom: CopilotFactEvidenceAtom): number {
  if (atom.temporal.precision === "relative-order") return atom.temporal.sourceOrder;
  if (atom.temporal.precision === "date") return Date.parse(`${atom.temporal.effectiveOn}T00:00:00.000Z`);
  if (atom.temporal.precision === "exact-timestamp") return Date.parse(atom.temporal.effectiveAt);
  return Number.NaN;
}

export function summarizeCopilotChartPoints(points: readonly CopilotChartPoint[], unit: string): string {
  return `${points.map((point) => `${point.label}: ${point.value} ${unit}`).join("; ")}.`;
}

export type CopilotChartProjectionResult =
  | { readonly status: "ready"; readonly chart: CopilotChart }
  | { readonly status: "insufficient-history"; readonly requiredPoints: number; readonly availablePoints: number; readonly chart: null };

export function createCopilotChart(input: Readonly<{
  scope: CopilotScopeEnvelope;
  chartId: string;
  recipeId: string;
  type: CopilotChart["type"];
  temporalMode: CopilotChart["temporalMode"];
  minimumPoints: number;
  atoms: readonly CopilotFactEvidenceAtom[];
}>): CopilotChartProjectionResult {
  if (!Number.isInteger(input.minimumPoints) || input.minimumPoints < 1) throw new Error("Chart minimum is invalid.");
  if (input.atoms.length < input.minimumPoints) {
    return { status: "insufficient-history", requiredPoints: input.minimumPoints, availablePoints: input.atoms.length, chart: null };
  }
  const first = input.atoms[0]!;
  if (typeof first.value !== "number" || !Number.isFinite(first.value) || !first.unit) throw new Error("Chart points require numeric unit-bearing evidence.");
  const precision = first.temporal.precision;
  const evidenceIds = new Set<string>();
  for (const atom of input.atoms) {
    if (atom.memberId !== input.scope.memberId
      || atom.contextRevisionId !== input.scope.contextRevisionId
      || atom.authority !== input.scope.authority
      || atom.unit !== first.unit
      || atom.temporal.precision !== precision
      || typeof atom.value !== "number"
      || !Number.isFinite(atom.value)
      || evidenceIds.has(atom.evidenceId)) {
      throw new Error("Chart evidence mixes scope, unit, precision, value type, or identity.");
    }
    if ((input.temporalMode === "relative-order") !== (atom.temporal.precision === "relative-order")) {
      throw new Error("Chart temporal mode does not match point precision.");
    }
    evidenceIds.add(atom.evidenceId);
  }
  const sorted = [...input.atoms].sort((left, right) => temporalRank(left) - temporalRank(right) || left.evidenceId.localeCompare(right.evidenceId));
  const points = sorted.map((atom, index): CopilotChartPoint => ({
    pointId: `${input.chartId}:${index}`,
    label: atomLabel(atom, input.temporalMode),
    value: atom.value as number,
    evidenceIds: [atom.evidenceId],
  }));
  return {
    status: "ready",
    chart: {
      ...input.scope,
      chartId: input.chartId,
      recipeId: input.recipeId,
      type: input.type,
      unit: first.unit,
      precision,
      temporalMode: input.temporalMode,
      points,
      textSummary: summarizeCopilotChartPoints(points, first.unit),
    },
  };
}

function normalizedValue(item: MemberEvidenceProjection | MessageProjection): string | number | boolean | null {
  switch (item.kind) {
    case "observation": return item.value;
    case "member-profile": return item.timezone;
    case "goal": return item.text;
    case "preference": return item.preferredSessionMinutes;
    case "workout-session": return item.completed;
    case "coach-brief": return item.generatedFor;
    case "coach-task": return item.text;
    case "churn-assessment": return item.level;
    case "churn-reason": return item.text;
    case "message": return "senderRole" in item ? item.senderRole : null;
    default: return null;
  }
}

export function normalizeMemberEvidence(
  scope: CopilotScopeEnvelope,
  item: MemberEvidenceProjection | MessageProjection,
): CopilotEvidenceAtom {
  if (item.kind === "media-attachment") {
    return {
      ...scope,
      atomKind: "media-metadata",
      evidenceId: item.evidenceId,
      evidenceKind: item.kind,
      source: item.source,
      classification: item.classification,
      temporal: item.temporal,
      mediaType: item.mediaType,
      caption: item.caption,
      assetStatus: "metadata-only",
      analysisStatus: "not-analyzed",
      unit: null,
    };
  }
  return {
    ...scope,
    atomKind: "fact",
    evidenceId: item.evidenceId,
    evidenceKind: item.kind,
    source: item.source,
    classification: item.classification,
    temporal: item.temporal,
    value: normalizedValue(item),
    unit: item.kind === "observation" ? item.unit : null,
  };
}

export function normalizeCitation(
  scope: CopilotScopeEnvelope,
  citation: CitationProjection,
  item: MemberEvidenceProjection | MessageProjection,
): CopilotCitation {
  if (citation.evidenceId !== item.evidenceId) throw new Error("Citation does not match normalized evidence.");
  return {
    ...scope,
    citationId: `citation:${citation.evidenceId}`,
    evidenceId: citation.evidenceId,
    label: citation.source.locator,
    source: citation.source,
    classification: citation.classification,
    temporal: citation.temporal,
    unit: item.kind === "observation" ? item.unit : null,
  };
}
