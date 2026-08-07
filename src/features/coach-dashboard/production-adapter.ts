import {
  COPILOT_CANONICAL_INTENT_IDS,
  COPILOT_MORNING_TASK_ACTION_IDS,
  COPILOT_MORNING_TASK_TYPE_IDS,
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
  type CopilotMorningTask,
  type CopilotQuickPromptId,
  type CopilotScopeEnvelope,
  type CopilotSourceChurnAssessment,
  type SignedCopilotContinuation,
} from "../../domain/contracts/copilot";
import {
  type FullGraphDomain,
  type FullGraphDetailField,
  type FullGraphNode,
  type FullGraphProjection,
  type FullGraphProvenance,
  type FullGraphReadResult,
  type FullGraphRelationship,
} from "../../domain/contracts/full-graph-view";
import {
  MEMBER_CONTEXT_NODE_KINDS,
  MEMBER_CONTEXT_RELATIONSHIP_KINDS,
  MEMBER_CONTEXT_REVISION_SCOPED_NODE_KINDS,
  type AssertionClassification,
  type AssertionSource,
  type AssertionTemporal,
} from "../../domain/contracts/member-context";
import { MOVEMENT_EDGE_KINDS, MOVEMENT_NODE_KINDS } from "../../domain/contracts/movement-graph";
import { isCopilotQuickPromptId } from "../../domain/policies/copilot-retrieval-plan";
import type {
  DashboardCopilotClient,
  DashboardCopilotControls,
  DashboardCopilotOutcome,
  DashboardCopilotRequest,
  DashboardSession,
  DashboardSessionClient,
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

const fullGraphCategories = ["domain", "identity", "lineage", "publication"] as const;

function decodeFullGraphDetail(value: unknown): FullGraphNode["detail"] | null {
  if (!Array.isArray(value)) return null;
  const detail: FullGraphDetailField[] = [];
  for (const field of value) {
    if (!record(field) || typeof field.key !== "string" || field.key.length === 0 || !scalar(field.value)) return null;
    detail.push({ key: field.key, value: field.value });
  }
  return detail;
}

function decodeFullGraphProvenance(value: unknown): FullGraphProvenance | null {
  if (!record(value) || (value.directAssertion !== "present" && value.directAssertion !== "none")) return null;
  const lineageIds = stringArray(value.lineageIds);
  if (!lineageIds) return null;
  if (value.directAssertion === "present" && typeof value.assertionId !== "string") return null;
  if (value.directAssertion === "none" && Object.hasOwn(value, "assertionId")) return null;
  const assertionId = value.directAssertion === "present" ? value.assertionId as string : undefined;
  let source: FullGraphProvenance["source"];
  if (value.source !== undefined) {
    const sourceRecord = value.source;
    if (!record(sourceRecord)) return null;
    const sourceKeys = ["sourceId", "sourceRevision", "sourceRecordId", "locator", "artifactDigest"] as const;
    if (sourceKeys.some((key) => Object.hasOwn(sourceRecord, key) && typeof sourceRecord[key] !== "string")) return null;
    source = {
      ...(typeof sourceRecord.sourceId === "string" ? { sourceId: sourceRecord.sourceId } : {}),
      ...(typeof sourceRecord.sourceRevision === "string" ? { sourceRevision: sourceRecord.sourceRevision } : {}),
      ...(typeof sourceRecord.sourceRecordId === "string" ? { sourceRecordId: sourceRecord.sourceRecordId } : {}),
      ...(typeof sourceRecord.locator === "string" ? { locator: sourceRecord.locator } : {}),
      ...(typeof sourceRecord.artifactDigest === "string" ? { artifactDigest: sourceRecord.artifactDigest } : {}),
    };
  }
  let classification: FullGraphProvenance["classification"];
  if (value.classification !== undefined) {
    if (!oneOf(value.classification, assertionClassifications)) return null;
    classification = value.classification;
  }
  let temporal: FullGraphProvenance["temporal"];
  if (value.temporal !== undefined) {
    const decodedTemporal = decodeTemporal(value.temporal);
    if (!decodedTemporal) return null;
    temporal = decodedTemporal;
  }
  return {
    directAssertion: value.directAssertion,
    ...(assertionId === undefined ? {} : { assertionId }),
    ...(source === undefined ? {} : { source }),
    ...(classification === undefined ? {} : { classification }),
    ...(temporal === undefined ? {} : { temporal }),
    lineageIds,
  };
}

function decodeFullGraphNode(value: unknown, domain: FullGraphDomain, revisionId: string): FullGraphNode | null {
  if (!record(value)
    || typeof value.id !== "string"
    || typeof value.kind !== "string"
    || typeof value.label !== "string"
    || !oneOf(value.category, fullGraphCategories)
    || value.revisionId !== revisionId) return null;
  const validKind = domain === "movement-clinical"
    ? oneOf(value.kind, MOVEMENT_NODE_KINDS)
    : oneOf(value.kind, MEMBER_CONTEXT_NODE_KINDS);
  if (!validKind) return null;
  const detail = decodeFullGraphDetail(value.detail);
  const provenance = decodeFullGraphProvenance(value.provenance);
  if (!detail || !provenance) return null;
  return {
    id: value.id,
    kind: value.kind as FullGraphNode["kind"],
    label: value.label,
    category: value.category as FullGraphNode["category"],
    revisionId,
    detail,
    provenance,
  };
}

function decodeFullGraphRelationship(value: unknown, domain: FullGraphDomain, revisionId: string): FullGraphRelationship | null {
  if (!record(value)
    || typeof value.id !== "string"
    || typeof value.kind !== "string"
    || typeof value.fromId !== "string"
    || typeof value.toId !== "string"
    || value.revisionId !== revisionId) return null;
  const validKind = domain === "movement-clinical"
    ? oneOf(value.kind, MOVEMENT_EDGE_KINDS)
    : oneOf(value.kind, MEMBER_CONTEXT_RELATIONSHIP_KINDS);
  if (!validKind) return null;
  const detail = decodeFullGraphDetail(value.detail);
  const provenance = decodeFullGraphProvenance(value.provenance);
  if (!detail || !provenance) return null;
  return {
    id: value.id,
    kind: value.kind as FullGraphRelationship["kind"],
    fromId: value.fromId,
    toId: value.toId,
    revisionId,
    detail,
    provenance,
  };
}

function decodeFullGraphProjection(value: unknown, expectedDomain: FullGraphDomain, expectedMemberId?: string): FullGraphProjection | null {
  const counts = record(value) && record(value.counts)
    ? { nodes: value.counts.nodes, relationships: value.counts.relationships }
    : null;
  if (!record(value)
    || value.domain !== expectedDomain
    || typeof value.revisionId !== "string"
    || (expectedDomain === "member-context" && value.memberId !== expectedMemberId)
    || (expectedDomain === "movement-clinical" && value.memberId !== undefined)
    || !oneOf(value.authority, ["canonical", "fixture"] as const)
    || !counts
    || typeof counts.nodes !== "number"
    || typeof counts.relationships !== "number"
    || !Number.isSafeInteger(counts.nodes)
    || !Number.isSafeInteger(counts.relationships)
    || counts.nodes < 0
    || counts.relationships < 0
    || !Array.isArray(value.nodes)
    || !Array.isArray(value.relationships)) return null;
  const nodeCount = counts.nodes as number;
  const relationshipCount = counts.relationships as number;
  const nodes = decodedArray(value.nodes, (node) => decodeFullGraphNode(node, expectedDomain, value.revisionId as string));
  const relationships = decodedArray(value.relationships, (relationship) => decodeFullGraphRelationship(relationship, expectedDomain, value.revisionId as string));
  if (!nodes || !relationships || nodes.length !== nodeCount || relationships.length !== relationshipCount) return null;
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) return null;
    nodeIds.add(node.id);
  }
  const relationshipIds = new Set<string>();
  for (const relationship of relationships) {
    if (relationshipIds.has(relationship.id) || !nodeIds.has(relationship.fromId) || !nodeIds.has(relationship.toId)) return null;
    relationshipIds.add(relationship.id);
  }
  return {
    domain: expectedDomain,
    revisionId: value.revisionId,
    ...(expectedDomain === "member-context" ? { memberId: expectedMemberId } : {}),
    ...(typeof value.sourceArtifactDigest === "string" ? { sourceArtifactDigest: value.sourceArtifactDigest } : {}),
    authority: value.authority as FullGraphProjection["authority"],
    counts: { nodes: nodeCount, relationships: relationshipCount },
    nodes,
    relationships,
  };
}

