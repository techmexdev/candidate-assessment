import type { MemberContextResult, MemberEvidence, MemberScope } from "../../domain/contracts/member-context";
import type { MovementGraphRepository } from "../../domain/contracts/movement-graph";

export type MemberContextRepository = {
  getSnapshot(scope: MemberScope, contextRevision?: string): MemberContextResult;
  listEvidence(scope: MemberScope, kind?: MemberEvidence["kind"], contextRevision?: string): MemberEvidence[];
};

export type GraphRepositories = {
  movement: MovementGraphRepository;
  memberContext: MemberContextRepository;
};
