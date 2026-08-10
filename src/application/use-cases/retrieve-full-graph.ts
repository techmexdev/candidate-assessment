import type {
  FullGraphDomain,
  FullGraphInspectionRequest,
  FullGraphPageRequest,
  FullGraphReadResult,
} from "../../domain/contracts/full-graph-view";
import {
  isValidFullGraphPageRequest,
  sliceFullGraphProjection,
} from "../../domain/contracts/full-graph-view";
import type { MemberContextAccessClaims, FullGraphRepositories } from "../ports/graph-repositories";
import { authorizeMemberContextSafely } from "../ports/graph-repositories";
import { mintAuthorizedMemberContextScope } from "./retrieve-member-context";

export type FullGraphReadRequest = {
  readonly revisionId?: string;
  readonly inspection?: FullGraphInspectionRequest;
  readonly page?: FullGraphPageRequest;
};

export type FullGraphAccessRequest = MemberContextAccessClaims & {
  readonly contextRevisionId?: string;
  readonly inspection?: FullGraphInspectionRequest;
  readonly page?: FullGraphPageRequest;
};

export type RetrieveFullGraphDependencies = FullGraphRepositories & {
  readonly authorizeMemberContext: (
    claims: Readonly<MemberContextAccessClaims>,
  ) => boolean | Promise<boolean>;
};

function validateInspection(result: FullGraphReadResult, inspection: FullGraphInspectionRequest | undefined): FullGraphReadResult {
  if (!inspection || result.status !== "ready") return result;
  const collection = inspection.entityKind === "node" ? result.data.nodes : result.data.relationships;
  return collection.some((entity) => entity.id === inspection.entityId)
    ? result
    : {
        status: "invalid",
        domain: result.data.domain,
        message: "Requested graph entity is unavailable.",
      };
}

export type RetrieveFullGraph = {
  readonly readMovement: (input?: FullGraphReadRequest) => Promise<FullGraphReadResult>;
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

const invalidPage = (domain: FullGraphDomain): FullGraphReadResult => ({
  status: "invalid",
  domain,
  message: "Invalid full graph page request.",
});

function pageResult(result: FullGraphReadResult, page: FullGraphPageRequest): FullGraphReadResult {
  return result.status === "ready" ? { status: "ready", data: sliceFullGraphProjection(result.data, page) } : result;
}

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
      if (input?.page && !isValidFullGraphPageRequest(input.page)) return invalidPage("movement-clinical");
      try {
        const result = input?.page
          ? dependencies.movement.readFullPage
            ? await dependencies.movement.readFullPage(input.page, input.revisionId)
            : pageResult(
                input.revisionId
                  ? await dependencies.movement.readFullRevision(input.revisionId)
                  : await dependencies.movement.readFullActive(),
                input.page,
              )
          : input?.revisionId
            ? await dependencies.movement.readFullRevision(input.revisionId)
            : await dependencies.movement.readFullActive();
        return validateInspection(result, input?.inspection);
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
      if (input.page && !isValidFullGraphPageRequest(input.page)) return invalidPage("member-context");
      try {
        const result = input.page
          ? dependencies.memberContext.readFullPage
            ? await dependencies.memberContext.readFullPage(scope, input.page, input.contextRevisionId)
            : pageResult(
                input.contextRevisionId
                  ? await dependencies.memberContext.readFullRevision(scope, input.contextRevisionId)
                  : await dependencies.memberContext.readFullActive(scope),
                input.page,
              )
          : input.contextRevisionId
            ? await dependencies.memberContext.readFullRevision(scope, input.contextRevisionId)
            : await dependencies.memberContext.readFullActive(scope);
        return validateInspection(result, input.inspection);
      } catch {
        return unavailable("member-context");
      }
    },
  };
}
