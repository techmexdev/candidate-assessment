import type { CatalogSafetyDecision } from "../../domain/contracts/catalog-safety";
import type { CatalogSafetySessionStore } from "../ports/catalog-safety-sessions";
import type { MemberContextAccessAuthorizer, MemberContextAccessClaims } from "../ports/graph-repositories";
import type { CatalogSafetySecurityAudit } from "../ports/security-audit";
import { recordCatalogSafetyAudit } from "../ports/security-audit";

export type ValidateWorkoutCandidatesRequest = MemberContextAccessClaims & {
  readonly evaluationToken: string;
  readonly expectedEvaluationSessionId: string;
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly constraintDigest: string;
  readonly exerciseConceptIds: readonly string[];
};

export type WorkoutCandidateViolation = {
  readonly exerciseConceptId: string;
  readonly reasonCode: "duplicate-candidate" | "unknown-candidate" | "excluded-candidate";
};

export type ValidateWorkoutCandidatesResult =
  | { readonly status: "accepted"; readonly decisions: readonly CatalogSafetyDecision[] }
  | { readonly status: "violations"; readonly violations: readonly WorkoutCandidateViolation[]; readonly accepted: readonly CatalogSafetyDecision[] }
  | { readonly status: "denied" | "evaluation-unavailable"; readonly reasonCode: string };

export type ValidateWorkoutCandidatesDependencies = {
  readonly sessions: CatalogSafetySessionStore;
  readonly authorizeMemberContext: MemberContextAccessAuthorizer;
  readonly now: () => string;
  readonly securityAudit: CatalogSafetySecurityAudit;
};

async function authorized(
  authorize: MemberContextAccessAuthorizer,
  claims: Readonly<MemberContextAccessClaims>,
) {
  try {
    return await authorize(claims);
  } catch {
    return false;
  }
}

function sameClaims(left: Readonly<MemberContextAccessClaims>, right: Readonly<MemberContextAccessClaims>) {
  return left.coachId === right.coachId && left.memberId === right.memberId && left.authorizationId === right.authorizationId;
}

export function createValidateWorkoutCandidates(dependencies: ValidateWorkoutCandidatesDependencies) {
  return async (request: ValidateWorkoutCandidatesRequest): Promise<ValidateWorkoutCandidatesResult> => {
    const claims = { coachId: request.coachId, memberId: request.memberId, authorizationId: request.authorizationId };
    const lookedUp = dependencies.sessions.lookup(request.evaluationToken, dependencies.now());
    if (lookedUp.status !== "found") {
      await recordCatalogSafetyAudit(dependencies.securityAudit, {
        kind: "catalog-safety-security",
        statusCode: "token-rejected",
        coachId: request.coachId,
        memberId: request.memberId,
        reasonCode: lookedUp.status === "expired" ? "evaluation-expired" : "evaluation-absent",
        assertionIds: [],
        evidenceIds: [],
      });
      return { status: "evaluation-unavailable", reasonCode: lookedUp.status === "expired" ? "evaluation-expired" : "evaluation-absent" };
    }
    const { record } = lookedUp;
    if (!sameClaims(record.claims, claims)) {
      await recordCatalogSafetyAudit(dependencies.securityAudit, {
        kind: "catalog-safety-security",
        statusCode: "token-rejected",
        coachId: request.coachId,
        memberId: request.memberId,
        evaluationSessionId: request.expectedEvaluationSessionId,
        reasonCode: "evaluation-binding-mismatch",
        assertionIds: [],
        evidenceIds: [],
      });
      return { status: "evaluation-unavailable", reasonCode: "evaluation-binding-mismatch" };
    }
    if (!await authorized(dependencies.authorizeMemberContext, claims)) {
      dependencies.sessions.invalidate(request.evaluationToken);
      await recordCatalogSafetyAudit(dependencies.securityAudit, {
        kind: "catalog-safety-security",
        statusCode: "authorization-denied",
        coachId: request.coachId,
        memberId: request.memberId,
        evaluationSessionId: record.evaluationSessionId,
        movementGraphRevisionId: record.movementGraphRevisionId,
        memberContextRevisionId: record.memberContextRevisionId,
        reasonCode: "grant-revoked",
        assertionIds: [],
        evidenceIds: [],
      });
      return { status: "denied", reasonCode: "authorization-denied" };
    }
    const bindingsMatch = record.evaluationSessionId === request.expectedEvaluationSessionId
      && record.movementGraphRevisionId === request.movementGraphRevisionId
      && record.memberContextRevisionId === request.memberContextRevisionId
      && record.constraintDigest === request.constraintDigest;
    if (!bindingsMatch) {
      await recordCatalogSafetyAudit(dependencies.securityAudit, {
        kind: "catalog-safety-security",
        statusCode: "token-rejected",
        coachId: request.coachId,
        memberId: request.memberId,
        evaluationSessionId: request.expectedEvaluationSessionId,
        reasonCode: "evaluation-binding-mismatch",
        assertionIds: [],
        evidenceIds: [],
      });
      return { status: "evaluation-unavailable", reasonCode: "evaluation-binding-mismatch" };
    }

    const decisions = new Map(record.result.decisions.map((decision) => [decision.exerciseConceptId, decision]));
    const seen = new Set<string>();
    const violations: WorkoutCandidateViolation[] = [];
    const accepted: CatalogSafetyDecision[] = [];
    for (const exerciseConceptId of request.exerciseConceptIds) {
      if (seen.has(exerciseConceptId)) {
        violations.push({ exerciseConceptId, reasonCode: "duplicate-candidate" });
        continue;
      }
      seen.add(exerciseConceptId);
      const decision = decisions.get(exerciseConceptId);
      if (!decision) {
        violations.push({ exerciseConceptId, reasonCode: "unknown-candidate" });
      } else if (decision.classification === "excluded") {
        violations.push({ exerciseConceptId, reasonCode: "excluded-candidate" });
      } else {
        accepted.push(decision);
      }
    }
    return violations.length > 0
      ? { status: "violations", violations, accepted }
      : { status: "accepted", decisions: accepted };
  };
}