function decodeFullGraphResult(value: unknown, input: { readonly domain: FullGraphDomain; readonly memberId?: string }): FullGraphReadResult | null {
  if (!record(value) || typeof value.status !== "string") return null;
  if (value.status === "ready") {
    const data = decodeFullGraphProjection(value.data, input.domain, input.memberId);
    return data ? { status: "ready", data } : null;
  }
  if (value.domain !== input.domain || typeof value.message !== "string") return null;
  if (value.status === "stale") {
    if (typeof value.requestedRevisionId !== "string"
      || (value.activeRevisionId !== null && typeof value.activeRevisionId !== "string")) return null;
    return { status: "stale", domain: input.domain, requestedRevisionId: value.requestedRevisionId, activeRevisionId: value.activeRevisionId };
  }
  if (value.status === "empty" || value.status === "denied" || value.status === "invalid" || value.status === "unavailable") {
    return { status: value.status, domain: input.domain, message: value.message };
  }
  return null;
}

function unavailableFullGraph(domain: FullGraphDomain): FullGraphReadResult {
  return { status: "unavailable", domain, message: domain === "member-context" ? "Member context is unavailable." : "Movement graph is unavailable." };
}

export function createFetchDashboardFullGraphClient(fetcher: typeof fetch = fetch): import("./dashboard-contract").DashboardFullGraphClient {
  return {
    async read(input) {
      if ((input.domain === "member-context" && (!input.memberId || input.memberId.length > 200))
        || (input.domain === "movement-clinical" && input.memberId !== undefined)
        || (input.revisionId !== undefined && (input.revisionId.length === 0 || input.revisionId.length > 200))) {
        return { status: "invalid", domain: input.domain, message: "Invalid full graph request." };
      }
      const params = new URLSearchParams();
      if (input.domain === "member-context") params.set("memberId", input.memberId!);
      if (input.revisionId) params.set(input.domain === "member-context" ? "contextRevisionId" : "revisionId", input.revisionId);
      const path = input.domain === "member-context" ? "/api/member-context/graph" : "/api/movement-graph";
      try {
        const response = await fetcher(`${path}?${params.toString()}`, {
          headers: { accept: "application/json" },
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const decoded = decodeFullGraphResult(await response.json(), input);
        return decoded ?? unavailableFullGraph(input.domain);
      } catch {
        return unavailableFullGraph(input.domain);
      }
    },
  };
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

function decodeMorningTask(value: unknown): CopilotMorningTask | null {
  if (!record(value)
    || typeof value.taskId !== "string"
    || !oneOf(value.taskType, COPILOT_MORNING_TASK_TYPE_IDS)
    || !oneOf(value.actionId, Object.values(COPILOT_MORNING_TASK_ACTION_IDS))
    || typeof value.text !== "string"
    || !Number.isInteger(value.sourceOrder)
    || (value.sourceOrder as number) < 0) return null;
  const evidenceIds = stringArray(value.evidenceIds);
  if (!evidenceIds || COPILOT_MORNING_TASK_ACTION_IDS[value.taskType] !== value.actionId) return null;
  return {
    taskId: value.taskId,
    taskType: value.taskType,
    actionId: value.actionId,
    text: value.text,
    evidenceIds,
    sourceOrder: value.sourceOrder as number,
  };
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
  const tasks = decodedArray(value.tasks, decodeMorningTask);
  const citations = decodedArray(value.citations, decodeCitation);
  const chart = value.chart === null ? null : decodeChart(value.chart);
  const churn = value.churn === null ? null : decodeChurn(value.churn);
  const continuation = decodeContinuation(value.continuation);
  const briefFreshness = decodeBriefFreshness(value.briefFreshness);
  if (!evidence || !sections || !tasks || !citations || (value.chart !== null && !chart) || (value.churn !== null && !churn) || !continuation || briefFreshness === undefined) return null;
  if (continuation.claims.memberId !== scope.memberId
    || continuation.claims.contextRevisionId !== scope.contextRevisionId
    || continuation.claims.answerId !== value.answerId
    || continuation.claims.intentId !== value.intentId
    || continuation.claims.selectedEvidenceIds.some((evidenceId) => !evidence.atoms.some((atom) => atom.evidenceId === evidenceId))) return null;
  return { ...scope, schemaVersion: value.schemaVersion, requestId: value.requestId, answerId: value.answerId, intentId: value.intentId, requestedFor: value.requestedFor, evidenceAsOf: value.evidenceAsOf, memberTimezone: value.memberTimezone, briefFreshness, evidence, sections, tasks, chart, citations, churn, continuation };
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

function decodeSession(value: unknown): DashboardSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.status !== "authenticated" || typeof body.coachId !== "string" || !Array.isArray(body.memberIds)
    || !body.memberIds.every((memberId) => typeof memberId === "string") || typeof body.expiresAt !== "string") return null;
  return { coachId: body.coachId, memberIds: [...body.memberIds] as string[], expiresAt: body.expiresAt };
}

/** Explicit mock-session client. Cookies remain HttpOnly and are never projected into JS. */
export function createFetchDashboardSessionClient(fetcher: typeof fetch = fetch): DashboardSessionClient {
  return {
    async current(input) {
      try {
        const response = await fetcher("/api/session", { headers: { accept: "application/json" }, credentials: "same-origin", ...(input?.signal ? { signal: input.signal } : {}) });
        return decodeSession(await response.json());
      } catch { return null; }
    },
    async signIn(input) {
      const response = await fetcher("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        body: "{}",
        ...(input?.signal ? { signal: input.signal } : {}),
      });
      const session = decodeSession(await response.json());
      if (!response.ok || !session) throw new Error("Mock coach sign-in unavailable.");
      return session;
    },
    async signOut(input) {
      const response = await fetcher("/api/session", {
        method: "DELETE",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        ...(input?.signal ? { signal: input.signal } : {}),
      });
      if (!response.ok) throw new Error("Mock coach sign-out unavailable.");
    },
  };
}
