export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type MemberProfile = {
  id: string;
  name: string;
  age: number;
  sex: string;
  height_cm: number;
  weight_kg: number;
  timezone: string;
  member_since: string;
  coach_id: string;
  tier: string;
};

export type MemberGoal = { id: string; text: string; priority: number; target_date: string | null };
export type MemberPreference = {
  preferred_session_minutes: number;
  training_days_per_week: number;
  preferred_days: string[];
  dislikes: string[];
  notes: string;
};
export type MemberInjury = {
  id: string;
  region: string;
  joint: string;
  status: string;
  severity: string;
  since: string;
  notes: string;
  snomedct_hint: string;
};
export type MemberWorkout = {
  date: string;
  title: string;
  planned: boolean;
  completed: boolean;
  duration_min: number;
  rpe: number | null;
  exercises: string[];
};
export type MemberChatAttachment = { type: "image"; caption: string };
export type MemberChatMessage = {
  ts: string;
  from: "member" | "coach";
  text: string;
  attachments?: MemberChatAttachment[];
};
export type MemberContextDocument = {
  _note: string;
  profile: MemberProfile;
  goals: MemberGoal[];
  preferences: MemberPreference;
  equipment_available: string[];
  injuries: MemberInjury[];
  workout_history: MemberWorkout[];
  adherence: { weekly_completion_pct: { week_of: string; pct: number }[]; trend: string };
  biomarkers: {
    resting_hr_bpm: number;
    hrv_ms: number;
    sleep_hours_last_7_days: number[];
    weight_trend_kg: { date: string; kg: number }[];
  };
  labs: Record<string, Record<string, string | number>>;
  chat_history: MemberChatMessage[];
  coach_brief: {
    generated_for: string;
    morning_tasks: { type: string; text: string }[];
    churn_risk: { level: string; reasons: string[] };
  };
};

export type MemberContextDocumentInput = Omit<MemberContextDocument, "chat_history"> & {
  chat_history: {
    ts: string;
    from: string;
    text: string;
    attachments?: { type: string; caption: string }[];
  }[];
};

export type EvidenceKind =
  | "profile"
  | "goal"
  | "preference"
  | "equipment"
  | "injury"
  | "workout"
  | "adherence"
  | "biomarker"
  | "lab"
  | "message"
  | "image"
  | "coach-task"
  | "churn-signal";

export type MemberEvidence = {
  evidenceId: string;
  memberId: string;
  kind: EvidenceKind;
  occurredAt: string;
  recordedAt: string;
  sourcePath: string;
  sourceRevision: string;
  synthetic: true;
  value: JsonValue;
};

export type MemberContextSnapshot = {
  memberId: string;
  coachId: string;
  datasetRevision: string;
  contextRevision: string;
  asOf: string;
  timezone: string;
  synthetic: true;
  profile: MemberProfile;
  goals: MemberGoal[];
  preferences: MemberPreference;
  equipmentAvailable: string[];
  injuries: MemberInjury[];
  workoutHistory: MemberWorkout[];
  adherence: MemberContextDocument["adherence"];
  biomarkers: MemberContextDocument["biomarkers"];
  labs: MemberContextDocument["labs"];
  chatHistory: MemberChatMessage[];
  coachBrief: MemberContextDocument["coach_brief"];
  evidence: MemberEvidence[];
};

export type MemberScope = { coachId: string; memberId: string };
export type MemberContextResult =
  | { status: "ready"; data: MemberContextSnapshot }
  | { status: "empty"; message: string }
  | { status: "denied"; message: string }
  | { status: "unavailable"; message: string };

/*
 * The aggregate types above are compatibility exports for the pre-graph
 * adapter. New code should use the revisioned graph contracts below.
 */

export const MEMBER_CONTEXT_NODE_KINDS = [
  "member",
  "coach",
  "member-profile",
  "goal",
  "preference",
  "equipment-availability",
  "injury-episode",
  "workout-session",
  "exercise-mention",
  "observation",
  "lab-panel",
  "conversation",
  "message",
  "media-attachment",
  "coach-brief",
  "coach-task",
  "churn-assessment",
  "churn-reason",
  "source-artifact",
  "member-context-revision",
  "ingestion-activity",
  "publication-attempt",
  "revision-seal",
  "member-context-catalog",
  "activation-event",
] as const;

export type MemberContextNodeKind = (typeof MEMBER_CONTEXT_NODE_KINDS)[number];

