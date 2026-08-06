import type {
  ActivateMemberContextRevisionRequest,
  ActivatedMemberContextRevision,
  MemberContextPublicationInspection,
  MemberContextPublicationResult,
  MemberContextPublisher,
  StageMemberContextRevisionRequest,
  StagedMemberContextRevision,
  ValidateMemberContextRevisionRequest,
  ValidatedMemberContextRevision,
} from "../../domain/contracts/member-context-publication";
import type { MemberContextGraphSnapshot } from "../../domain/contracts/member-context";
import { canonicalMemberContextDigest, deepFreeze, sha256 } from "../revisions/member-context";
import { validateMemberContextGraph } from "../validation/member-context";

type AttemptState = "staged" | "validated" | "rejected" | "abandoned";

type StoredRevision = {
  readonly snapshot: MemberContextGraphSnapshot;
  readonly canonicalDigest: string;
  readonly nodeCount: number;
  readonly relationshipCount: number;
  readonly publicationAttemptId: string;
  state: AttemptState;
  sealId?: string;
  validationErrors: readonly string[];
};

export class InMemoryMemberContextPublisher implements MemberContextPublisher {
  private readonly revisions = new Map<string, Map<string, StoredRevision>>();
  private readonly attempts = new Map<string, StoredRevision>();
  private readonly activeRevisions = new Map<string, string>();

  async stage(
    request: StageMemberContextRevisionRequest,
  ): Promise<MemberContextPublicationResult<StagedMemberContextRevision>> {
    const { snapshot } = request;
    const byRevision = this.revisions.get(snapshot.memberId) ?? new Map<string, StoredRevision>();
    const existing = byRevision.get(snapshot.contextRevisionId);
    const actualDigest = canonicalMemberContextDigest(snapshot);
    if (existing) {
      if (existing.canonicalDigest !== actualDigest) {
        return { status: "failed", failure: { code: "immutable_payload_conflict", memberId: snapshot.memberId, contextRevisionId: snapshot.contextRevisionId } };
      }
      return {
        status: "ok",
        data: {
          publicationAttemptId: existing.publicationAttemptId,
          memberId: snapshot.memberId,
          contextRevisionId: snapshot.contextRevisionId,
          state: "already-staged",
        },
      };
    }
    const requestErrors: string[] = [];
    if (request.canonicalDigest !== actualDigest) requestErrors.push("canonical digest does not match snapshot");
    if (request.nodeCount !== snapshot.nodes.length) requestErrors.push("node count does not match snapshot");
    if (request.relationshipCount !== snapshot.relationships.length) requestErrors.push("relationship count does not match snapshot");
    if (requestErrors.length > 0) {
      return { status: "failed", failure: { code: "validation_failed", memberId: snapshot.memberId, contextRevisionId: snapshot.contextRevisionId, errors: requestErrors } };
    }
    const publicationAttemptId = `publication-attempt:${sha256(`${snapshot.memberId}:${snapshot.contextRevisionId}:${actualDigest}`)}`;
    const stored: StoredRevision = {
      snapshot: deepFreeze(snapshot),
      canonicalDigest: actualDigest,
      nodeCount: snapshot.nodes.length,
      relationshipCount: snapshot.relationships.length,
      publicationAttemptId,
      state: "staged",
      validationErrors: [],
    };
    byRevision.set(snapshot.contextRevisionId, stored);
    this.revisions.set(snapshot.memberId, byRevision);
    this.attempts.set(publicationAttemptId, stored);
    return { status: "ok", data: { publicationAttemptId, memberId: snapshot.memberId, contextRevisionId: snapshot.contextRevisionId, state: "staged" } };
  }

