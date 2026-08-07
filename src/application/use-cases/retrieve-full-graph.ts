import type {
  FullGraphDomain,
  FullGraphReadResult,
} from "../../domain/contracts/full-graph-view";
import type { MemberContextAccessClaims, FullGraphRepositories } from "../ports/graph-repositories";
import { authorizeMemberContextSafely } from "../ports/graph-repositories";
import { mintAuthorizedMemberContextScope } from "./retrieve-member-context";

export type FullGraphAccessRequest = MemberContextAccessClaims & {
  readonly contextRevisionId?: string;
};

export type RetrieveFullGraphDependencies = FullGraphRepositories & {
  readonly authorizeMemberContext: (
    claims: Readonly<MemberContextAccessClaims>,
  ) => boolean | Promise<boolean>;
};

export type RetrieveFullGraph = {
  readonly readMovement: (input?: { readonly revisionId?: string }) => Promise<FullGraphReadResult>;
  readonly readMemberContext: (input: FullGraphAccessRequest) => Promise<FullGraphReadResult>;
};

const unavailable = (domain: FullGraphDomain): FullGraphReadResult => ({
  status: "unavailable",
  domain,
  message: domain === "member-context" ? "Member context is unavailable." : "Movement graph is unavailable.",
});

const denied = (domain: FullGraphDomain): FullGraphReadResult => ({
  status: "denied",
  domain,
  message: domain === "member-context" ? "Member context is unavailable." : "Movement graph is unavailable.",
});

/**
 * Server-only application boundary for complete graph reads. Movement reads
 * are session-gated by the HTTP route; member reads are re-authorized and
 * receive a freshly minted opaque scope for every snapshot read.
 */
export function createRetrieveFullGraph(
  dependencies: RetrieveFullGraphDependencies,
): RetrieveFullGraph {
  return {
    async readMovement(input) {
      try {
        return input?.revisionId
          ? await dependencies.movement.readFullRevision(input.revisionId)
          : await dependencies.movement.readFullActive();
      } catch {
        return unavailable("movement-clinical");
      }
    },

    async readMemberContext(input) {
      const claims = {
        coachId: input.coachId,
        memberId: input.memberId,
        authorizationId: input.authorizationId,
      } satisfies MemberContextAccessClaims;
      if (!await authorizeMemberContextSafely(dependencies.authorizeMemberContext, claims)) {
        return denied("member-context");
      }
      const scope = mintAuthorizedMemberContextScope(claims);
      try {
        return input.contextRevisionId
          ? await dependencies.memberContext.readFullRevision(scope, input.contextRevisionId)
          : await dependencies.memberContext.readFullActive(scope);
      } catch {
        return unavailable("member-context");
      }
    },
  };
}
