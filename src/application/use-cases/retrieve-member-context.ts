import type {
  AuthorizedMemberContextScope,
  MemberContextQueryResult,
  MemberContextReadHandle,
  MemberContextReadOpenResult,
  RelativeOrderSequenceQuery,
} from "../../domain/contracts/member-context-queries";
import type {
  MemberContextAccessClaims,
  MemberContextReadBoundary,
} from "../ports/graph-repositories";
import { authorizeMemberContextSafely } from "../ports/graph-repositories";

export type MemberContextAccessRequest = MemberContextAccessClaims & {
  readonly contextRevisionId?: string;
};

export type RetrieveMemberContextDependencies = MemberContextReadBoundary;

const authorizedClaims = new WeakMap<object, MemberContextAccessClaims>();
const genericUnavailableMessage = "Member context is unavailable.";

function deniedQueryResult<T>(handle: MemberContextReadHandle): MemberContextQueryResult<T> {
  return {
    status: "denied",
    memberId: handle.memberId,
    contextRevisionId: handle.contextRevisionId,
    authority: handle.authority,
    evidenceIds: [],
    message: genericUnavailableMessage,
  };
}

function unavailableQueryResult<T>(handle: MemberContextReadHandle): MemberContextQueryResult<T> {
  return {
    status: "unavailable",
    memberId: handle.memberId,
    contextRevisionId: handle.contextRevisionId,
    authority: handle.authority,
    evidenceIds: [],
    message: genericUnavailableMessage,
  };
}

function wrapWithFreshAuthorization(
  handle: MemberContextReadHandle,
  dependencies: RetrieveMemberContextDependencies,
  claims: Readonly<MemberContextAccessClaims>,
): MemberContextReadHandle {
  const invoke = async <T>(
    operation: () => Promise<MemberContextQueryResult<T>>,
  ): Promise<MemberContextQueryResult<T>> => {
    if (!await authorizeMemberContextSafely(dependencies.authorizeMemberContext, claims)) return deniedQueryResult(handle);
    try {
      return await operation();
    } catch {
      return unavailableQueryResult(handle);
    }
  };

  return Object.freeze({
    memberId: handle.memberId,
    coachId: handle.coachId,
    contextRevisionId: handle.contextRevisionId,
    authority: handle.authority,
    getSummary: (query) => invoke(() => handle.getSummary(query)),
    getEvidence: (query) => invoke(() => handle.getEvidence(query)),
    getLongitudinalSeries: (query) => invoke(() => handle.getLongitudinalSeries(query)),
    ...(handle.getRelativeOrderSequence
      ? { getRelativeOrderSequence: (query: RelativeOrderSequenceQuery) => invoke(() => handle.getRelativeOrderSequence!(query)) }
      : {}),
    getConversation: (query) => invoke(() => handle.getConversation(query)),
    getCoachBrief: (query) => invoke(() => handle.getCoachBrief(query)),
    getWorkoutConstraints: (query) => invoke(() => handle.getWorkoutConstraints(query)),
    getRelatedEvidence: (query) => invoke(() => handle.getRelatedEvidence(query)),
    getCitations: (query) => invoke(() => handle.getCitations(query)),
  });
}

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
    if (!await authorizeMemberContextSafely(dependencies.authorizeMemberContext, claims)) {
      return { status: "denied", message: genericUnavailableMessage };
    }

    const scope = mintAuthorizedScope(claims);
    const opened = await (request.contextRevisionId
      ? dependencies.memberContext.openRevision(scope, request.contextRevisionId)
      : dependencies.memberContext.openActive(scope));
    return opened.status === "ready"
      ? { status: "ready", handle: wrapWithFreshAuthorization(opened.handle, dependencies, claims) }
      : opened;
  };
}