export const MEMBER_CONTEXT_RELATIONSHIP_KINDS = [
  "COACHES",
  "HAS_PROFILE",
  "PURSUES",
  "HAS_PREFERENCE",
  "HAS_EQUIPMENT",
  "HAS_INJURY",
  "HAS_WORKOUT",
  "MENTIONS_EXERCISE",
  "HAS_OBSERVATION",
  "HAS_PANEL",
  "CONTAINS_MEASUREMENT",
  "HAS_CONVERSATION",
  "CONTAINS_MESSAGE",
  "SENT_BY",
  "HAS_ATTACHMENT",
  "HAS_BRIEF",
  "HAS_TASK",
  "HAS_ASSESSMENT",
  "HAS_REASON",
  "SUPPORTED_BY",
  "WAS_DERIVED_FROM",
  "ASSERTS",
  "USED",
  "GENERATED",
  "SEALED",
  "ACTIVATED",
] as const;

export type MemberContextRelationshipKind = (typeof MEMBER_CONTEXT_RELATIONSHIP_KINDS)[number];

export type MemberContextAuthority = "canonical" | "fixture";

export type AssertionSource = {
  readonly locator: string;
  readonly artifactDigest: string;
};

export type AssertionClassification =
  | "identity"
  | "source-statement"
  | "observation"
  | "source-provided-assessment"
  | "system-derived-assessment"
  | "graph-lineage"
  | "publication-state";

export type AssertionTemporal =
  | { readonly precision: "exact-timestamp"; readonly effectiveAt: string }
  | { readonly precision: "date"; readonly effectiveOn: string }
  | { readonly precision: "relative-order"; readonly sourceOrder: number }
  | { readonly precision: "unknown" };

export type MovementClinicalStableConceptId =
  `${
    | "exercise"
    | "muscle"
    | "joint"
    | "body-region"
    | "movement-pattern"
    | "movement-demand"
    | "equipment"
    | "condition"
    | "clinical-rule"
    | "ontology-concept"}:${string}`;

export type CopperStableConceptId = `copper:${string}`;

export type DomainConceptReference =
  | {
      readonly state: "reviewed";
      readonly graph: "movement-clinical";
      readonly stableConceptId: MovementClinicalStableConceptId;
      readonly reviewedBy: string;
      readonly reviewedAt: string;
      readonly sourceArtifactDigest: string;
    }
  | {
      readonly state: "reviewed";
      readonly graph: "copper";
      readonly stableConceptId: CopperStableConceptId;
      readonly reviewedBy: string;
      readonly reviewedAt: string;
      readonly sourceArtifactDigest: string;
    }
  | {
      readonly state: "unresolved";
      readonly originalText: string;
      readonly reason: "no-deterministic-match" | "not-reviewed" | "not-applicable";
    };

type StableIdentityNode<K extends "member" | "coach"> = {
  readonly kind: K;
  readonly semanticId: string;
  readonly sourceId: string;
  readonly synthetic: boolean;
};

export type MemberNode = StableIdentityNode<"member">;
export type CoachNode = StableIdentityNode<"coach">;

type RevisionScopedNode<K extends MemberContextNodeKind> = {
  readonly kind: K;
  readonly semanticId: string;
  readonly assertionId: string;
  readonly memberId: string;
  readonly contextRevisionId: string;
  readonly source: AssertionSource;
  readonly classification: AssertionClassification;
  readonly temporal: AssertionTemporal;
  readonly synthetic: boolean;
};

export type MemberProfileNodeAssertion = RevisionScopedNode<"member-profile"> & {
  readonly name: string;
  readonly age: number;
  readonly sex: string;
  readonly heightCm: number;
  readonly weightKg: number;
  readonly timezone: string;
  readonly memberSince: string;
  readonly tier: string;
};

export type GoalNodeAssertion = RevisionScopedNode<"goal"> & {
  readonly text: string;
  readonly priority: number;
  readonly targetDate: string | null;
  readonly domainReference: DomainConceptReference;
};

export type PreferenceNodeAssertion = RevisionScopedNode<"preference"> & {
  readonly preferredSessionMinutes: number;
  readonly trainingDaysPerWeek: number;
  readonly preferredDays: readonly string[];
  readonly dislikes: readonly string[];
  readonly notes: string;
  readonly domainReferences: readonly DomainConceptReference[];
};

export type EquipmentAvailabilityNodeAssertion = RevisionScopedNode<"equipment-availability"> & {
  readonly originalLabel: string;
  readonly available: boolean;
  readonly domainReference: DomainConceptReference;
};

