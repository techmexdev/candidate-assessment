import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { inspectAuthorizedMemberContextScope } from "../../application/use-cases/retrieve-member-context";
import type {
  AuthoritativeEvidenceAnchorProjection,
  AuthorizedMemberContextScope,
  BoundedMemberContextQuery,
  CitationLookupQuery,
  CitationProjection,
  ChurnAssessmentEvidenceProjection,
  ChurnReasonEvidenceProjection,
  CoachBriefProjection,
  CoachBriefEvidenceProjection,
  CoachBriefQuery,
  CoachTaskEvidenceProjection,
  ConversationProjection,
  ConversationQuery,
  EvidenceQuery,
  LabPanelEvidenceProjection,
  LongitudinalPointProjection,
  LongitudinalSeriesQuery,
  MemberContextEvidenceDomain,
  MemberContextQueryResult,
  MemberContextReadHandle,
  MemberContextReadOpenResult,
  MemberContextTimeWindow,
  MemberEvidenceProjection,
  MemberProfileEvidenceProjection,
  MediaAttachmentEvidenceProjection,
  MemberSummaryProjection,
  MessageProjection,
  ObservationEvidenceProjection,
  GoalEvidenceProjection,
  PreferenceEvidenceProjection,
  RelatedEvidenceQuery,
  RelativeOrderSequenceQuery,
  SummaryQuery,
  WorkoutConstraintsProjection,
  WorkoutConstraintsQuery,
  WorkoutEquipmentConstraintProjection,
  WorkoutInjuryConstraintProjection,
  WorkoutPreferenceConstraintProjection,
  WorkoutSessionEvidenceProjection,
} from "../../domain/contracts/member-context-queries";
import {
  FullGraphProjectionError,
  projectMemberContextGraphSnapshot,
  type FullGraphReadResult,
  type MemberContextFullReadProvider,
} from "../../domain/contracts/full-graph-view";
import { deriveEvidenceAsOf } from "../../domain/policies/copilot-projections";
import {
  MEMBER_CONTEXT_REVISION_SCOPED_NODE_KINDS,
  type MemberContextAuthority,
  type MemberContextGraphSnapshot,
  type MemberContextRevisionScopedNode,
} from "../../domain/contracts/member-context";
import { MEMBER_CONTEXT_NEO4J_LIMITS } from "../neo4j/member-context-schema";
import type { InMemoryMemberContextPublisher } from "../publication/in-memory-member-context-publisher";

export const MEMBER_CONTEXT_QUERY_DEFAULTS = Object.freeze({ limit: 25, timeoutMs: 1_000 });
export const MEMBER_CONTEXT_QUERY_MAXIMA = Object.freeze({ limit: 100, timeoutMs: 5_000, evidenceIds: 100 });
const memberContextEvidenceDomains = new Set<MemberContextEvidenceDomain>([
  "profile", "goals", "preferences", "equipment", "injuries", "workouts", "adherence",
  "biomarkers", "labs", "conversations", "coach-brief", "churn",
]);
const memberContextEvidenceKinds = new Set<MemberContextRevisionScopedNode["kind"]>(
  MEMBER_CONTEXT_REVISION_SCOPED_NODE_KINDS,
);

type ReadProviderOptions = {
  readonly authority?: MemberContextAuthority;
};

type CursorPayload = {
  readonly version: 1;
  readonly operation: string;
  readonly memberId: string;
  readonly contextRevisionId: string;
  readonly query: string;
  readonly offset: number;
};

type Page<T> = { readonly status: "ready"; readonly data: readonly T[]; readonly nextCursor?: string };

const relatedRelationshipKinds = new Set([
  "MENTIONS_EXERCISE",
  "CONTAINS_MEASUREMENT",
  "CONTAINS_MESSAGE",
  "HAS_ATTACHMENT",
  "HAS_TASK",
  "HAS_ASSESSMENT",
  "HAS_REASON",
  "SUPPORTED_BY",
  "WAS_DERIVED_FROM",
]);

