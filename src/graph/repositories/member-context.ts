import type {
  EvidenceKind,
  MemberContextGraphSnapshot,
  MemberContextResult,
  MemberContextSnapshot,
  MemberEvidence,
  MemberScope,
} from "../../domain/contracts/member-context";
import type { InMemoryMemberContextPublisher } from "../publication/in-memory-member-context-publisher";

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

export class InMemoryMemberContextRepository {
  private readonly snapshots = new Map<string, Map<string, MemberContextSnapshot>>();

  constructor(initialSnapshots: MemberContextSnapshot[] = []) {
    for (const snapshot of initialSnapshots) this.addSnapshot(snapshot);
  }

  addSnapshot(snapshot: MemberContextSnapshot): MemberContextResult {
    const byRevision = this.snapshots.get(snapshot.memberId) ?? new Map<string, MemberContextSnapshot>();
    byRevision.set(snapshot.contextRevision, snapshot);
    this.snapshots.set(snapshot.memberId, byRevision);
    return { status: "ready", data: snapshot };
  }

  getSnapshot(scope: MemberScope, contextRevision?: string): MemberContextResult {
    const byRevision = this.snapshots.get(scope.memberId);
    if (!byRevision) return { status: "empty", message: `No member context for ${scope.memberId}.` };
    const anySnapshot = byRevision.values().next().value as MemberContextSnapshot | undefined;
    if (anySnapshot?.coachId !== scope.coachId) return { status: "denied", message: "Coach is not authorized for this member." };
    const snapshot = contextRevision ? byRevision.get(contextRevision) : [...byRevision.values()].at(-1);
    if (!snapshot) return { status: "empty", message: `Context revision ${contextRevision} is unavailable.` };
    return { status: "ready", data: snapshot };
  }

  listEvidence(scope: MemberScope, kind?: EvidenceKind, contextRevision?: string): MemberEvidence[] {
    const result = this.getSnapshot(scope, contextRevision);
    if (result.status !== "ready") return [];
    return result.data.evidence.filter((item) => !kind || item.kind === kind);
  }
}