  async validate(
    request: ValidateMemberContextRevisionRequest,
  ): Promise<MemberContextPublicationResult<ValidatedMemberContextRevision>> {
    const stored = this.attempts.get(request.publicationAttemptId);
    if (!stored) return { status: "failed", failure: { code: "publication_unavailable", message: "Publication attempt is unavailable." } };
    const { snapshot } = stored;
    if (stored.state === "rejected") {
      return { status: "failed", failure: { code: "validation_failed", memberId: snapshot.memberId, contextRevisionId: snapshot.contextRevisionId, errors: stored.validationErrors } };
    }
    if (stored.state === "validated" && stored.sealId) {
      return {
        status: "ok",
        data: {
          publicationAttemptId: stored.publicationAttemptId,
          memberId: snapshot.memberId,
          contextRevisionId: snapshot.contextRevisionId,
          sealId: stored.sealId,
          canonicalDigest: stored.canonicalDigest,
          nodeCount: stored.nodeCount,
          relationshipCount: stored.relationshipCount,
        },
      };
    }
    const validation = validateMemberContextGraph(snapshot);
    if (!validation.valid) {
      stored.state = "rejected";
      stored.validationErrors = [...validation.errors];
      return { status: "failed", failure: { code: "validation_failed", memberId: snapshot.memberId, contextRevisionId: snapshot.contextRevisionId, errors: validation.errors } };
    }
    stored.state = "validated";
    stored.sealId ??= `revision-seal:${sha256(`${snapshot.contextRevisionId}:${stored.canonicalDigest}`)}`;
    return {
      status: "ok",
      data: {
        publicationAttemptId: stored.publicationAttemptId,
        memberId: snapshot.memberId,
        contextRevisionId: snapshot.contextRevisionId,
        sealId: stored.sealId,
        canonicalDigest: stored.canonicalDigest,
        nodeCount: stored.nodeCount,
        relationshipCount: stored.relationshipCount,
      },
    };
  }

  async activate(
    request: ActivateMemberContextRevisionRequest,
  ): Promise<MemberContextPublicationResult<ActivatedMemberContextRevision>> {
    const stored = this.revisions.get(request.memberId)?.get(request.contextRevisionId);
    if (!stored || stored.state !== "validated" || !stored.sealId) {
      return { status: "failed", failure: { code: "not_sealed", memberId: request.memberId, contextRevisionId: request.contextRevisionId } };
    }
    const activeRevisionId = this.activeRevisions.get(request.memberId) ?? null;
    if (activeRevisionId === request.contextRevisionId) {
      return {
        status: "ok",
        data: {
          memberId: request.memberId,
          contextRevisionId: request.contextRevisionId,
          priorRevisionId: activeRevisionId,
          activationEventId: `activation-event:${sha256(`${request.memberId}:${request.contextRevisionId}:already-active`)}`,
          state: "already-active",
        },
      };
    }
    if (activeRevisionId !== request.expectedPriorRevisionId) {
      return {
        status: "failed",
        failure: {
          code: "stale_revision",
          memberId: request.memberId,
          expectedPriorRevisionId: request.expectedPriorRevisionId,
          actualRevisionId: activeRevisionId,
        },
      };
    }
    this.activeRevisions.set(request.memberId, request.contextRevisionId);
    return {
      status: "ok",
      data: {
        memberId: request.memberId,
        contextRevisionId: request.contextRevisionId,
        priorRevisionId: activeRevisionId,
        activationEventId: `activation-event:${sha256(`${request.memberId}:${request.contextRevisionId}:${activeRevisionId ?? "none"}:${request.actorId}`)}`,
        state: "activated",
      },
    };
  }

  async inspect(
    memberId: string,
    contextRevisionId?: string,
  ): Promise<MemberContextPublicationResult<MemberContextPublicationInspection>> {
    const activeRevisionId = this.activeRevisions.get(memberId) ?? null;
    if (!contextRevisionId) {
      return {
        status: "ok",
        data: {
          memberId,
          activeRevisionId,
          ...(activeRevisionId ? { contextRevisionId: activeRevisionId } : {}),
          state: activeRevisionId ? "active" : "missing",
          validationErrors: [],
        },
      };
    }
    const stored = this.revisions.get(memberId)?.get(contextRevisionId);
    if (!stored) return { status: "ok", data: { memberId, activeRevisionId, contextRevisionId, state: "missing", validationErrors: [] } };
    return {
      status: "ok",
      data: {
        memberId,
        activeRevisionId,
        contextRevisionId,
        publicationAttemptId: stored.publicationAttemptId,
        state: activeRevisionId === contextRevisionId ? "active" : stored.state === "validated" ? "sealed" : stored.state,
        validationErrors: stored.validationErrors,
      },
    };
  }

  getRevision(memberId: string, contextRevisionId: string): MemberContextGraphSnapshot | undefined {
    return this.revisions.get(memberId)?.get(contextRevisionId)?.snapshot;
  }

  getActiveRevisionId(memberId: string): string | null {
    return this.activeRevisions.get(memberId) ?? null;
  }

  listRevisionIds(memberId: string): readonly string[] {
    return [...(this.revisions.get(memberId)?.keys() ?? [])].sort();
  }
}