function temporalSortKey(node: MemberContextRevisionScopedNode): string {
  switch (node.temporal.precision) {
    case "exact-timestamp": return `0:${new Date(node.temporal.effectiveAt).toISOString()}`;
    case "date": return `1:${node.temporal.effectiveOn}`;
    case "relative-order": return `2:${String(node.temporal.sourceOrder).padStart(10, "0")}`;
    case "unknown": return "3:";
  }
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEvidence(left: MemberContextRevisionScopedNode, right: MemberContextRevisionScopedNode): number {
  return compareCodePoints(temporalSortKey(left), temporalSortKey(right))
    || (("sourceOrder" in left ? left.sourceOrder : 0) - ("sourceOrder" in right ? right.sourceOrder : 0))
    || compareCodePoints(left.assertionId, right.assertionId);
}

function evidenceProjectionBase(node: MemberContextRevisionScopedNode) {
  return {
    evidenceId: node.assertionId,
    semanticId: node.semanticId,
    assertionId: node.assertionId,
    kind: node.kind,
    source: node.source,
    classification: node.classification,
    temporal: node.temporal,
  };
}

function projectEvidence(
  node: Extract<MemberContextRevisionScopedNode, { kind: "observation" }>,
): ObservationEvidenceProjection;
function projectEvidence(
  node: Extract<MemberContextRevisionScopedNode, { kind: "lab-panel" }>,
): LabPanelEvidenceProjection;
function projectEvidence(
  node: Extract<MemberContextRevisionScopedNode, { kind: "media-attachment" }>,
): MediaAttachmentEvidenceProjection;
function projectEvidence(
  node: Extract<MemberContextRevisionScopedNode, { kind: "message" }>,
): Extract<MemberEvidenceProjection, { kind: "message" }>;
function projectEvidence(
  node: Extract<MemberContextRevisionScopedNode, { kind: "member-profile" }>,
): MemberProfileEvidenceProjection;
function projectEvidence(
  node: Extract<MemberContextRevisionScopedNode, { kind: "goal" }>,
): GoalEvidenceProjection;
function projectEvidence(
  node: Extract<MemberContextRevisionScopedNode, { kind: "preference" }>,
): PreferenceEvidenceProjection;
function projectEvidence(
  node: Extract<MemberContextRevisionScopedNode, { kind: "workout-session" }>,
): WorkoutSessionEvidenceProjection;
function projectEvidence(
  node: Extract<MemberContextRevisionScopedNode, { kind: "coach-brief" }>,
): CoachBriefEvidenceProjection;
function projectEvidence(
  node: Extract<MemberContextRevisionScopedNode, { kind: "coach-task" }>,
): CoachTaskEvidenceProjection;
function projectEvidence(
  node: Extract<MemberContextRevisionScopedNode, { kind: "churn-assessment" }>,
): ChurnAssessmentEvidenceProjection;
function projectEvidence(
  node: Extract<MemberContextRevisionScopedNode, { kind: "churn-reason" }>,
): ChurnReasonEvidenceProjection;
function projectEvidence(node: MemberContextRevisionScopedNode): MemberEvidenceProjection;
function projectEvidence(node: MemberContextRevisionScopedNode): MemberEvidenceProjection {
  const base = evidenceProjectionBase(node);
  if (node.kind === "observation") {
    return { ...base, kind: node.kind, metric: node.metric, value: node.value, unit: node.unit, sourceOrder: node.sourceOrder };
  }
  if (node.kind === "lab-panel") {
    return { ...base, kind: node.kind, panelType: node.panelType, label: node.label, sourceOrder: node.sourceOrder };
  }
  if (node.kind === "media-attachment") {
    return {
      ...base,
      kind: node.kind,
      mediaType: node.mediaType,
      caption: node.caption,
      sourceOrder: node.sourceOrder,
      assetStatus: node.assetStatus,
      analysisStatus: node.analysisStatus,
    };
  }
  if (node.kind === "member-profile") {
    return { ...base, kind: node.kind, timezone: node.timezone };
  }
  if (node.kind === "goal") {
    return {
      ...base,
      kind: node.kind,
      text: node.text,
      priority: node.priority,
      targetDate: node.targetDate,
      domainReference: node.domainReference,
    };
  }
  if (node.kind === "preference") {
    return {
      ...base,
      kind: node.kind,
      preferredSessionMinutes: node.preferredSessionMinutes,
      trainingDaysPerWeek: node.trainingDaysPerWeek,
      preferredDays: node.preferredDays,
      dislikes: node.dislikes,
      notes: node.notes,
      domainReferences: node.domainReferences,
    };
  }
  if (node.kind === "workout-session") {
    return {
      ...base,
      kind: node.kind,
      title: node.title,
      planned: node.planned,
      completed: node.completed,
      durationMinutes: node.durationMinutes,
      rpe: node.rpe,
    };
  }
  if (node.kind === "coach-brief") {
    return { ...base, kind: node.kind, generatedFor: node.generatedFor };
  }
  if (node.kind === "coach-task") {
    return {
      ...base,
      kind: node.kind,
      taskType: node.taskType,
      text: node.text,
      sourceOrder: node.sourceOrder,
    };
  }
  if (node.kind === "churn-assessment") {
    return {
      ...base,
      kind: node.kind,
      level: node.level,
      ...(node.methodRevision ? { methodRevision: node.methodRevision } : {}),
    };
  }
  if (node.kind === "churn-reason") {
    return {
      ...base,
      kind: node.kind,
      text: node.text,
      sourceOrder: node.sourceOrder,
      basisStatus: node.basisStatus,
    };
  }
  return base as MemberEvidenceProjection;
}

function isValidWindow(window: MemberContextTimeWindow): boolean {
  if (!window || typeof window.fromInclusive !== "string" || typeof window.toExclusive !== "string") return false;
  const from = Date.parse(window.fromInclusive);
  const to = Date.parse(window.toExclusive);
  return Number.isFinite(from) && Number.isFinite(to) && from < to;
}

function isInWindow(node: MemberContextRevisionScopedNode, window: MemberContextTimeWindow): boolean {
  const value = node.temporal.precision === "exact-timestamp"
    ? Date.parse(node.temporal.effectiveAt)
    : node.temporal.precision === "date"
      ? Date.parse(`${node.temporal.effectiveOn}T00:00:00.000Z`)
      : Number.NaN;
  return Number.isFinite(value) && value >= Date.parse(window.fromInclusive) && value < Date.parse(window.toExclusive);
}

function isEvidenceId(value: unknown): value is string {
  return typeof value === "string" && /^assertion:[a-f0-9]{16}$/.test(value);
}

export class InMemoryMemberContextReadProvider implements MemberContextFullReadProvider {
  private available = true;
  private readonly authority: MemberContextAuthority;
  private readonly cursorSecret = randomBytes(32);

  constructor(
    private readonly publisher: InMemoryMemberContextPublisher,
    options: ReadProviderOptions = {},
  ) {
    this.authority = options.authority ?? "fixture";
  }

  /** Infrastructure/test fault-injection hook; absent from the application port. */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  async openActive(scope: AuthorizedMemberContextScope): Promise<MemberContextReadOpenResult> {
    const claims = inspectAuthorizedMemberContextScope(scope);
    if (!claims) return { status: "denied", message: "Member context is unavailable." };
    if (!this.available) return { status: "unavailable", message: "Member context is unavailable." };
    const revisionId = this.publisher.getActiveRevisionId(claims.memberId);
    if (!revisionId) return { status: "empty", memberId: claims.memberId, message: "Member context is unavailable." };
    return this.openClaimsRevision(claims, revisionId);
  }

  async openRevision(
    scope: AuthorizedMemberContextScope,
    contextRevisionId: string,
  ): Promise<MemberContextReadOpenResult> {
    const claims = inspectAuthorizedMemberContextScope(scope);
    if (!claims) return { status: "denied", message: "Member context is unavailable." };
    if (!this.available) return { status: "unavailable", message: "Member context is unavailable." };
    return this.openClaimsRevision(claims, contextRevisionId, {
      activeRevisionId: this.publisher.getActiveRevisionId(claims.memberId),
    });
  }

  async readFullActive(scope: AuthorizedMemberContextScope): Promise<FullGraphReadResult> {
    const claims = inspectAuthorizedMemberContextScope(scope);
    if (!claims) return { status: "denied", domain: "member-context", message: "Member context is unavailable." };
    if (!this.available) return { status: "unavailable", domain: "member-context", message: "Member context is unavailable." };
    const revisionId = this.publisher.getActiveRevisionId(claims.memberId);
    if (!revisionId) return { status: "empty", domain: "member-context", message: "Member context is unavailable." };
    return this.readFullClaimsRevision(claims, revisionId);
  }

  async readFullRevision(
    scope: AuthorizedMemberContextScope,
    contextRevisionId: string,
  ): Promise<FullGraphReadResult> {
    const claims = inspectAuthorizedMemberContextScope(scope);
    if (!claims) return { status: "denied", domain: "member-context", message: "Member context is unavailable." };
    if (!this.available) return { status: "unavailable", domain: "member-context", message: "Member context is unavailable." };
    return this.readFullClaimsRevision(claims, contextRevisionId, true);
  }

  private async readFullClaimsRevision(
    claims: Readonly<{ coachId: string; memberId: string }>,
    contextRevisionId: string,
    explicitRevision = false,
  ): Promise<FullGraphReadResult> {
    const activeRevisionId = this.publisher.getActiveRevisionId(claims.memberId);
    const inspection = await this.publisher.inspect(claims.memberId, contextRevisionId);
    if (inspection.status !== "ok" || !["active", "sealed"].includes(inspection.data.state)) {
      return explicitRevision
        ? { status: "stale", domain: "member-context", requestedRevisionId: contextRevisionId, activeRevisionId }
        : { status: "empty", domain: "member-context", message: "Member context is unavailable." };
    }
    const snapshot = this.publisher.getRevision(claims.memberId, contextRevisionId);
    if (!snapshot || snapshot.memberId !== claims.memberId) {
      return explicitRevision
        ? { status: "stale", domain: "member-context", requestedRevisionId: contextRevisionId, activeRevisionId }
        : { status: "empty", domain: "member-context", message: "Member context is unavailable." };
    }
    if (snapshot.nodes.length > MEMBER_CONTEXT_NEO4J_LIMITS.maxNodesPerRevision
      || snapshot.relationships.length > MEMBER_CONTEXT_NEO4J_LIMITS.maxRelationshipsPerRevision) {
      return { status: "invalid", domain: "member-context", message: "Member context exceeds bounded limits." };
    }
    try {
      return { status: "ready", data: projectMemberContextGraphSnapshot(snapshot, this.authority) };
    } catch (error) {
      const message = error instanceof FullGraphProjectionError ? "Member context failed integrity validation." : "Member context projection failed.";
      return { status: "invalid", domain: "member-context", message };
    }
  }

  private async openClaimsRevision(
    claims: Readonly<{ coachId: string; memberId: string }>,
    contextRevisionId: string,
    explicitRevision?: Readonly<{ activeRevisionId: string | null }>,
  ): Promise<MemberContextReadOpenResult> {
    const inspection = await this.publisher.inspect(claims.memberId, contextRevisionId);
    if (inspection.status !== "ok" || !["active", "sealed"].includes(inspection.data.state)) {
      if (explicitRevision) {
        return {
          status: "stale",
          requestedRevisionId: contextRevisionId,
          activeRevisionId: explicitRevision.activeRevisionId,
        };
      }
      return { status: "empty", memberId: claims.memberId, message: "Member context is unavailable." };
    }
    const snapshot = this.publisher.getRevision(claims.memberId, contextRevisionId);
    if (!snapshot || snapshot.memberId !== claims.memberId) {
      if (explicitRevision) {
        return {
          status: "stale",
          requestedRevisionId: contextRevisionId,
          activeRevisionId: explicitRevision.activeRevisionId,
        };
      }
      return { status: "empty", memberId: claims.memberId, message: "Member context is unavailable." };
    }
    return {
      status: "ready",
      handle: new InMemoryMemberContextReadHandle(
        snapshot,
        claims.coachId,
        this.authority,
        this.cursorSecret,
      ),
    };
  }
}

class InMemoryMemberContextReadHandle implements MemberContextReadHandle {
  readonly memberId: string;
  readonly coachId: string;
  readonly contextRevisionId: string;
  readonly authority: MemberContextAuthority;
  private readonly revisionNodes: readonly MemberContextRevisionScopedNode[];
  private readonly nodesByEvidenceId: ReadonlyMap<string, MemberContextRevisionScopedNode>;
  private readonly nodesBySemanticId: ReadonlyMap<string, MemberContextRevisionScopedNode>;
  private readonly labMeasurementIds: ReadonlySet<string>;
  private readonly authoritativeEvidenceAnchor: AuthoritativeEvidenceAnchorProjection | null;
  private readonly domainPredicates: Readonly<Record<MemberContextEvidenceDomain, (node: MemberContextRevisionScopedNode) => boolean>>;

  constructor(
    private readonly snapshot: MemberContextGraphSnapshot,
    coachId: string,
    authority: MemberContextAuthority,
    private readonly cursorSecret: Buffer,
  ) {
    this.memberId = snapshot.memberId;
    this.coachId = coachId;
    this.contextRevisionId = snapshot.contextRevisionId;
    this.authority = authority;
    this.revisionNodes = snapshot.nodes.filter((node): node is MemberContextRevisionScopedNode => "assertionId" in node);
    this.nodesByEvidenceId = new Map(this.revisionNodes.map((node) => [node.assertionId, node]));
    this.nodesBySemanticId = new Map(this.revisionNodes.map((node) => [node.semanticId, node]));
    const profile = this.revisionNodes.find((node) => node.kind === "member-profile");
    const anchorCandidates = profile ? this.revisionNodes
      .filter((node): node is MemberContextRevisionScopedNode & {
        readonly temporal: AuthoritativeEvidenceAnchorProjection["temporal"];
      } => node.temporal.precision === "exact-timestamp" || node.temporal.precision === "date")
      .map((node) => ({
        evidenceId: node.assertionId,
        temporal: node.temporal,
        instant: Date.parse(deriveEvidenceAsOf([node], profile.timezone)),
      }))
      .filter((candidate) => Number.isFinite(candidate.instant))
      .sort((left, right) => left.instant - right.instant || left.evidenceId.localeCompare(right.evidenceId))
      : [];
    const latestAnchor = anchorCandidates.at(-1);
    this.authoritativeEvidenceAnchor = latestAnchor
      ? { evidenceId: latestAnchor.evidenceId, temporal: latestAnchor.temporal }
      : null;
    this.labMeasurementIds = new Set(snapshot.relationships
      .filter((edge) => edge.kind === "CONTAINS_MEASUREMENT")
      .map((edge) => edge.toSemanticId));
    const isObservationMetric = (node: MemberContextRevisionScopedNode, metrics: readonly string[]) => (
      node.kind === "observation" && metrics.includes(node.metric)
    );
    this.domainPredicates = {
      profile: (node) => node.kind === "member-profile",
      goals: (node) => node.kind === "goal",
      preferences: (node) => node.kind === "preference",
      equipment: (node) => node.kind === "equipment-availability",
      injuries: (node) => node.kind === "injury-episode",
      workouts: (node) => node.kind === "workout-session" || node.kind === "exercise-mention",
      adherence: (node) => isObservationMetric(node, ["weekly-workout-completion", "adherence-trend"]),
      biomarkers: (node) => node.kind === "observation"
        && !this.labMeasurementIds.has(node.semanticId)
        && !isObservationMetric(node, ["weekly-workout-completion", "adherence-trend"]),
      labs: (node) => node.kind === "lab-panel"
        || (node.kind === "observation" && this.labMeasurementIds.has(node.semanticId)),
      conversations: (node) => node.kind === "conversation" || node.kind === "message" || node.kind === "media-attachment",
      "coach-brief": (node) => node.kind === "coach-brief" || node.kind === "coach-task",
      churn: (node) => node.kind === "churn-assessment" || node.kind === "churn-reason",
    };
  }

  private base(evidenceIds: readonly string[]) {
    return {
      memberId: this.memberId,
      contextRevisionId: this.contextRevisionId,
      authority: this.authority,
      evidenceIds,
      authoritativeEvidenceAnchor: this.authoritativeEvidenceAnchor,
    } as const;
  }

  private invalid<T>(code: "invalid-bound" | "invalid-cursor" | "invalid-window" | "invalid-evidence-id", message: string): MemberContextQueryResult<T> {
    return { status: "invalid", ...this.base([]), code, message };
  }

  private empty<T>(message: string): MemberContextQueryResult<T> {
    return { status: "empty", ...this.base([]), message };
  }

  private validateBounds<T>(query: BoundedMemberContextQuery): MemberContextQueryResult<T> | { limit: number } {
    const runtime = query as Partial<BoundedMemberContextQuery>;
    const limit = runtime.limit ?? MEMBER_CONTEXT_QUERY_DEFAULTS.limit;
    const timeoutMs = runtime.timeoutMs ?? MEMBER_CONTEXT_QUERY_DEFAULTS.timeoutMs;
    if (!Number.isInteger(limit) || limit < 1 || limit > MEMBER_CONTEXT_QUERY_MAXIMA.limit
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MEMBER_CONTEXT_QUERY_MAXIMA.timeoutMs) {
      return this.invalid("invalid-bound", "Query limit or timeout is outside the supported bounds.");
    }
    return { limit };
  }

  private encodeCursor(payload: CursorPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.cursorSecret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  private decodeCursor(cursor: string): CursorPayload | undefined {
    try {
      if (cursor.length > 4_096) return undefined;
      const [encoded, signature, extra] = cursor.split(".");
      if (!encoded || !signature || extra) return undefined;
      const expected = createHmac("sha256", this.cursorSecret).update(encoded).digest();
      const actual = Buffer.from(signature, "base64url");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as CursorPayload;
      return payload.version === 1
        && typeof payload.operation === "string"
        && typeof payload.memberId === "string"
        && typeof payload.contextRevisionId === "string"
        && typeof payload.query === "string"
        && Number.isInteger(payload.offset)
        && payload.offset >= 0
        ? payload
        : undefined;
    } catch {
      return undefined;
    }
  }

  private paginate<T>(
    operation: string,
    fingerprint: string,
    query: BoundedMemberContextQuery,
    values: readonly T[],
  ): Page<T> | MemberContextQueryResult<readonly T[]> {
    const bounds = this.validateBounds<readonly T[]>(query);
    if (!("limit" in bounds)) return bounds;
    let offset = 0;
    if (query.cursor !== undefined) {
      const cursor = this.decodeCursor(query.cursor);
      if (!cursor
        || cursor.operation !== operation
        || cursor.memberId !== this.memberId
        || cursor.contextRevisionId !== this.contextRevisionId
        || cursor.query !== fingerprint) {
        return this.invalid("invalid-cursor", "Cursor does not belong to this member-context query.");
      }
      offset = cursor.offset;
    }
    const data = values.slice(offset, offset + bounds.limit);
    const nextOffset = offset + data.length;
    return {
      status: "ready",
      data,
      ...(nextOffset < values.length
        ? { nextCursor: this.encodeCursor({
          version: 1,
          operation,
          memberId: this.memberId,
          contextRevisionId: this.contextRevisionId,
          query: fingerprint,
          offset: nextOffset,
        }) }
        : {}),
    };
  }

  private ready<T>(data: T, evidenceIds: readonly string[], nextCursor?: string): MemberContextQueryResult<T> {
    return { status: "ready", ...this.base(evidenceIds), data, ...(nextCursor ? { nextCursor } : {}) };
  }

  private nodesForDomains(domains: readonly MemberContextEvidenceDomain[]): MemberContextRevisionScopedNode[] {
    const selected = new Map<string, MemberContextRevisionScopedNode>();
    for (const node of this.revisionNodes) {
      if (domains.some((domain) => this.domainPredicates[domain](node))) selected.set(node.assertionId, node);
    }
    return [...selected.values()].sort(compareEvidence);
  }

  async getSummary(query: SummaryQuery): Promise<MemberContextQueryResult<MemberSummaryProjection>> {
    const bounds = this.validateBounds<MemberSummaryProjection>(query);
    if (!("limit" in bounds)) return bounds;
    if (query.cursor !== undefined) return this.invalid("invalid-cursor", "Summary queries do not use cursors.");
    const profile = this.revisionNodes.find((node) => node.kind === "member-profile");
    if (!profile) return this.empty("Member summary is unavailable.");
    const assessment = this.revisionNodes.filter((node) => node.kind === "churn-assessment").sort(compareEvidence).at(-1) ?? null;
    const includedAssessment = bounds.limit > 1 ? assessment : null;
    const goals = this.revisionNodes
      .filter((node) => node.kind === "goal")
      .sort(compareEvidence)
      .slice(0, bounds.limit - 1 - (includedAssessment ? 1 : 0));
    const evidenceIds = [profile.assertionId, ...goals.map((node) => node.assertionId), ...(includedAssessment ? [includedAssessment.assertionId] : [])];
    return this.ready({
      profileAssertionId: profile.assertionId,
      goalAssertionIds: goals.map((node) => node.assertionId),
      riskAssessmentAssertionId: includedAssessment?.assertionId ?? null,
    }, evidenceIds);
  }

  async getEvidence(query: EvidenceQuery): Promise<MemberContextQueryResult<readonly MemberEvidenceProjection[]>> {
    const bounds = this.validateBounds<readonly MemberEvidenceProjection[]>(query);
    if (!("limit" in bounds)) return bounds;
    if (!Array.isArray(query.domains) || query.domains.length === 0
      || query.domains.length > memberContextEvidenceDomains.size
      || query.domains.some((domain) => !memberContextEvidenceDomains.has(domain))) {
      return this.invalid("invalid-bound", "Evidence domains are invalid or exceed the supported bound.");
    }
    if (query.evidenceKinds !== undefined && (!Array.isArray(query.evidenceKinds)
      || query.evidenceKinds.length > memberContextEvidenceKinds.size)) {
      return this.invalid("invalid-bound", "Evidence kinds are invalid or exceed the requested result bound.");
    }
    const evidenceKinds = query.evidenceKinds === undefined
      ? undefined
      : [...new Set(query.evidenceKinds)].sort(compareCodePoints);
    if (evidenceKinds && (evidenceKinds.length === 0
      || evidenceKinds.length > bounds.limit
      || evidenceKinds.some((kind) => !memberContextEvidenceKinds.has(kind)))) {
      return this.invalid("invalid-bound", "Evidence kinds are invalid or exceed the requested result bound.");
    }
    if (query.window && !isValidWindow(query.window)) return this.invalid("invalid-window", "The requested time window is invalid.");
    const nodes = this.nodesForDomains(query.domains)
      .filter((node) => !query.window || isInWindow(node, query.window))
      .filter((node) => !evidenceKinds || evidenceKinds.includes(node.kind));
    const reserved = evidenceKinds
      ? evidenceKinds.flatMap((kind) => nodes.find((node) => node.kind === kind) ?? [])
      : [];
    const reservedIds = new Set(reserved.map((node) => node.assertionId));
    const orderedNodes = evidenceKinds
      ? [...reserved.sort(compareEvidence), ...nodes.filter((node) => !reservedIds.has(node.assertionId))]
      : nodes;
    const fingerprint = JSON.stringify({
      domains: [...new Set(query.domains)].sort(),
      evidenceKinds: evidenceKinds ?? null,
      window: query.window ?? null,
    });
    const page = this.paginate("evidence", fingerprint, query, orderedNodes);
    if (page.status !== "ready") return page;
    if (page.data.length === 0) return this.empty("No evidence is available for the requested domain and window.");
    const data = page.data.map(projectEvidence);
    return this.ready(data, data.map((fact) => fact.evidenceId), page.nextCursor);
  }

  async getLongitudinalSeries(query: LongitudinalSeriesQuery): Promise<MemberContextQueryResult<readonly LongitudinalPointProjection[]>> {
    const bounds = this.validateBounds<readonly LongitudinalPointProjection[]>(query);
    if (!("limit" in bounds)) return bounds;
    if (typeof query.metric !== "string" || !query.metric.trim()
      || !Number.isInteger(query.minimumPoints) || query.minimumPoints < 1 || query.minimumPoints > bounds.limit) {
      return this.invalid("invalid-bound", "Metric and minimum point bounds are invalid.");
    }
    if (!isValidWindow(query.window)) return this.invalid("invalid-window", "The requested time window is invalid.");
    const nodes = this.revisionNodes
      .filter((node): node is Extract<MemberContextRevisionScopedNode, { kind: "observation" }> => node.kind === "observation")
      .filter((node) => node.metric === query.metric && isInWindow(node, query.window))
      .sort(compareEvidence);
    const evidenceIds = nodes.slice(0, bounds.limit).map((node) => node.assertionId);
    if (nodes.length < query.minimumPoints) {
      return {
        status: "insufficient-history",
        ...this.base(evidenceIds),
        requiredPoints: query.minimumPoints,
        availablePoints: nodes.length,
      };
    }
    const fingerprint = JSON.stringify({ metric: query.metric, window: query.window, minimumPoints: query.minimumPoints });
    const page = this.paginate("longitudinal-series", fingerprint, query, nodes);
    if (page.status !== "ready") return page;
    const data = page.data.map((node): LongitudinalPointProjection => projectEvidence(node));
    return this.ready(data, data.map((fact) => fact.evidenceId), page.nextCursor);
  }

  async getRelativeOrderSequence(query: RelativeOrderSequenceQuery): Promise<MemberContextQueryResult<readonly LongitudinalPointProjection[]>> {
    const bounds = this.validateBounds<readonly LongitudinalPointProjection[]>(query);
    if (!("limit" in bounds)) return bounds;
    if (query.cursor !== undefined) return this.invalid("invalid-cursor", "Relative-order sequences do not use cursors.");
    if (typeof query.metric !== "string" || !query.metric.trim()
      || !Number.isInteger(query.minimumPoints) || query.minimumPoints < 1 || query.minimumPoints > bounds.limit) {
      return this.invalid("invalid-bound", "Metric and minimum point bounds are invalid.");
    }
    const nodes = this.revisionNodes
      .filter((node): node is Extract<MemberContextRevisionScopedNode, { kind: "observation" }> => (
        node.kind === "observation"
        && node.metric === query.metric
        && node.temporal.precision === "relative-order"
      ))
      .sort((left, right) => left.temporal.precision === "relative-order"
        && right.temporal.precision === "relative-order"
        ? left.temporal.sourceOrder - right.temporal.sourceOrder || compareEvidence(left, right)
        : compareEvidence(left, right))
      .slice(0, bounds.limit);
    if (nodes.length < query.minimumPoints) {
      return {
        status: "insufficient-history",
        ...this.base(nodes.map((node) => node.assertionId)),
        requiredPoints: query.minimumPoints,
        availablePoints: nodes.length,
      };
    }
    const data = nodes.map((node): LongitudinalPointProjection => projectEvidence(node));
    return this.ready(data, data.map((point) => point.evidenceId));
  }

  async getConversation(query: ConversationQuery): Promise<MemberContextQueryResult<ConversationProjection>> {
    const bounds = this.validateBounds<ConversationProjection>(query);
    if (!("limit" in bounds)) return bounds;
    if (!isValidWindow(query.window)) return this.invalid("invalid-window", "The requested time window is invalid.");
    if (query.conversationId && !isEvidenceId(query.conversationId)) return this.invalid("invalid-evidence-id", "Conversation evidence ID is invalid.");
    const conversations = this.revisionNodes.filter((node) => node.kind === "conversation");
    const conversation = query.conversationId
      ? conversations.find((node) => node.assertionId === query.conversationId)
      : conversations.sort(compareEvidence)[0];
    if (!conversation) return this.empty("Conversation is unavailable.");
    const messageIds = new Set(this.snapshot.relationships
      .filter((edge) => edge.kind === "CONTAINS_MESSAGE" && edge.fromSemanticId === conversation.semanticId)
      .map((edge) => edge.toSemanticId));
    const messages = this.revisionNodes
      .filter((node): node is Extract<MemberContextRevisionScopedNode, { kind: "message" }> => node.kind === "message" && messageIds.has(node.semanticId))
      .filter((node) => isInWindow(node, query.window))
      .sort(compareEvidence);
    const fingerprint = JSON.stringify({ conversationId: conversation.assertionId, window: query.window });
    const page = this.paginate("conversation", fingerprint, query, messages);
    if (page.status !== "ready") return page as MemberContextQueryResult<ConversationProjection>;
    if (page.data.length === 0) return this.empty("No messages are available in the requested window.");
    const projected = page.data.map((message): MessageProjection => {
      const attachmentIds = new Set(this.snapshot.relationships
        .filter((edge) => edge.kind === "HAS_ATTACHMENT" && edge.fromSemanticId === message.semanticId)
        .map((edge) => edge.toSemanticId));
      const attachments = this.revisionNodes
        .filter((node): node is Extract<MemberContextRevisionScopedNode, { kind: "media-attachment" }> => node.kind === "media-attachment" && attachmentIds.has(node.semanticId))
        .sort(compareEvidence);
      return {
        ...projectEvidence(message),
        senderRole: message.senderRole,
        text: message.text,
        attachmentEvidenceIds: attachments.map((node) => node.assertionId),
        attachments: attachments.map((attachment) => projectEvidence(attachment)),
      };
    });
    const evidenceIds = [conversation.assertionId, ...projected.flatMap((message) => [message.evidenceId, ...message.attachmentEvidenceIds])];
    return this.ready({ conversationEvidenceId: conversation.assertionId, messages: projected }, evidenceIds, page.nextCursor);
  }

  async getCoachBrief(query: CoachBriefQuery): Promise<MemberContextQueryResult<CoachBriefProjection>> {
    const bounds = this.validateBounds<CoachBriefProjection>(query);
    if (!("limit" in bounds)) return bounds;
    if (query.cursor !== undefined) return this.invalid("invalid-cursor", "Coach brief queries do not use cursors.");
    const briefs = this.revisionNodes.filter((node) => node.kind === "coach-brief").sort(compareEvidence);
    const brief = query.generatedFor ? briefs.find((node) => node.generatedFor === query.generatedFor) : briefs.at(-1);
    if (!brief) return this.empty("Coach brief is unavailable.");
    const childEdges = this.snapshot.relationships.filter((edge) => edge.fromSemanticId === brief.semanticId);
    const taskIds = new Set(childEdges.filter((edge) => edge.kind === "HAS_TASK").map((edge) => edge.toSemanticId));
    const assessmentId = childEdges.find((edge) => edge.kind === "HAS_ASSESSMENT")?.toSemanticId;
    const assessment = assessmentId ? this.nodesBySemanticId.get(assessmentId) : undefined;
    const includedAssessment = bounds.limit > 1 ? assessment : undefined;
    const tasks = this.revisionNodes
      .filter((node): node is Extract<MemberContextRevisionScopedNode, { kind: "coach-task" }> => node.kind === "coach-task" && taskIds.has(node.semanticId))
      .sort((left, right) => left.sourceOrder - right.sourceOrder || compareEvidence(left, right))
      .slice(0, bounds.limit - 1 - (includedAssessment ? 1 : 0));
    const evidenceIds = [brief.assertionId, ...tasks.map((node) => node.assertionId), ...(includedAssessment ? [includedAssessment.assertionId] : [])];
    return this.ready({
      briefEvidenceId: brief.assertionId,
      taskEvidenceIds: tasks.map((node) => node.assertionId),
      assessmentEvidenceId: includedAssessment?.assertionId ?? null,
      brief: projectEvidence(brief),
      tasks: tasks.map((task) => projectEvidence(task)),
      assessment: includedAssessment?.kind === "churn-assessment"
        ? projectEvidence(includedAssessment)
        : null,
    }, evidenceIds);
  }

  async getWorkoutConstraints(
    query: WorkoutConstraintsQuery,
  ): Promise<MemberContextQueryResult<WorkoutConstraintsProjection>> {
    const bounds = this.validateBounds<WorkoutConstraintsProjection>(query);
    if (!("limit" in bounds)) return bounds;
    if (query.cursor !== undefined) {
      return this.invalid("invalid-cursor", "Workout constraint queries do not use cursors.");
    }

    const equipmentNodes: Extract<MemberContextRevisionScopedNode, { kind: "equipment-availability" }>[] = [];
    const injuryNodes: Extract<MemberContextRevisionScopedNode, { kind: "injury-episode" }>[] = [];
    const preferenceNodes: Extract<MemberContextRevisionScopedNode, { kind: "preference" }>[] = [];
    for (const node of this.revisionNodes) {
      if (node.kind === "equipment-availability") equipmentNodes.push(node);
      else if (node.kind === "injury-episode") injuryNodes.push(node);
      else if (node.kind === "preference") preferenceNodes.push(node);
    }

    const equipment = equipmentNodes
      .sort((left, right) => compareCodePoints(left.originalLabel, right.originalLabel)
        || compareCodePoints(left.assertionId, right.assertionId))
      .map((node): WorkoutEquipmentConstraintProjection => ({
        ...evidenceProjectionBase(node),
        kind: node.kind,
        originalLabel: node.originalLabel,
        available: node.available,
        domainReference: node.domainReference,
      }));
    const injuries = injuryNodes
      .sort(compareEvidence)
      .map((node): WorkoutInjuryConstraintProjection => ({
        ...evidenceProjectionBase(node),
        kind: node.kind,
        region: node.region,
        joint: node.joint,
        status: node.status,
        severity: node.severity,
        since: node.since,
        notes: node.notes,
        domainReferences: node.domainReferences,
      }));
    const preferences = preferenceNodes
      .sort(compareEvidence)
      .map((node): WorkoutPreferenceConstraintProjection => ({
        ...evidenceProjectionBase(node),
        kind: node.kind,
        preferredSessionMinutes: node.preferredSessionMinutes,
        trainingDaysPerWeek: node.trainingDaysPerWeek,
        preferredDays: node.preferredDays,
        dislikes: node.dislikes,
        notes: node.notes,
        domainReferences: node.domainReferences,
      }));
    const evidenceIds = [
      ...equipment.map((fact) => fact.assertionId),
      ...injuries.map((fact) => fact.assertionId),
      ...preferences.map((fact) => fact.assertionId),
    ];
    if (evidenceIds.length > bounds.limit) {
      return this.invalid("invalid-bound", "Workout constraints exceed the requested complete-result bound.");
    }
    return this.ready({ equipment, injuries, preferences }, evidenceIds);
  }

  async getRelatedEvidence(query: RelatedEvidenceQuery): Promise<MemberContextQueryResult<readonly MemberEvidenceProjection[]>> {
    if (!isEvidenceId(query.evidenceId)) return this.invalid("invalid-evidence-id", "Evidence ID is invalid.");
    if (query.maxDepth !== 1 && query.maxDepth !== 2) return this.invalid("invalid-bound", "Related evidence depth is invalid.");
    const root = this.nodesByEvidenceId.get(query.evidenceId);
    if (!root) return this.empty("Related evidence is unavailable.");
    const found = new Map<string, MemberContextRevisionScopedNode>();
    let frontier = new Set([root.semanticId]);
    const visited = new Set(frontier);
    for (let depth = 0; depth < query.maxDepth; depth += 1) {
      const next = new Set<string>();
      for (const edge of this.snapshot.relationships) {
        if (!relatedRelationshipKinds.has(edge.kind) || !frontier.has(edge.fromSemanticId)) continue;
        const node = this.nodesBySemanticId.get(edge.toSemanticId);
        if (!node || visited.has(node.semanticId)) continue;
        visited.add(node.semanticId);
        found.set(node.assertionId, node);
        next.add(node.semanticId);
      }
      frontier = next;
    }
    const nodes = [...found.values()].sort(compareEvidence);
    const page = this.paginate("related-evidence", JSON.stringify({ evidenceId: query.evidenceId, maxDepth: query.maxDepth }), query, nodes);
    if (page.status !== "ready") return page;
    if (page.data.length === 0) return this.empty("Related evidence is unavailable.");
    const data = page.data.map(projectEvidence);
    return this.ready(data, data.map((fact) => fact.evidenceId), page.nextCursor);
  }

  async getCitations(query: CitationLookupQuery): Promise<MemberContextQueryResult<readonly CitationProjection[]>> {
    const bounds = this.validateBounds<readonly CitationProjection[]>(query);
    if (!("limit" in bounds)) return bounds;
    if (!Array.isArray(query.evidenceIds) || query.evidenceIds.length === 0
      || query.evidenceIds.length > MEMBER_CONTEXT_QUERY_MAXIMA.evidenceIds
      || query.evidenceIds.length > bounds.limit
      || query.evidenceIds.some((id) => !isEvidenceId(id))) {
      return this.invalid("invalid-evidence-id", "Citation evidence IDs are invalid or exceed the lookup bound.");
    }
    if (query.cursor !== undefined) return this.invalid("invalid-cursor", "Citation lookups do not use cursors.");
    const requested = [...new Set(query.evidenceIds)];
    const nodes = requested.map((id) => this.nodesByEvidenceId.get(id));
    if (nodes.some((node) => !node)) return this.empty("Citations are unavailable.");
    const data = (nodes as MemberContextRevisionScopedNode[])
      .sort(compareEvidence)
      .map((node): CitationProjection => evidenceProjectionBase(node));
    return this.ready(data, data.map((citation) => citation.evidenceId));
  }
}

/**
 * Shared projection engine for canonical adapters. Callers must supply a
 * snapshot that they loaded and integrity-checked from their own authority.
 */
export function createMemberContextReadHandle(
  snapshot: MemberContextGraphSnapshot,
  coachId: string,
  authority: MemberContextAuthority,
  cursorSecret: Buffer = randomBytes(32),
): MemberContextReadHandle {
  return new InMemoryMemberContextReadHandle(snapshot, coachId, authority, cursorSecret);
}

export type TrustedMemberContextScope = {
  readonly coachId: string;
  readonly memberId: string;
  readonly authorizationId: string;
};

export type MemberContextGraphRepositoryResult =
  | { readonly status: "ready"; readonly data: MemberContextGraphSnapshot }
  | { readonly status: "empty"; readonly message: string }
  | { readonly status: "denied"; readonly message: string }
  | { readonly status: "unavailable"; readonly message: string };

export type InMemoryMemberContextGraphRepositoryOptions = {
  readonly authorize: (scope: TrustedMemberContextScope) => boolean;
};

export class InMemoryMemberContextGraphRepository {
  private available = true;

  constructor(
    private readonly publisher: InMemoryMemberContextPublisher,
    private readonly options: InMemoryMemberContextGraphRepositoryOptions,
  ) {}

  setAvailable(available: boolean): void {
    this.available = available;
  }

  getActive(scope: TrustedMemberContextScope): MemberContextGraphRepositoryResult {
    if (!this.options.authorize(scope)) return { status: "denied", message: "Trusted scope does not authorize this member." };
    if (!this.available) return { status: "unavailable", message: "Member context repository is unavailable." };
    const revisionId = this.publisher.getActiveRevisionId(scope.memberId);
    if (!revisionId) return { status: "empty", message: "No active member context revision." };
    return this.getAuthorizedRevision(scope.memberId, revisionId);
  }

  getRevision(scope: TrustedMemberContextScope, contextRevisionId: string): MemberContextGraphRepositoryResult {
    if (!this.options.authorize(scope)) return { status: "denied", message: "Trusted scope does not authorize this member." };
    if (!this.available) return { status: "unavailable", message: "Member context repository is unavailable." };
    return this.getAuthorizedRevision(scope.memberId, contextRevisionId);
  }

  private getAuthorizedRevision(memberId: string, contextRevisionId: string): MemberContextGraphRepositoryResult {
    const snapshot = this.publisher.getRevision(memberId, contextRevisionId);
    return snapshot
      ? { status: "ready", data: snapshot }
      : { status: "empty", message: "Member context revision is unavailable." };
  }
}
