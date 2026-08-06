import {
  MEMBER_CONTEXT_REVISION_SCOPED_NODE_KINDS,
  type MemberContextNodeKind,
  type MemberContextRelationshipKind,
} from "../../domain/contracts/member-context";

export type MemberContextRelationshipEndpoint = {
  readonly from: readonly MemberContextNodeKind[];
  readonly to: readonly MemberContextNodeKind[];
};

export const MEMBER_CONTEXT_RELATIONSHIP_ENDPOINTS = {
  COACHES: { from: ["coach"], to: ["member"] },
  HAS_PROFILE: { from: ["member"], to: ["member-profile"] },
  PURSUES: { from: ["member"], to: ["goal"] },
  HAS_PREFERENCE: { from: ["member"], to: ["preference"] },
  HAS_EQUIPMENT: { from: ["member"], to: ["equipment-availability"] },
  HAS_INJURY: { from: ["member"], to: ["injury-episode"] },
  HAS_WORKOUT: { from: ["member"], to: ["workout-session"] },
  MENTIONS_EXERCISE: { from: ["workout-session"], to: ["exercise-mention"] },
  HAS_OBSERVATION: { from: ["member"], to: ["observation"] },
  HAS_PANEL: { from: ["member"], to: ["lab-panel"] },
  CONTAINS_MEASUREMENT: { from: ["lab-panel"], to: ["observation"] },
  HAS_CONVERSATION: { from: ["member"], to: ["conversation"] },
  CONTAINS_MESSAGE: { from: ["conversation"], to: ["message"] },
  SENT_BY: { from: ["message"], to: ["member", "coach"] },
  HAS_ATTACHMENT: { from: ["message"], to: ["media-attachment"] },
  HAS_BRIEF: { from: ["member"], to: ["coach-brief"] },
  HAS_TASK: { from: ["coach-brief"], to: ["coach-task"] },
  HAS_ASSESSMENT: { from: ["coach-brief"], to: ["churn-assessment"] },
  HAS_REASON: { from: ["churn-assessment"], to: ["churn-reason"] },
  SUPPORTED_BY: { from: ["churn-assessment", "churn-reason"], to: MEMBER_CONTEXT_REVISION_SCOPED_NODE_KINDS },
  WAS_DERIVED_FROM: {
    from: ["churn-assessment", "churn-reason"],
    to: MEMBER_CONTEXT_REVISION_SCOPED_NODE_KINDS,
  },
  ASSERTS: { from: ["member-context-revision"], to: MEMBER_CONTEXT_REVISION_SCOPED_NODE_KINDS },
  USED: { from: ["ingestion-activity"], to: ["source-artifact"] },
  GENERATED: { from: ["ingestion-activity"], to: ["member-context-revision"] },
  SEALED: { from: ["revision-seal"], to: ["member-context-revision"] },
  ACTIVATED: { from: ["activation-event"], to: ["member-context-revision"] },
} as const satisfies Record<MemberContextRelationshipKind, MemberContextRelationshipEndpoint>;
