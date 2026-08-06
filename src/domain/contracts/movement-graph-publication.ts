import type { MovementGraphSnapshot } from "./movement-graph";

export type PublicationFailure =
  | { readonly code: "immutable_payload_conflict"; readonly graphRevisionId: string }
  | { readonly code: "validation_failed"; readonly graphRevisionId: string; readonly errors: readonly string[] }
  | { readonly code: "clinical_review_required"; readonly graphRevisionId: string }
  | { readonly code: "not_sealed"; readonly graphRevisionId: string }
  | { readonly code: "stale_revision"; readonly expectedPriorRevisionId: string | null; readonly actualRevisionId: string | null }
  | { readonly code: "publication_unavailable"; readonly message: string };

export type PublicationResult<T> =
  | { readonly status: "ok"; readonly data: T }
  | { readonly status: "failed"; readonly failure: PublicationFailure };

export type StageRevisionRequest = {
  readonly snapshot: MovementGraphSnapshot;
  readonly canonicalDigest: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
};

export type StagedRevision = {
  readonly publicationAttemptId: string;
  readonly graphRevisionId: string;
  readonly state: "staged" | "already_staged";
};

export type ValidateRevisionRequest = {
  readonly publicationAttemptId: string;
  readonly clinicalReviewApprovalId?: string;
};

export type ValidatedRevision = {
  readonly publicationAttemptId: string;
  readonly graphRevisionId: string;
  readonly sealId: string;
  readonly canonicalDigest: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
};

export type ActivateRevisionRequest = {
  readonly graphRevisionId: string;
  readonly expectedPriorRevisionId: string | null;
  readonly actorId: string;
};

export type ActivatedRevision = {
  readonly graphRevisionId: string;
  readonly priorRevisionId: string | null;
  readonly activationEventId: string;
  readonly state: "activated" | "already_active";
};

export type PublicationInspection = {
  readonly activeRevisionId: string | null;
  readonly revisionId?: string;
  readonly publicationAttemptId?: string;
  readonly state: "active" | "sealed" | "staged" | "rejected" | "abandoned" | "missing";
  readonly validationErrors: readonly string[];
};

export type MovementGraphPublisher = {
  readonly stage: (request: StageRevisionRequest) => Promise<PublicationResult<StagedRevision>>;
  readonly validate: (request: ValidateRevisionRequest) => Promise<PublicationResult<ValidatedRevision>>;
  readonly activate: (request: ActivateRevisionRequest) => Promise<PublicationResult<ActivatedRevision>>;
  readonly inspect: (revisionId?: string) => Promise<PublicationResult<PublicationInspection>>;
};
