import {
  COPILOT_CANONICAL_INTENT_IDS,
  COPILOT_SECTION_IDS,
  createCopilotAnswerPacket,
  type CopilotAnswerClause,
  type CopilotAnswerPacket,
  type CopilotAnswerSection,
  type CopilotChart,
  type CopilotChartPoint,
  type CopilotChurnView,
  type CopilotCitation,
  type CopilotDerivedChurnAssessment,
  type CopilotEvidenceAtom,
  type CopilotEvidencePack,
  type CopilotQuickPromptId,
  type CopilotScopeEnvelope,
  type CopilotSourceChurnAssessment,
  type SignedCopilotContinuation,
} from "../../domain/contracts/copilot";
import {
  MEMBER_CONTEXT_REVISION_SCOPED_NODE_KINDS,
  type AssertionClassification,
  type AssertionSource,
  type AssertionTemporal,
} from "../../domain/contracts/member-context";
import { isCopilotQuickPromptId } from "../../domain/policies/copilot-retrieval-plan";
import type {
  DashboardCopilotClient,
  DashboardCopilotControls,
  DashboardCopilotOutcome,
  DashboardCopilotRequest,
} from "./dashboard-contract";

const retryControls = Object.freeze({ retry: true, refresh: false, keepLastReadyAnswer: true });
const cancelledControls = Object.freeze({ retry: false, refresh: false, keepLastReadyAnswer: true });
const assertionClassifications = [
  "identity",
  "source-statement",
  "observation",
  "source-provided-assessment",
  "system-derived-assessment",
  "graph-lineage",
  "publication-state",
] as const satisfies readonly AssertionClassification[];
const chartPrecisions = ["exact-timestamp", "date", "relative-order", "unknown"] as const;
const churnLevels = ["low", "watch", "elevated", "insufficient-evidence"] as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function oneOf<const Values extends readonly string[]>(value: unknown, values: Values): value is Values[number] {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function scalar(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function decodedArray<Value>(value: unknown, decode: (item: unknown) => Value | null): Value[] | null {
  if (!Array.isArray(value)) return null;
  const decoded: Value[] = [];
  for (const item of value) {
    const next = decode(item);
    if (next === null) return null;
    decoded.push(next);
  }
  return decoded;
}

function controls(value: unknown): DashboardCopilotControls | null {
  if (!record(value)
    || typeof value.retry !== "boolean"
    || typeof value.refresh !== "boolean"
    || typeof value.keepLastReadyAnswer !== "boolean") return null;
  return {
    retry: value.retry,
    refresh: value.refresh,
    keepLastReadyAnswer: value.keepLastReadyAnswer,
  };
}

function decodeScope(value: unknown): CopilotScopeEnvelope | null {
  if (!record(value)
    || typeof value.memberId !== "string"
    || typeof value.contextRevisionId !== "string"
    || (value.authority !== "canonical" && value.authority !== "fixture")) return null;
  return { memberId: value.memberId, contextRevisionId: value.contextRevisionId, authority: value.authority };
}

function decodeSource(value: unknown): AssertionSource | null {
  if (!record(value) || typeof value.locator !== "string" || typeof value.artifactDigest !== "string") return null;
  return { locator: value.locator, artifactDigest: value.artifactDigest };
}

function decodeTemporal(value: unknown): AssertionTemporal | null {
  if (!record(value)) return null;
  switch (value.precision) {
    case "exact-timestamp": return typeof value.effectiveAt === "string" ? { precision: value.precision, effectiveAt: value.effectiveAt } : null;
    case "date": return typeof value.effectiveOn === "string" ? { precision: value.precision, effectiveOn: value.effectiveOn } : null;
    case "relative-order": return Number.isInteger(value.sourceOrder) ? { precision: value.precision, sourceOrder: value.sourceOrder as number } : null;
    case "unknown": return { precision: value.precision };
    default: return null;
  }
}

function decodeEvidenceAtom(value: unknown): CopilotEvidenceAtom | null {
  const scope = decodeScope(value);
  if (!scope || !record(value)
    || typeof value.evidenceId !== "string"
    || !oneOf(value.evidenceKind, MEMBER_CONTEXT_REVISION_SCOPED_NODE_KINDS)
    || !oneOf(value.classification, assertionClassifications)) return null;
  const source = decodeSource(value.source);
  const temporal = decodeTemporal(value.temporal);
  if (!source || !temporal) return null;
  if (value.atomKind === "fact") {
    if (!scalar(value.value) || (value.unit !== null && typeof value.unit !== "string")) return null;
    return { ...scope, atomKind: value.atomKind, evidenceId: value.evidenceId, evidenceKind: value.evidenceKind, source, classification: value.classification, temporal, unit: value.unit, value: value.value };
  }
  if (value.atomKind !== "media-metadata"
    || value.evidenceKind !== "media-attachment"
    || typeof value.mediaType !== "string"
    || typeof value.caption !== "string"
    || value.assetStatus !== "metadata-only"
    || value.analysisStatus !== "not-analyzed"
    || value.unit !== null) return null;
  return { ...scope, atomKind: value.atomKind, evidenceId: value.evidenceId, evidenceKind: value.evidenceKind, source, classification: value.classification, temporal, unit: null, mediaType: value.mediaType, caption: value.caption, assetStatus: value.assetStatus, analysisStatus: value.analysisStatus };
}

function decodeEvidencePack(value: unknown): CopilotEvidencePack | null {
  const scope = decodeScope(value);
  if (!scope || !record(value)) return null;
  const atoms = decodedArray(value.atoms, decodeEvidenceAtom);
  return atoms ? { ...scope, atoms } : null;
}

function decodeClause(value: unknown): CopilotAnswerClause | null {
  if (!record(value) || typeof value.clauseId !== "string" || typeof value.text !== "string") return null;
  const evidenceIds = stringArray(value.evidenceIds);
  return evidenceIds ? { clauseId: value.clauseId, text: value.text, evidenceIds } : null;
}

function decodeSection(value: unknown): CopilotAnswerSection | null {
  if (!record(value) || !oneOf(value.sectionId, COPILOT_SECTION_IDS)) return null;
  const clauses = decodedArray(value.clauses, decodeClause);
  return clauses ? { sectionId: value.sectionId, clauses } : null;
}

function decodeChartPoint(value: unknown): CopilotChartPoint | null {
  if (!record(value) || typeof value.pointId !== "string" || typeof value.label !== "string" || typeof value.value !== "number" || !Number.isFinite(value.value)) return null;
  const evidenceIds = stringArray(value.evidenceIds);
  return evidenceIds ? { pointId: value.pointId, label: value.label, value: value.value, evidenceIds } : null;
}

function decodeChart(value: unknown): CopilotChart | null {
  const scope = decodeScope(value);
  if (!scope || !record(value)
    || typeof value.chartId !== "string"
    || typeof value.recipeId !== "string"
    || (value.type !== "bar" && value.type !== "line")
    || typeof value.unit !== "string"
    || !oneOf(value.precision, chartPrecisions)
    || (value.temporalMode !== "calendar" && value.temporalMode !== "relative-order")
    || typeof value.textSummary !== "string") return null;
  const points = decodedArray(value.points, decodeChartPoint);
  return points ? { ...scope, chartId: value.chartId, recipeId: value.recipeId, type: value.type, unit: value.unit, precision: value.precision, temporalMode: value.temporalMode, points, textSummary: value.textSummary } : null;
}

function decodeCitation(value: unknown): CopilotCitation | null {
  const scope = decodeScope(value);
  if (!scope || !record(value)
    || typeof value.citationId !== "string"
    || typeof value.evidenceId !== "string"
    || typeof value.label !== "string"
    || !oneOf(value.classification, assertionClassifications)
    || (value.unit !== null && typeof value.unit !== "string")) return null;
  const source = decodeSource(value.source);
  const temporal = decodeTemporal(value.temporal);
  return source && temporal ? { ...scope, citationId: value.citationId, evidenceId: value.evidenceId, label: value.label, source, classification: value.classification, temporal, unit: value.unit } : null;
}

function decodeDerivedChurn(value: unknown): CopilotDerivedChurnAssessment | null {
  const scope = decodeScope(value);
  if (!scope || !record(value) || value.methodVersion !== "churn-v1" || !oneOf(value.level, churnLevels)) return null;
  const evidenceIds = stringArray(value.evidenceIds);
  const reasons = decodedArray(value.reasons, (reason) => {
    if (!record(reason) || typeof reason.code !== "string") return null;
    const ids = stringArray(reason.evidenceIds);
    return ids ? { code: reason.code, evidenceIds: ids } : null;
  });
  const excludedSourceReasons = decodedArray(value.excludedSourceReasons, (reason) => {
    if (!record(reason) || typeof reason.code !== "string" || reason.basisStatus !== "unsupported-source") return null;
    const ids = stringArray(reason.evidenceIds);
    return ids ? { code: reason.code, basisStatus: "unsupported-source" as const, evidenceIds: ids } : null;
  });
  return evidenceIds && reasons && excludedSourceReasons
    ? { ...scope, methodVersion: value.methodVersion, level: value.level, reasons, excludedSourceReasons, evidenceIds }
    : null;
}

function decodeSourceChurn(value: unknown): CopilotSourceChurnAssessment | null {
  const scope = decodeScope(value);
  if (!scope || !record(value) || typeof value.level !== "string") return null;
  const evidenceIds = stringArray(value.evidenceIds);
  const reasons = decodedArray(value.reasons, (reason) => {
    if (!record(reason) || typeof reason.text !== "string" || (reason.basisStatus !== "supported" && reason.basisStatus !== "unsupported-source")) return null;
    const ids = stringArray(reason.evidenceIds);
    return ids ? {
      text: reason.text,
      basisStatus: reason.basisStatus === "supported" ? "supported" as const : "unsupported-source" as const,
      evidenceIds: ids,
    } : null;
  });
  return evidenceIds && reasons ? { ...scope, level: value.level, reasons, evidenceIds } : null;
}

function decodeChurn(value: unknown): CopilotChurnView | null {
  if (!record(value)) return null;
  const derived = decodeDerivedChurn(value.derived);
  if (!derived) return null;
  if (value.source === null) return { derived, source: null };
  const source = decodeSourceChurn(value.source);
  return source ? { derived, source } : null;
}

function decodeContinuation(value: unknown): SignedCopilotContinuation | null {
  if (!record(value)
    || value.schemaVersion !== "signed-copilot-continuation/v1"
    || value.algorithm !== "hmac-sha256"
    || typeof value.signature !== "string"
    || value.signature.length === 0
    || !record(value.claims)
    || value.claims.schemaVersion !== "copilot-continuation-claims/v1"
    || typeof value.claims.coachId !== "string"
    || typeof value.claims.memberId !== "string"
    || typeof value.claims.contextRevisionId !== "string"
    || typeof value.claims.answerId !== "string"
    || !oneOf(value.claims.intentId, COPILOT_CANONICAL_INTENT_IDS)
    || typeof value.claims.issuedAt !== "string"
    || typeof value.claims.expiresAt !== "string") return null;
  const selectedEvidenceIds = stringArray(value.claims.selectedEvidenceIds);
  const issuedAt = Date.parse(value.claims.issuedAt);
  const expiresAt = Date.parse(value.claims.expiresAt);
  if (!selectedEvidenceIds || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt >= expiresAt) return null;
  return {
    schemaVersion: value.schemaVersion,
    algorithm: value.algorithm,
    signature: value.signature,
    claims: {
      schemaVersion: value.claims.schemaVersion,
      coachId: value.claims.coachId,
      memberId: value.claims.memberId,
      contextRevisionId: value.claims.contextRevisionId,
      answerId: value.claims.answerId,
      intentId: value.claims.intentId,
      selectedEvidenceIds,
      issuedAt: value.claims.issuedAt,
      expiresAt: value.claims.expiresAt,
    },
  };
}

function decodeBriefFreshness(value: unknown): CopilotAnswerPacket["briefFreshness"] | undefined {
  if (value === null) return null;
  if (!record(value) || typeof value.generatedFor !== "string") return undefined;
  if (value.status === "requested-date") return { status: "requested-date", generatedFor: value.generatedFor };
  if (value.status === "latest-recorded") return { status: "latest-recorded", generatedFor: value.generatedFor };
  return undefined;
}

function decodeAnswerPacket(value: unknown): CopilotAnswerPacket | null {
  const scope = decodeScope(value);
  if (!scope || !record(value)
    || value.schemaVersion !== "copilot-answer/v1"
    || typeof value.requestId !== "string"
    || typeof value.answerId !== "string"
    || !oneOf(value.intentId, COPILOT_CANONICAL_INTENT_IDS)
    || typeof value.requestedFor !== "string"
    || typeof value.evidenceAsOf !== "string"
    || typeof value.memberTimezone !== "string") return null;
  const evidence = decodeEvidencePack(value.evidence);
  const sections = decodedArray(value.sections, decodeSection);
  const citations = decodedArray(value.citations, decodeCitation);
  const chart = value.chart === null ? null : decodeChart(value.chart);
  const churn = value.churn === null ? null : decodeChurn(value.churn);
  const continuation = decodeContinuation(value.continuation);
  const briefFreshness = decodeBriefFreshness(value.briefFreshness);
  if (!evidence || !sections || !citations || (value.chart !== null && !chart) || (value.churn !== null && !churn) || !continuation || briefFreshness === undefined) return null;
  return { ...scope, schemaVersion: value.schemaVersion, requestId: value.requestId, answerId: value.answerId, intentId: value.intentId, requestedFor: value.requestedFor, evidenceAsOf: value.evidenceAsOf, memberTimezone: value.memberTimezone, briefFreshness, evidence, sections, chart, citations, churn, continuation };
}

function unavailable(requestId: string): DashboardCopilotOutcome {
  return {
    status: "unavailable",
    requestId,
    code: "graph-unavailable",
    retryable: true,
    message: "Copilot is temporarily unavailable.",
    controls: retryControls,
  };
}

function cancelled(requestId: string): DashboardCopilotOutcome {
  return { status: "cancelled", requestId, controls: cancelledControls };
}

function responseRequestMatches(status: string, responseRequestId: unknown, requestId: string): boolean {
  return responseRequestId === requestId
    || (status === "denied" && responseRequestId === "request:unavailable")
    || (status === "invalid" && responseRequestId === "request:invalid");
}

function decodeQuickPromptIds(value: unknown): CopilotQuickPromptId[] | null {
  if (!Array.isArray(value)) return null;
  const ids: CopilotQuickPromptId[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isCopilotQuickPromptId(item)) return null;
    ids.push(item);
  }
  return ids;
}

function decodeOutcome(value: unknown, requestId: string): DashboardCopilotOutcome | null {
  if (!record(value) || typeof value.status !== "string" || !responseRequestMatches(value.status, value.requestId, requestId)) return null;
  const decodedControls = controls(value.controls);
  if (!decodedControls) return null;
  switch (value.status) {
    case "ready": {
      const decoded = decodeAnswerPacket(value.answer);
      if (!decoded || decoded.requestId !== requestId) return null;
      try {
        return { status: value.status, requestId, answer: createCopilotAnswerPacket(decoded), controls: decodedControls };
      } catch {
        return null;
      }
    }
    case "empty":
      return typeof value.message === "string" ? { status: value.status, requestId, message: value.message, controls: decodedControls } : null;
    case "insufficient-history":
      return Number.isInteger(value.requiredPoints) && Number.isInteger(value.availablePoints) && typeof value.message === "string"
        ? { status: value.status, requestId, requiredPoints: value.requiredPoints as number, availablePoints: value.availablePoints as number, message: value.message, controls: decodedControls }
        : null;
    case "stale": {
      if ((value.requestedRevisionId !== undefined && typeof value.requestedRevisionId !== "string")
        || (value.activeRevisionId !== undefined && value.activeRevisionId !== null && typeof value.activeRevisionId !== "string")
        || typeof value.message !== "string") return null;
      return {
        status: value.status,
        requestId,
        requestedRevisionId: value.requestedRevisionId ?? "revision:unavailable",
        activeRevisionId: value.activeRevisionId ?? null,
        message: value.message,
        controls: decodedControls,
      };
    }
    case "continuation-expired":
    case "denied":
      return typeof value.message === "string" ? { status: value.status, requestId, message: value.message, controls: decodedControls } : null;
    case "invalid":
      return typeof value.code === "string" && typeof value.message === "string" ? { status: value.status, requestId, code: value.code, message: value.message, controls: decodedControls } : null;
    case "unavailable":
      return (value.code === "graph-unavailable" || value.code === "graph-timeout") && value.retryable === true && typeof value.message === "string"
        ? { status: value.status, requestId, code: value.code, retryable: true, message: value.message, controls: decodedControls }
        : null;
    case "model-error":
      return (value.code === "provider-unavailable" || value.code === "provider-timeout" || value.code === "malformed-selection" || value.code === "grounding-rejected")
        && value.retryable === true
        && typeof value.message === "string"
        ? { status: value.status, requestId, code: value.code, retryable: true, message: value.message, controls: decodedControls }
        : null;
    case "unsupported": {
      const supportedPromptIds = decodeQuickPromptIds(value.supportedPromptIds);
      return supportedPromptIds && typeof value.message === "string"
        ? { status: value.status, requestId, supportedPromptIds, message: value.message, controls: decodedControls }
        : null;
    }
    case "cancelled":
      return { status: value.status, requestId, controls: decodedControls };
    default:
      return null;
  }
}

export function createFetchDashboardCopilotClient(fetcher: typeof fetch = fetch): DashboardCopilotClient {
  return {
    async request(input: DashboardCopilotRequest): Promise<DashboardCopilotOutcome> {
      try {
        const response = await fetcher("/api/copilot", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            schemaVersion: "copilot-request/v1",
            requestId: input.requestId,
            memberId: input.memberId,
            requestedFor: input.requestedFor,
            input: input.input,
            ...(input.continuation ? { continuation: input.continuation } : {}),
          }),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const body: unknown = await response.json();
        return decodeOutcome(body, input.requestId) ?? unavailable(input.requestId);
      } catch {
        return input.signal?.aborted ? cancelled(input.requestId) : unavailable(input.requestId);
      }
    },
  };
}
