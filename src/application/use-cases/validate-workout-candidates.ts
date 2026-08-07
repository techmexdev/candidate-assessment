import { CATALOG_SAFETY_MAX_EXERCISES, type CatalogSafetyDecision } from "../../domain/contracts/catalog-safety";
import type { CatalogSafetySessionStore } from "../ports/catalog-safety-sessions";
import type { MemberContextAccessAuthorizer, MemberContextAccessClaims } from "../ports/graph-repositories";
import { authorizeMemberContextSafely, sameMemberContextClaims } from "../ports/graph-repositories";
import type { CatalogSafetySecurityAudit } from "../ports/security-audit";
import { recordCatalogSafetyAudit } from "../ports/security-audit";

export type ValidateWorkoutCandidatesRequest = MemberContextAccessClaims & {
  readonly evaluationToken: string;
  readonly exerciseConceptIds: readonly string[];
};

/** Server-owned orchestration state. Never construct this value from an agent request. */
export type WorkoutCandidateValidationBinding = {
  readonly runId: string;
  readonly expectedEvaluationSessionId: string;
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly constraintDigest: string;
};

export type WorkoutCandidateViolation = {
  readonly candidateIndex?: number;
  readonly exerciseConceptId?: string;
  readonly reasonCode: "invalid-candidate-count" | "duplicate-candidate" | "unknown-candidate" | "excluded-candidate";
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
  readonly trustedBinding: Readonly<WorkoutCandidateValidationBinding>;
};

export function createValidateWorkoutCandidates(dependencies: ValidateWorkoutCandidatesDependencies) {
  const trustedBinding = Object.freeze({ ...dependencies.trustedBinding });
  return async (request: ValidateWorkoutCandidatesRequest): Promise<ValidateWorkoutCandidatesResult> => {
    const binding = trustedBinding;
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
    if (!sameMemberContextClaims(record.claims, claims)) {
      await recordCatalogSafetyAudit(dependencies.securityAudit, {
        kind: "catalog-safety-security",
        statusCode: "token-rejected",
        coachId: request.coachId,
        memberId: request.memberId,
        evaluationSessionId: binding.expectedEvaluationSessionId,
        reasonCode: "evaluation-binding-mismatch",
        assertionIds: [],
        evidenceIds: [],
      });
      return { status: "evaluation-unavailable", reasonCode: "evaluation-binding-mismatch" };
    }
    if (!await authorizeMemberContextSafely(dependencies.authorizeMemberContext, claims)) {
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
    const bindingsMatch = record.runId === binding.runId
      && record.evaluationSessionId === binding.expectedEvaluationSessionId
      && record.movementGraphRevisionId === binding.movementGraphRevisionId
      && record.memberContextRevisionId === binding.memberContextRevisionId
      && record.constraintDigest === binding.constraintDigest;
    if (!bindingsMatch) {
      await recordCatalogSafetyAudit(dependencies.securityAudit, {
        kind: "catalog-safety-security",
        statusCode: "token-rejected",
        coachId: request.coachId,
        memberId: request.memberId,
        evaluationSessionId: binding.expectedEvaluationSessionId,
        reasonCode: "evaluation-binding-mismatch",
        assertionIds: [],
        evidenceIds: [],
      });
      return { status: "evaluation-unavailable", reasonCode: "evaluation-binding-mismatch" };
    }

    if (!Array.isArray(request.exerciseConceptIds)
      || request.exerciseConceptIds.length === 0
      || request.exerciseConceptIds.length > CATALOG_SAFETY_MAX_EXERCISES) {
      await recordCatalogSafetyAudit(dependencies.securityAudit, {
        kind: "catalog-safety-security",
        statusCode: "candidate-validation-rejected",
        coachId: request.coachId,
        memberId: request.memberId,
        evaluationSessionId: record.evaluationSessionId,
        movementGraphRevisionId: record.movementGraphRevisionId,
        memberContextRevisionId: record.memberContextRevisionId,
        reasonCode: "invalid-candidate-count",
        assertionIds: [],
        evidenceIds: [],
      });
      return {
        status: "violations",
        accepted: [],
        violations: [{ reasonCode: "invalid-candidate-count" }],
      };
    }

    const decisions = new Map(record.result.decisions.map((decision) => [decision.exerciseConceptId, decision]));
    const seen = new Set<string>();
    const violations: WorkoutCandidateViolation[] = [];
    const accepted: CatalogSafetyDecision[] = [];
    for (const [candidateIndex, presentedCandidate] of request.exerciseConceptIds.entries()) {
      const exerciseConceptId = typeof presentedCandidate === "string" ? presentedCandidate : undefined;
      const decision = exerciseConceptId ? decisions.get(exerciseConceptId) : undefined;
      if (exerciseConceptId && seen.has(exerciseConceptId)) {
        violations.push({
          candidateIndex,
          ...(decision ? { exerciseConceptId: decision.exerciseConceptId } : {}),
          reasonCode: "duplicate-candidate",
        });
        continue;
      }
      if (exerciseConceptId) seen.add(exerciseConceptId);
      if (!decision) {
        violations.push({ candidateIndex, reasonCode: "unknown-candidate" });
      } else if (decision.classification === "excluded") {
        violations.push({ candidateIndex, exerciseConceptId: decision.exerciseConceptId, reasonCode: "excluded-candidate" });
      } else {
        accepted.push(decision);
      }
    }
    return violations.length > 0
      ? { status: "violations", violations, accepted }
      : { status: "accepted", decisions: accepted };
  };
}
