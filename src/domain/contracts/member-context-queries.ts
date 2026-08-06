import type {
  AssertionClassification,
  AssertionSource,
  AssertionTemporal,
  MemberContextAuthority,
  MemberContextRevisionScopedNode,
} from "./member-context";

declare const authorizedMemberScope: unique symbol;

export type AuthorizedMemberContextScope = {
  readonly coachId: string;
  readonly memberId: string;
  readonly authorizationId: string;
  readonly [authorizedMemberScope]: "server-authorized";
};

export type MemberContextEvidenceDomain =
  | "profile"
  | "goals"
  | "preferences"
  | "equipment"
  | "injuries"
  | "workouts"
  | "adherence"
  | "biomarkers"
  | "labs"
  | "conversations"
  | "coach-brief"
  | "churn";

export type MemberContextTimeWindow = {
  readonly fromInclusive: string;
  readonly toExclusive: string;
};

export type BoundedMemberContextQuery = {
  readonly limit: number;
  readonly timeoutMs: number;
  readonly cursor?: string;
};

export type SummaryQuery = BoundedMemberContextQuery;

export type EvidenceQuery = BoundedMemberContextQuery & {
  readonly domains: readonly MemberContextEvidenceDomain[];
  readonly window?: MemberContextTimeWindow;
};

export type LongitudinalSeriesQuery = BoundedMemberContextQuery & {
  readonly metric: string;
  readonly window: MemberContextTimeWindow;
  readonly minimumPoints: number;
};

export type ConversationQuery = BoundedMemberContextQuery & {
  readonly conversationId?: string;
  readonly window: MemberContextTimeWindow;
};

export type CoachBriefQuery = BoundedMemberContextQuery & {
  readonly generatedFor?: string;
};

export type RelatedEvidenceQuery = BoundedMemberContextQuery & {
  readonly evidenceId: string;
  readonly maxDepth: 1 | 2;
};

export type CitationLookupQuery = BoundedMemberContextQuery & {
  readonly evidenceIds: readonly string[];
};

type QueryEnvelope = {
  readonly memberId: string;
  readonly contextRevisionId: string;
  readonly authority: MemberContextAuthority;
  readonly evidenceIds: readonly string[];
};

export type MemberContextQueryResult<T> =
  | (QueryEnvelope & { readonly status: "ready"; readonly data: T; readonly nextCursor?: string })
  | (QueryEnvelope & { readonly status: "empty"; readonly message: string })
  | (QueryEnvelope & {
      readonly status: "insufficient-history";
      readonly requiredPoints: number;
      readonly availablePoints: number;
    })
  | (QueryEnvelope & {
      readonly status: "stale";
      readonly requestedRevisionId: string;
      readonly activeRevisionId: string | null;
    })
  | (QueryEnvelope & { readonly status: "denied"; readonly message: string })
  | (QueryEnvelope & {
      readonly status: "invalid";
      readonly code: "invalid-bound" | "invalid-cursor" | "invalid-window" | "invalid-evidence-id";
      readonly message: string;
    })
  | (QueryEnvelope & { readonly status: "unavailable"; readonly message: string });

export type MemberSummaryProjection = {
  readonly profileAssertionId: string;
  readonly goalAssertionIds: readonly string[];
  readonly riskAssessmentAssertionId: string | null;
};

export type MemberEvidenceProjection = {
  readonly evidenceId: string;
  readonly semanticId: string;
  readonly assertionId: string;
  readonly kind: MemberContextRevisionScopedNode["kind"];
  readonly classification: AssertionClassification;
  readonly temporal: AssertionTemporal;
};

export type LongitudinalPointProjection = MemberEvidenceProjection & {
  readonly metric: string;
  readonly value: string | number | boolean | null;
  readonly unit: string;
  readonly sourceOrder: number;
};

export type MessageProjection = MemberEvidenceProjection & {
  readonly senderRole: "member" | "coach";
  readonly text: string;
  readonly attachmentEvidenceIds: readonly string[];
};

export type ConversationProjection = {
  readonly conversationEvidenceId: string;
  readonly messages: readonly MessageProjection[];
};

export type CoachBriefProjection = {
  readonly briefEvidenceId: string;
  readonly taskEvidenceIds: readonly string[];
  readonly assessmentEvidenceId: string | null;
};

export type CitationProjection = {
  readonly evidenceId: string;
  readonly semanticId: string;
  readonly assertionId: string;
  readonly source: AssertionSource;
  readonly classification: AssertionClassification;
  readonly temporal: AssertionTemporal;
};

export type MemberContextReadHandle = {
  readonly memberId: string;
  readonly coachId: string;
  readonly contextRevisionId: string;
  readonly authority: MemberContextAuthority;
  readonly getSummary: (query: SummaryQuery) => Promise<MemberContextQueryResult<MemberSummaryProjection>>;
  readonly getEvidence: (
    query: EvidenceQuery,
  ) => Promise<MemberContextQueryResult<readonly MemberEvidenceProjection[]>>;
  readonly getLongitudinalSeries: (
    query: LongitudinalSeriesQuery,
  ) => Promise<MemberContextQueryResult<readonly LongitudinalPointProjection[]>>;
  readonly getConversation: (
    query: ConversationQuery,
  ) => Promise<MemberContextQueryResult<ConversationProjection>>;
  readonly getCoachBrief: (query: CoachBriefQuery) => Promise<MemberContextQueryResult<CoachBriefProjection>>;
  readonly getRelatedEvidence: (
    query: RelatedEvidenceQuery,
  ) => Promise<MemberContextQueryResult<readonly MemberEvidenceProjection[]>>;
  readonly getCitations: (
    query: CitationLookupQuery,
  ) => Promise<MemberContextQueryResult<readonly CitationProjection[]>>;
};

export type MemberContextReadOpenResult =
  | { readonly status: "ready"; readonly handle: MemberContextReadHandle }
  | { readonly status: "empty"; readonly memberId: string; readonly message: string }
  | { readonly status: "stale"; readonly requestedRevisionId: string; readonly activeRevisionId: string | null }
  | { readonly status: "denied"; readonly message: string }
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "unavailable"; readonly message: string };

export type MemberContextReadProvider = {
  readonly openActive: (scope: AuthorizedMemberContextScope) => Promise<MemberContextReadOpenResult>;
  readonly openRevision: (
    scope: AuthorizedMemberContextScope,
    contextRevisionId: string,
  ) => Promise<MemberContextReadOpenResult>;
};
