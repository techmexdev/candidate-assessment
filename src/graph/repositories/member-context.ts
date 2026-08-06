import type {
  EvidenceKind,
  MemberContextResult,
  MemberContextSnapshot,
  MemberEvidence,
  MemberScope,
} from "../../domain/contracts/member-context";

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
