import type {
  AssertionClassification,
  AssertionSource,
  AssertionTemporal,
  MemberContextAuthority,
  MemberContextRevisionScopedNode,
} from "./member-context";

export const COPILOT_QUICK_PROMPT_IDS = [
  "morning-brief",
  "adherence",
  "sleep",
  "changes-since-last-week",
  "churn-risk",
] as const;
export type CopilotQuickPromptId = (typeof COPILOT_QUICK_PROMPT_IDS)[number];

export const COPILOT_CANONICAL_INTENT_IDS = COPILOT_QUICK_PROMPT_IDS;
export type CopilotCanonicalIntentId = (typeof COPILOT_CANONICAL_INTENT_IDS)[number];

export const COPILOT_SECTION_IDS = [
  "answer",
  "recent-facts",
  "trend",
  "stable-context",
  "next-action",
  "morning-brief",
  "limitation",
] as const;
export type CopilotSectionId = (typeof COPILOT_SECTION_IDS)[number];

export const COPILOT_ACTION_IDS = [
  "review-with-member",
  "celebrate-progress",
  "review-adherence",
  "review-sleep",
  "review-churn-risk",
] as const;
export type CopilotActionId = (typeof COPILOT_ACTION_IDS)[number];

export type CopilotQuestionInput =
  | { readonly kind: "quick-prompt"; readonly promptId: CopilotQuickPromptId }
  | { readonly kind: "free-text"; readonly question: string };

/** Browser-facing input. Authorization and revision scope are derived server-side. */
export type CopilotRequest = {
  readonly schemaVersion: "copilot-request/v1";
  readonly requestId: string;
  readonly memberId: string;
  readonly requestedFor: string;
  readonly input: CopilotQuestionInput;
  readonly continuation?: SignedCopilotContinuation;
};

export type CopilotScopeEnvelope = {
  readonly memberId: string;
  readonly contextRevisionId: string;
  readonly authority: MemberContextAuthority;
};

type CopilotEvidenceBase = CopilotScopeEnvelope & {
  readonly evidenceId: string;
  readonly evidenceKind: MemberContextRevisionScopedNode["kind"];
  readonly source: AssertionSource;
  readonly classification: AssertionClassification;
  readonly temporal: AssertionTemporal;
  readonly unit: string | null;
};

export type CopilotFactEvidenceAtom = CopilotEvidenceBase & {
  readonly atomKind: "fact";
  readonly value: string | number | boolean | null;
};

/** Images and other attachments remain source metadata, never analyzed facts. */
export type CopilotMediaEvidenceAtom = CopilotEvidenceBase & {
  readonly atomKind: "media-metadata";
  readonly evidenceKind: "media-attachment";
  readonly mediaType: string;
  readonly caption: string;
  readonly assetStatus: "metadata-only";
  readonly analysisStatus: "not-analyzed";
  readonly unit: null;
};

export type CopilotEvidenceAtom = CopilotFactEvidenceAtom | CopilotMediaEvidenceAtom;

export type CopilotEvidencePack = CopilotScopeEnvelope & {
  readonly atoms: readonly CopilotEvidenceAtom[];
};

export type CopilotContinuationClaims = {
  readonly schemaVersion: "copilot-continuation-claims/v1";
  readonly coachId: string;
  readonly memberId: string;
  readonly contextRevisionId: string;
  readonly answerId: string;
  readonly intentId: CopilotCanonicalIntentId;
  readonly selectedEvidenceIds: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
};

/** Signature creation and verification remain a server-only outer-edge concern. */
export type SignedCopilotContinuation = {
  readonly schemaVersion: "signed-copilot-continuation/v1";
  readonly algorithm: "hmac-sha256";
  readonly claims: Readonly<CopilotContinuationClaims>;
  readonly signature: string;
};

export type CopilotAnswerClause = {
  readonly clauseId: string;
  readonly text: string;
  readonly evidenceIds: readonly string[];
};

export type CopilotAnswerSection = {
  readonly sectionId: CopilotSectionId;
  readonly clauses: readonly CopilotAnswerClause[];
};

export type CopilotChartPoint = {
  readonly pointId: string;
  readonly label: string;
  readonly value: number;
  readonly evidenceIds: readonly string[];
};

export type CopilotChart = CopilotScopeEnvelope & {
  readonly chartId: string;
  readonly recipeId: string;
  readonly type: "bar" | "line";
  readonly unit: string;
  readonly precision: AssertionTemporal["precision"];
  readonly temporalMode: "calendar" | "relative-order";
  readonly points: readonly CopilotChartPoint[];
  readonly textSummary: string;
};

