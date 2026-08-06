import type { MemberContextResult, MemberEvidence, MemberScope } from "../../domain/contracts/member-context";
import type { MovementGraphReadProvider } from "../../domain/contracts/movement-clinical-queries";

export type MemberContextRepository = {
  getSnapshot(scope: MemberScope, contextRevision?: string): MemberContextResult;
  listEvidence(scope: MemberScope, kind?: MemberEvidence["kind"], contextRevision?: string): MemberEvidence[];
};

export type GraphRepositories = {
  movement: MovementGraphReadProvider;
  memberContext: MemberContextRepository;
};
