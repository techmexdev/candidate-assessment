import type { MemberContextGraphSnapshot } from "./member-context";

export type MemberContextPublicationFailure =
  | { readonly code: "immutable_payload_conflict"; readonly memberId: string; readonly contextRevisionId: string }
  | {
      readonly code: "validation_failed";
      readonly memberId: string;
      readonly contextRevisionId: string;
      readonly errors: readonly string[];
    }
  | { readonly code: "not_sealed"; readonly memberId: string; readonly contextRevisionId: string }
  | {
      readonly code: "stale_revision";
      readonly memberId: string;
      readonly expectedPriorRevisionId: string | null;
      readonly actualRevisionId: string | null;
    }
  | { readonly code: "publication_unavailable"; readonly message: string };

export type MemberContextPublicationResult<T> =
  | { readonly status: "ok"; readonly data: T }
  | { readonly status: "failed"; readonly failure: MemberContextPublicationFailure };

export type StageMemberContextRevisionRequest = {
  readonly snapshot: MemberContextGraphSnapshot;
  readonly canonicalDigest: string;
  readonly nodeCount: number;
  readonly relationshipCount: number;
};

export type StagedMemberContextRevision = {
  readonly publicationAttemptId: string;
  readonly memberId: string;
  readonly contextRevisionId: string;
  readonly state: "staged" | "already-staged";
};

export type ValidateMemberContextRevisionRequest = {
  readonly publicationAttemptId: string;
};

export type ValidatedMemberContextRevision = {
  readonly publicationAttemptId: string;
  readonly memberId: string;
  readonly contextRevisionId: string;
  readonly sealId: string;
  readonly canonicalDigest: string;
  readonly nodeCount: number;
  readonly relationshipCount: number;
};

export type ActivateMemberContextRevisionRequest = {
  readonly memberId: string;
  readonly contextRevisionId: string;
  readonly expectedPriorRevisionId: string | null;
  readonly actorId: string;
};

export type ActivatedMemberContextRevision = {
  readonly memberId: string;
  readonly contextRevisionId: string;
  readonly priorRevisionId: string | null;
  readonly activationEventId: string;
  readonly state: "activated" | "already-active";
};

export type MemberContextPublicationInspection = {
  readonly memberId: string;
  readonly activeRevisionId: string | null;
  readonly contextRevisionId?: string;
  readonly publicationAttemptId?: string;
  readonly state: "active" | "sealed" | "staged" | "rejected" | "abandoned" | "missing";
  readonly validationErrors: readonly string[];
};

export type MemberContextPublisher = {
  readonly stage: (
    request: StageMemberContextRevisionRequest,
  ) => Promise<MemberContextPublicationResult<StagedMemberContextRevision>>;
  readonly validate: (
    request: ValidateMemberContextRevisionRequest,
  ) => Promise<MemberContextPublicationResult<ValidatedMemberContextRevision>>;
  readonly activate: (
    request: ActivateMemberContextRevisionRequest,
  ) => Promise<MemberContextPublicationResult<ActivatedMemberContextRevision>>;
  readonly inspect: (
    memberId: string,
    contextRevisionId?: string,
  ) => Promise<MemberContextPublicationResult<MemberContextPublicationInspection>>;
};