export type CopilotCitation = CopilotScopeEnvelope & {
  readonly citationId: string;
  readonly evidenceId: string;
  readonly label: string;
  readonly source: AssertionSource;
  readonly classification: AssertionClassification;
  readonly temporal: AssertionTemporal;
  readonly unit: string | null;
};

export type CopilotDerivedChurnLevel = "low" | "watch" | "elevated" | "insufficient-evidence";

export type CopilotDerivedChurnReason = {
  readonly code: string;
  readonly evidenceIds: readonly string[];
};

export type CopilotExcludedChurnReason = {
  readonly code: string;
  readonly basisStatus: "unsupported-source";
  readonly evidenceIds: readonly string[];
};

export type CopilotDerivedChurnAssessment = CopilotScopeEnvelope & {
  readonly methodVersion: "churn-v1";
  readonly level: CopilotDerivedChurnLevel;
  readonly reasons: readonly CopilotDerivedChurnReason[];
  readonly excludedSourceReasons: readonly CopilotExcludedChurnReason[];
  readonly evidenceIds: readonly string[];
};

export type CopilotSourceChurnReason = {
  readonly text: string;
  readonly basisStatus: "supported" | "unsupported-source";
  readonly evidenceIds: readonly string[];
};

export type CopilotSourceChurnAssessment = CopilotScopeEnvelope & {
  readonly level: string;
  readonly reasons: readonly CopilotSourceChurnReason[];
  readonly evidenceIds: readonly string[];
};

export type CopilotChurnView = {
  readonly derived: CopilotDerivedChurnAssessment;
  readonly source: CopilotSourceChurnAssessment | null;
};

export type CopilotBriefFreshness = {
  readonly status: "requested-date" | "latest-recorded";
  readonly generatedFor: string;
};

export type CopilotAnswerPacket = CopilotScopeEnvelope & {
  readonly schemaVersion: "copilot-answer/v1";
  readonly requestId: string;
  readonly answerId: string;
  readonly intentId: CopilotCanonicalIntentId;
  readonly requestedFor: string;
  readonly evidenceAsOf: string;
  readonly memberTimezone: string;
  readonly briefFreshness: CopilotBriefFreshness | null;
  readonly evidence: CopilotEvidencePack;
  readonly sections: readonly CopilotAnswerSection[];
  readonly chart: CopilotChart | null;
  readonly citations: readonly CopilotCitation[];
  readonly churn: CopilotChurnView | null;
  readonly continuation: SignedCopilotContinuation;
};

export type CopilotPin = CopilotScopeEnvelope & {
  readonly schemaVersion: "copilot-pin/v1";
  readonly pinId: string;
  readonly answerId: string;
  readonly sectionId: CopilotSectionId;
  readonly createdAt: string;
  readonly renderedSnapshot: Readonly<{
    readonly section: CopilotAnswerSection;
    readonly chart: CopilotChart | null;
    readonly citations: readonly CopilotCitation[];
  }>;
};

type CopilotOutcomeBase = { readonly requestId: string };
export type CopilotOutcome =
  | (CopilotOutcomeBase & { readonly status: "ready"; readonly answer: CopilotAnswerPacket })
  | (CopilotOutcomeBase & { readonly status: "empty"; readonly message: string })
  | (CopilotOutcomeBase & {
      readonly status: "insufficient-history";
      readonly requiredPoints: number;
      readonly availablePoints: number;
      readonly message: string;
    })
  | (CopilotOutcomeBase & {
      readonly status: "stale";
      readonly requestedRevisionId: string;
      readonly activeRevisionId: string | null;
      readonly message: string;
    })
  | (CopilotOutcomeBase & { readonly status: "continuation-expired"; readonly message: string })
  | (CopilotOutcomeBase & { readonly status: "denied"; readonly message: string })
  | (CopilotOutcomeBase & { readonly status: "invalid"; readonly code: string; readonly message: string })
  | (CopilotOutcomeBase & {
      readonly status: "unavailable";
      readonly code: "graph-unavailable" | "graph-timeout";
      readonly retryable: true;
      readonly message: string;
    })
  | (CopilotOutcomeBase & {
      readonly status: "model-error";
      readonly code: "provider-unavailable" | "provider-timeout" | "malformed-selection" | "grounding-rejected";
      readonly retryable: true;
      readonly message: string;
    })
  | (CopilotOutcomeBase & {
      readonly status: "unsupported";
      readonly supportedPromptIds: readonly CopilotQuickPromptId[];
      readonly message: string;
    })
  | (CopilotOutcomeBase & { readonly status: "cancelled" });

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function immutableClone<Value>(value: Value): Readonly<Value> {
  return deepFreeze(structuredClone(value));
}

function requireNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
}

