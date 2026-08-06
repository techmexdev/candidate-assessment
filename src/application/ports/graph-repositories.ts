import type { MemberContextReadProvider } from "../../domain/contracts/member-context-queries";
import type { MovementGraphReadProvider } from "../../domain/contracts/movement-clinical-queries";

export type MemberContextAccessClaims = {
  readonly coachId: string;
  readonly memberId: string;
  readonly authorizationId: string;
};

export type MemberContextAccessAuthorizer = (
  claims: Readonly<MemberContextAccessClaims>,
) => boolean | Promise<boolean>;

export type GraphRepositories = {
  movement: MovementGraphReadProvider;
  memberContext: MemberContextReadProvider;
};

/** Server composition dependencies for the member-context read boundary. */
export type MemberContextReadBoundary = {
  readonly memberContext: MemberContextReadProvider;
  readonly authorizeMemberContext: MemberContextAccessAuthorizer;
};
