import type { CatalogSafetySessionStore } from "../ports/catalog-safety-sessions";
import type { MemberContextAccessAuthorizer, MemberContextAccessClaims } from "../ports/graph-repositories";
import type { CatalogSafetySecurityAudit } from "../ports/security-audit";
import { recordCatalogSafetyAudit } from "../ports/security-audit";

export type InvalidateCatalogSafetySessionRequest = MemberContextAccessClaims & {
  readonly evaluationToken: string;
  readonly expectedEvaluationSessionId: string;
};

export type InvalidateCatalogSafetySessionDependencies = {
  readonly sessions: CatalogSafetySessionStore;
  readonly authorizeMemberContext: MemberContextAccessAuthorizer;
  readonly now: () => string;
  readonly securityAudit: CatalogSafetySecurityAudit;
};

export function createInvalidateCatalogSafetySession(dependencies: InvalidateCatalogSafetySessionDependencies) {
  return async (request: InvalidateCatalogSafetySessionRequest) => {
    const claims = { coachId: request.coachId, memberId: request.memberId, authorizationId: request.authorizationId };
    const found = dependencies.sessions.lookup(request.evaluationToken, dependencies.now());
    const claimsMatch = found.status === "found"
      && found.record.claims.coachId === request.coachId
      && found.record.claims.memberId === request.memberId
      && found.record.claims.authorizationId === request.authorizationId;
    if (found.status !== "found" || !claimsMatch
      || found.record.evaluationSessionId !== request.expectedEvaluationSessionId) {
      await recordCatalogSafetyAudit(dependencies.securityAudit, {
        kind: "catalog-safety-security",
        statusCode: "token-rejected",
        coachId: request.coachId,
        memberId: request.memberId,
        evaluationSessionId: request.expectedEvaluationSessionId,
        reasonCode: "evaluation-unavailable",
        assertionIds: [],
        evidenceIds: [],
      });
      return { status: "evaluation-unavailable" as const, reasonCode: "evaluation-unavailable" };
    }
    let isAuthorized = false;
    try {
      isAuthorized = await dependencies.authorizeMemberContext(claims);
    } catch {
      isAuthorized = false;
    }
    if (!isAuthorized) {
      dependencies.sessions.invalidate(request.evaluationToken);
      await recordCatalogSafetyAudit(dependencies.securityAudit, {
        kind: "catalog-safety-security",
        statusCode: "authorization-denied",
        coachId: request.coachId,
        memberId: request.memberId,
        evaluationSessionId: found.record.evaluationSessionId,
        reasonCode: "authorization-denied",
        assertionIds: [],
        evidenceIds: [],
      });
      return { status: "denied" as const, reasonCode: "authorization-denied" };
    }
    dependencies.sessions.invalidate(request.evaluationToken);
    await recordCatalogSafetyAudit(dependencies.securityAudit, {
      kind: "catalog-safety-security",
      statusCode: "session-invalidated",
      coachId: request.coachId,
      memberId: request.memberId,
      evaluationSessionId: found.record.evaluationSessionId,
      movementGraphRevisionId: found.record.movementGraphRevisionId,
      memberContextRevisionId: found.record.memberContextRevisionId,
      reasonCode: "explicit-invalidation",
      assertionIds: [],
      evidenceIds: [],
    });
    return { status: "invalidated" as const, evaluationSessionId: found.record.evaluationSessionId };
  };
}