function sameScope(left: CopilotScopeEnvelope, right: CopilotScopeEnvelope): boolean {
  return left.memberId === right.memberId
    && left.contextRevisionId === right.contextRevisionId
    && left.authority === right.authority;
}

function requireSameScope(packet: CopilotScopeEnvelope, nested: CopilotScopeEnvelope): void {
  if (!sameScope(packet, nested)) throw new Error("Copilot material must use the packet member and revision envelope.");
}

function requireKnownEvidence(ids: readonly string[], known: ReadonlySet<string>, label: string): void {
  if (ids.length === 0 || ids.some((id) => !known.has(id))) {
    throw new Error(`${label} must reference contributing packet evidence.`);
  }
}

export function createSignedCopilotContinuation(input: {
  readonly claims: CopilotContinuationClaims;
  readonly signature: string;
}): SignedCopilotContinuation {
  requireNonEmpty(input.signature, "Continuation signature");
  const issuedAt = Date.parse(input.claims.issuedAt);
  const expiresAt = Date.parse(input.claims.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt >= expiresAt) {
    throw new Error("Continuation timestamps are invalid.");
  }
  return immutableClone({
    schemaVersion: "signed-copilot-continuation/v1",
    algorithm: "hmac-sha256",
    claims: input.claims,
    signature: input.signature,
  }) as SignedCopilotContinuation;
}

export function createCopilotAnswerPacket(input: CopilotAnswerPacket): CopilotAnswerPacket {
  requireNonEmpty(input.requestId, "Request ID");
  requireNonEmpty(input.answerId, "Answer ID");
  requireSameScope(input, input.evidence);
  const knownEvidence = new Set<string>();
  for (const atom of input.evidence.atoms) {
    requireSameScope(input, atom);
    if (knownEvidence.has(atom.evidenceId)) throw new Error("Packet evidence IDs must be unique.");
    knownEvidence.add(atom.evidenceId);
  }
  for (const section of input.sections) {
    for (const clause of section.clauses) requireKnownEvidence(clause.evidenceIds, knownEvidence, "Answer clause");
  }
  if (input.chart) {
    requireSameScope(input, input.chart);
    for (const point of input.chart.points) requireKnownEvidence(point.evidenceIds, knownEvidence, "Chart point");
  }
  for (const citation of input.citations) {
    requireSameScope(input, citation);
    requireKnownEvidence([citation.evidenceId], knownEvidence, "Citation");
  }
  if (input.churn) {
    requireSameScope(input, input.churn.derived);
    requireKnownEvidence(input.churn.derived.evidenceIds, knownEvidence, "Derived churn assessment");
    for (const reason of input.churn.derived.reasons) {
      requireKnownEvidence(reason.evidenceIds, knownEvidence, "Derived churn reason");
    }
    for (const reason of input.churn.derived.excludedSourceReasons) {
      requireKnownEvidence(reason.evidenceIds, knownEvidence, "Excluded churn reason");
    }
    if (input.churn.source) {
      requireSameScope(input, input.churn.source);
      requireKnownEvidence(input.churn.source.evidenceIds, knownEvidence, "Source churn assessment");
      for (const reason of input.churn.source.reasons) {
        requireKnownEvidence(reason.evidenceIds, knownEvidence, "Source churn reason");
      }
    }
  }
  const continuation = input.continuation.claims;
  if (continuation.memberId !== input.memberId
    || continuation.contextRevisionId !== input.contextRevisionId
    || continuation.answerId !== input.answerId
    || continuation.intentId !== input.intentId) {
    throw new Error("Continuation must use the packet member and revision envelope.");
  }
  for (const evidenceId of continuation.selectedEvidenceIds) {
    if (!knownEvidence.has(evidenceId)) throw new Error("Continuation references unknown packet evidence.");
  }
  return immutableClone(input) as CopilotAnswerPacket;
}

export function createCopilotPin(input: {
  readonly pinId: string;
  readonly answer: CopilotAnswerPacket;
  readonly sectionId: CopilotSectionId;
  readonly createdAt: string;
}): CopilotPin {
  const section = input.answer.sections.find((candidate) => candidate.sectionId === input.sectionId);
  if (!section) throw new Error("Pinned section is not present in the answer.");
  return immutableClone({
    schemaVersion: "copilot-pin/v1",
    pinId: input.pinId,
    answerId: input.answer.answerId,
    memberId: input.answer.memberId,
    contextRevisionId: input.answer.contextRevisionId,
    authority: input.answer.authority,
    sectionId: input.sectionId,
    createdAt: input.createdAt,
    renderedSnapshot: {
      section,
      chart: input.answer.chart,
      citations: input.answer.citations,
    },
  }) as CopilotPin;
}
