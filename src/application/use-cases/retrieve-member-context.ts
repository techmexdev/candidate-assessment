import type {
  AuthorizedMemberContextScope,
  MemberContextReadOpenResult,
  MemberContextReadProvider,
} from "../../domain/contracts/member-context-queries";
import type {
  MemberContextAccessAuthorizer,
  MemberContextAccessClaims,
} from "../ports/graph-repositories";

export type MemberContextAccessRequest = {
  readonly coachId: string;
  readonly memberId: string;
  readonly authorizationId: string;
  readonly contextRevisionId?: string;
};

export type RetrieveMemberContextDependencies = {
  readonly memberContext: MemberContextReadProvider;
  readonly authorize: MemberContextAccessAuthorizer;
};

const authorizedClaims = new WeakMap<object, MemberContextAccessClaims>();

function mintAuthorizedScope(claims: MemberContextAccessClaims): AuthorizedMemberContextScope {
  const token = Object.freeze({});
  authorizedClaims.set(token, Object.freeze({ ...claims }));
  return token as AuthorizedMemberContextScope;
}

/**
 * Infrastructure verification hook. It can inspect tokens minted by this
 * application boundary, but cannot mint a token or recover one from claims.
 */
export function inspectAuthorizedMemberContextScope(
  scope: AuthorizedMemberContextScope,
): MemberContextAccessClaims | undefined {
  if ((typeof scope !== "object" && typeof scope !== "function") || scope === null) return undefined;
  return authorizedClaims.get(scope as object);
}

/**
 * Server-side application boundary for member-context access. Raw identities
 * and grants never reach the graph provider; it receives only an opaque token.
 */
export function createRetrieveMemberContext(
  dependencies: RetrieveMemberContextDependencies,
): (request: MemberContextAccessRequest) => Promise<MemberContextReadOpenResult> {
  return async (request) => {
    const claims = {
      coachId: request.coachId,
      memberId: request.memberId,
      authorizationId: request.authorizationId,
    };
    let authorized = false;
    try {
      authorized = await dependencies.authorize(claims);
    } catch {
      authorized = false;
    }
    if (!authorized) return { status: "denied", message: "Member context is unavailable." };

    const scope = mintAuthorizedScope(claims);
    return request.contextRevisionId
      ? dependencies.memberContext.openRevision(scope, request.contextRevisionId)
      : dependencies.memberContext.openActive(scope);
  };
}
