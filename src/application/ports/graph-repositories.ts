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

export async function authorizeMemberContextSafely(
  authorize: MemberContextAccessAuthorizer,
  claims: Readonly<MemberContextAccessClaims>,
): Promise<boolean> {
  try {
    return await authorize(claims);
  } catch {
    return false;
  }
}

export function sameMemberContextClaims(
  left: Readonly<MemberContextAccessClaims>,
  right: Readonly<MemberContextAccessClaims>,
) {
  return left.coachId === right.coachId
    && left.memberId === right.memberId
    && left.authorizationId === right.authorizationId;
}

export type GraphRepositories = {
  movement: MovementGraphReadProvider;
  memberContext: MemberContextReadProvider;
};

/** Server composition dependencies for the member-context read boundary. */
export type MemberContextReadBoundary = {
  readonly memberContext: MemberContextReadProvider;
  readonly authorizeMemberContext: MemberContextAccessAuthorizer;
};

/** Server-only graph dependencies for a dual-revision catalog evaluation. */
export type CatalogSafetyGraphBoundary = MemberContextReadBoundary & {
  readonly movement: MovementGraphReadProvider;
};
