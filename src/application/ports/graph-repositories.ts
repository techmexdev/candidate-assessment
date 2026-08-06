import type { MemberContextResult, MemberEvidence, MemberScope } from "../../domain/contracts/member-context";
import type { MemberContextReadProvider } from "../../domain/contracts/member-context-queries";
import type { MovementGraphReadProvider } from "../../domain/contracts/movement-clinical-queries";

/** @deprecated Compatibility port for the aggregate adapter; remove after graph parity. */
export type MemberContextRepository = {
  getSnapshot(scope: MemberScope, contextRevision?: string): MemberContextResult;
  listEvidence(scope: MemberScope, kind?: MemberEvidence["kind"], contextRevision?: string): MemberEvidence[];
};

export type GraphRepositories = {
  movement: MovementGraphReadProvider;
  memberContext: MemberContextReadProvider;
};