export type InjuryEpisodeNodeAssertion = RevisionScopedNode<"injury-episode"> & {
  readonly region: string;
  readonly joint: string;
  readonly status: string;
  readonly severity: string;
  readonly since: string;
  readonly notes: string;
  readonly domainReferences: readonly DomainConceptReference[];
};

export type WorkoutSessionNodeAssertion = RevisionScopedNode<"workout-session"> & {
  readonly title: string;
  readonly planned: boolean;
  readonly completed: boolean;
  readonly durationMinutes: number;
  readonly rpe: number | null;
};

export type ExerciseMentionNodeAssertion = RevisionScopedNode<"exercise-mention"> & {
  readonly originalText: string;
  readonly sourceOrder: number;
  readonly domainReference: DomainConceptReference;
};

export type ObservationNodeAssertion = RevisionScopedNode<"observation"> & {
  readonly metric: string;
  readonly value: string | number | boolean | null;
  readonly unit: string;
  readonly sourceOrder: number;
};

export type LabPanelNodeAssertion = RevisionScopedNode<"lab-panel"> & {
  readonly panelType: "blood" | "dexa" | "other";
  readonly label: string;
  readonly sourceOrder: number;
};

export type ConversationNodeAssertion = RevisionScopedNode<"conversation"> & {
  readonly participantSemanticIds: readonly string[];
};

export type MessageNodeAssertion = RevisionScopedNode<"message"> & {
  readonly senderRole: "member" | "coach";
  readonly text: string;
  readonly sourceOrder: number;
};

export type MediaAttachmentNodeAssertion = RevisionScopedNode<"media-attachment"> & {
  readonly mediaType: string;
  readonly caption: string;
  readonly sourceOrder: number;
  readonly assetStatus: "metadata-only";
  readonly analysisStatus: "not-analyzed";
};

export type CoachBriefNodeAssertion = RevisionScopedNode<"coach-brief"> & {
  readonly generatedFor: string;
};

export type CoachTaskNodeAssertion = RevisionScopedNode<"coach-task"> & {
  readonly taskType: string;
  readonly text: string;
  readonly sourceOrder: number;
};

export type ChurnAssessmentNodeAssertion = RevisionScopedNode<"churn-assessment"> & {
  readonly level: string;
  readonly methodRevision?: string;
};

export type ChurnReasonNodeAssertion = RevisionScopedNode<"churn-reason"> & {
  readonly text: string;
  readonly sourceOrder: number;
  readonly basisStatus: "supported" | "unsupported-source";
};

export const MEMBER_CONTEXT_REVISION_SCOPED_NODE_KINDS = [
  "member-profile",
  "goal",
  "preference",
  "equipment-availability",
  "injury-episode",
  "workout-session",
  "exercise-mention",
  "observation",
  "lab-panel",
  "conversation",
  "message",
  "media-attachment",
  "coach-brief",
  "coach-task",
  "churn-assessment",
  "churn-reason",
] as const;

export type MemberContextRevisionScopedNode =
  | MemberProfileNodeAssertion
  | GoalNodeAssertion
  | PreferenceNodeAssertion
  | EquipmentAvailabilityNodeAssertion
  | InjuryEpisodeNodeAssertion
  | WorkoutSessionNodeAssertion
  | ExerciseMentionNodeAssertion
  | ObservationNodeAssertion
  | LabPanelNodeAssertion
  | ConversationNodeAssertion
  | MessageNodeAssertion
  | MediaAttachmentNodeAssertion
  | CoachBriefNodeAssertion
  | CoachTaskNodeAssertion
  | ChurnAssessmentNodeAssertion
  | ChurnReasonNodeAssertion;

export type SourceArtifactNode = {
  readonly kind: "source-artifact";
  readonly semanticId: string;
  readonly artifactDigest: string;
  readonly sourceLocator: string;
  readonly mediaType: string;
  readonly synthetic: boolean;
};

export type MemberContextRevisionNode = {
  readonly kind: "member-context-revision";
  readonly semanticId: string;
  readonly memberId: string;
  readonly sourceArtifactDigest: string;
  readonly schemaVersion: string;
  readonly compilerVersion: string;
  readonly validationResult: "valid" | "invalid";
  readonly wasRevisionOf?: string;
  readonly synthetic: boolean;
};

export type IngestionActivityNode = {
  readonly kind: "ingestion-activity";
  readonly semanticId: string;
  readonly softwareVersion: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: "succeeded" | "failed";
  readonly synthetic: boolean;
};

export type PublicationAttemptNode = {
  readonly kind: "publication-attempt";
  readonly semanticId: string;
  readonly memberId: string;
  readonly contextRevisionId: string;
  readonly state: "staged" | "validated" | "rejected" | "abandoned";
  readonly attemptedAt: string;
};

export type RevisionSealNode = {
  readonly kind: "revision-seal";
  readonly semanticId: string;
  readonly memberId: string;
  readonly contextRevisionId: string;
  readonly canonicalDigest: string;
  readonly sealedAt: string;
};

export type MemberContextCatalogNode = {
  readonly kind: "member-context-catalog";
  readonly semanticId: string;
  readonly memberId: string;
  readonly activeRevisionId: string | null;
};

export type ActivationEventNode = {
  readonly kind: "activation-event";
  readonly semanticId: string;
  readonly memberId: string;
  readonly contextRevisionId: string;
  readonly priorRevisionId: string | null;
  readonly actorId: string;
  readonly activatedAt: string;
};

export type MemberContextGraphNode =
  | MemberNode
  | CoachNode
  | MemberContextRevisionScopedNode
  | SourceArtifactNode
  | MemberContextRevisionNode
  | IngestionActivityNode
  | PublicationAttemptNode
  | RevisionSealNode
  | MemberContextCatalogNode
  | ActivationEventNode;

type RelationshipAssertion<
  K extends MemberContextRelationshipKind,
  From extends MemberContextNodeKind,
  To extends MemberContextNodeKind,
> = {
  readonly kind: K;
  readonly semanticId: string;
  readonly assertionId: string;
  readonly memberId: string;
  readonly contextRevisionId: string;
  readonly fromSemanticId: string;
  readonly fromKind: From;
  readonly toSemanticId: string;
  readonly toKind: To;
  readonly source: AssertionSource;
  readonly classification: AssertionClassification;
  readonly temporal: AssertionTemporal;
  readonly synthetic: boolean;
};

type RevisionScopedKind = MemberContextRevisionScopedNode["kind"];
type DerivationSourceKind = "churn-assessment" | "churn-reason";

export type MemberContextGraphRelationship =
  | RelationshipAssertion<"COACHES", "coach", "member">
  | RelationshipAssertion<"HAS_PROFILE", "member", "member-profile">
  | RelationshipAssertion<"PURSUES", "member", "goal">
  | RelationshipAssertion<"HAS_PREFERENCE", "member", "preference">
  | RelationshipAssertion<"HAS_EQUIPMENT", "member", "equipment-availability">
  | RelationshipAssertion<"HAS_INJURY", "member", "injury-episode">
  | RelationshipAssertion<"HAS_WORKOUT", "member", "workout-session">
  | RelationshipAssertion<"MENTIONS_EXERCISE", "workout-session", "exercise-mention">
  | RelationshipAssertion<"HAS_OBSERVATION", "member", "observation">
  | RelationshipAssertion<"HAS_PANEL", "member", "lab-panel">
  | RelationshipAssertion<"CONTAINS_MEASUREMENT", "lab-panel", "observation">
  | RelationshipAssertion<"HAS_CONVERSATION", "member", "conversation">
  | RelationshipAssertion<"CONTAINS_MESSAGE", "conversation", "message">
  | RelationshipAssertion<"SENT_BY", "message", "member" | "coach">
  | RelationshipAssertion<"HAS_ATTACHMENT", "message", "media-attachment">
  | RelationshipAssertion<"HAS_BRIEF", "member", "coach-brief">
  | RelationshipAssertion<"HAS_TASK", "coach-brief", "coach-task">
  | RelationshipAssertion<"HAS_ASSESSMENT", "coach-brief", "churn-assessment">
  | RelationshipAssertion<"HAS_REASON", "churn-assessment", "churn-reason">
  | RelationshipAssertion<"SUPPORTED_BY", DerivationSourceKind, RevisionScopedKind>
  | RelationshipAssertion<"WAS_DERIVED_FROM", DerivationSourceKind, RevisionScopedKind>
  | RelationshipAssertion<"ASSERTS", "member-context-revision", RevisionScopedKind>
  | RelationshipAssertion<"USED", "ingestion-activity", "source-artifact">
  | RelationshipAssertion<"GENERATED", "ingestion-activity", "member-context-revision">
  | RelationshipAssertion<"SEALED", "revision-seal", "member-context-revision">
  | RelationshipAssertion<"ACTIVATED", "activation-event", "member-context-revision">;

export type MemberContextGraphSnapshot = {
  readonly memberId: string;
  readonly contextRevisionId: string;
  readonly sourceArtifactDigest: string;
  readonly nodes: readonly MemberContextGraphNode[];
  readonly relationships: readonly MemberContextGraphRelationship[];
};
