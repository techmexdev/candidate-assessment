import type {
  CatalogExplicitExclusionInput,
  CatalogPreferenceInput,
  CatalogSafetyCandidateInput,
  CatalogSafetyDecision,
  CatalogSafetyFailClosedResult,
} from "../../domain/contracts/catalog-safety";
import {
  CATALOG_SAFETY_MAX_EXERCISES,
  CATALOG_SAFETY_MAX_FAMILY_DEPTH,
} from "../../domain/contracts/catalog-safety";
import type { CatalogFamilyFact, MovementGraphReadHandle } from "../../domain/contracts/movement-clinical-queries";
import type { MovementLaterality } from "../../domain/contracts/movement-safety";
import { classifyCatalogSafety } from "../../domain/policies/catalog-safety";
import { canonicalJson, deepFreeze, sha256 } from "../../graph/revisions/movement-graph";
import type {
  CatalogSafetySessionStore,
  CatalogSafetyTokenSource,
} from "../ports/catalog-safety-sessions";
import { CATALOG_SAFETY_SESSION_TTL_MS } from "../ports/catalog-safety-sessions";
import type { CatalogSafetyGraphBoundary } from "../ports/graph-repositories";
import type { CatalogSafetySecurityAudit } from "../ports/security-audit";
import { recordCatalogSafetyAudit } from "../ports/security-audit";
import { createMovementSafetyReadCache, evaluateMovementSafetyFactsWithHandle } from "./evaluate-movement-safety";
import { createRetrieveMemberContext } from "./retrieve-member-context";

export type CatalogSafetyResolutionProof = {
  readonly certificateId: string;
};

export const CATALOG_SAFETY_MAX_INJURY_APPLICABILITY = 32;
export const CATALOG_SAFETY_MAX_EXPLICIT_EXCLUSIONS = CATALOG_SAFETY_MAX_EXERCISES;
export const CATALOG_SAFETY_MAX_PREFERENCES = CATALOG_SAFETY_MAX_EXERCISES;
export const CATALOG_SAFETY_MAX_EQUIPMENT = 32;

export type CatalogSafetyResolutionPurpose = "injury-applicability" | "explicit-exclusion" | "preference";

export type CatalogSafetyResolutionCertificateRequest = {
  readonly certificateId: string;
  readonly purpose: CatalogSafetyResolutionPurpose;
  readonly runId: string;
  readonly movementGraphRevisionId: string;
  readonly payloadDigest: string;
  readonly emptyResultAttestationId?: string;
};

export type CatalogSafetyResolutionCertificateClaims = CatalogSafetyResolutionCertificateRequest & {
  readonly issuerId: string;
  readonly policyRevision: string;
  readonly maxDepth: number;
  readonly maxResults: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
};

export type CatalogSafetyResolutionCertificateVerifier = {
  readonly trustedIssuerId: string;
  /** Authenticates the issuer and the signed/retained claims before returning `verified`. */
  readonly verify: (request: CatalogSafetyResolutionCertificateRequest) => Promise<
    | { readonly status: "verified"; readonly claims: CatalogSafetyResolutionCertificateClaims }
    | { readonly status: "invalid" }
  >;
};

export type CatalogSafetyInjuryApplicability = {
  readonly memberEvidenceId: string;
  readonly conditionConceptId: `condition:${string}`;
  readonly affectedAnatomyConceptId: `joint:${string}` | `body-region:${string}`;
  readonly conditionStatus: string;
  readonly recoveryStage: string;
  readonly severityBand: string;
  readonly affectedLaterality: MovementLaterality;
  readonly evidenceId: string;
  readonly resolution: CatalogSafetyResolutionProof;
};

export type CatalogSafetyResolvedMatch = {
  readonly conceptId: `exercise:${string}` | `movement-pattern:${string}`;
  readonly conceptKind: "exercise" | "movement-pattern";
  readonly evidenceId: string;
  readonly resolution: CatalogSafetyResolutionProof;
  readonly zeroMatchAttested?: boolean;
  readonly emptyResultAttestationId?: string;
  readonly rankPenalty?: number;
};

type CatalogSafetyMatchInput = Omit<CatalogSafetyResolvedMatch, "resolution"> & {
  readonly resolution?: CatalogSafetyResolutionProof;
};

export type EvaluateCatalogSafetyRequest = {
  readonly coachId: string;
  readonly memberId: string;
  readonly authorizationId: string;
  readonly runId: string;
  readonly memberContextRevisionId?: string;
  readonly movementGraphRevisionId?: string;
  readonly injuryApplicability: readonly CatalogSafetyInjuryApplicability[];
  readonly explicitExclusions: readonly CatalogSafetyResolvedMatch[];
  readonly preferences: readonly CatalogSafetyResolvedMatch[];
  /** Optional bounded equipment set supplied by an authorized adjustment. */
  readonly availableEquipmentConceptIds?: readonly string[];
};

type EvaluationEnvelope = {
  readonly movementGraphRevisionId?: string;
  readonly memberContextRevisionId?: string;
  readonly assertionIds: readonly string[];
  readonly evidenceIds: readonly string[];
};

export type EvaluateCatalogSafetyResult =
  | ({
      readonly status: "ready";
      readonly evaluationToken: string;
      readonly evaluationSessionId: string;
      readonly constraintDigest: string;
      readonly expiresAt: string;
      readonly movementGraphRevisionId: string;
      readonly memberContextRevisionId: string;
      readonly decisions: readonly CatalogSafetyDecision[];
      readonly excluded: readonly CatalogSafetyDecision[];
      readonly caution: readonly CatalogSafetyDecision[];
      readonly downranked: readonly CatalogSafetyDecision[];
      readonly allowed: readonly CatalogSafetyDecision[];
      readonly zeroMatchEvidenceIds: readonly string[];
    })
  | (EvaluationEnvelope & {
      readonly status: "denied" | "clarification_required" | "fail_closed" | "capacity";
      readonly reasonCode: string;
    });

export type EvaluateCatalogSafetyDependencies = CatalogSafetyGraphBoundary & {
  readonly sessions: CatalogSafetySessionStore;
  readonly tokenSource: CatalogSafetyTokenSource;
  readonly now: () => string;
  readonly securityAudit: CatalogSafetySecurityAudit;
  readonly resolutionCertificates: CatalogSafetyResolutionCertificateVerifier;
};

const safeEnvelope = (overrides: Partial<EvaluationEnvelope> = {}): EvaluationEnvelope => ({
  assertionIds: [],
  evidenceIds: [],
  ...overrides,
});

function sameCertificateClaims(
  expected: CatalogSafetyResolutionCertificateRequest,
  claims: CatalogSafetyResolutionCertificateClaims,
  now: string,
  trustedIssuerId: string,
) {
  const nowTimestamp = Date.parse(now);
  const issuedTimestamp = Date.parse(claims.issuedAt);
  const expiresTimestamp = Date.parse(claims.expiresAt);
  return claims.certificateId === expected.certificateId
    && claims.purpose === expected.purpose
    && claims.runId === expected.runId
    && claims.movementGraphRevisionId === expected.movementGraphRevisionId
    && claims.payloadDigest === expected.payloadDigest
    && claims.emptyResultAttestationId === expected.emptyResultAttestationId
    && trustedIssuerId.length > 0
    && claims.issuerId === trustedIssuerId
    && claims.policyRevision.length > 0
    && Number.isInteger(claims.maxDepth)
    && claims.maxDepth > 0
    && claims.maxDepth <= CATALOG_SAFETY_MAX_FAMILY_DEPTH
    && Number.isInteger(claims.maxResults)
    && claims.maxResults > 0
    && claims.maxResults <= CATALOG_SAFETY_MAX_EXERCISES
    && Number.isFinite(nowTimestamp)
    && Number.isFinite(issuedTimestamp)
    && Number.isFinite(expiresTimestamp)
    && issuedTimestamp <= nowTimestamp
    && nowTimestamp < expiresTimestamp;
}

async function verifyResolution(
  verifier: CatalogSafetyResolutionCertificateVerifier,
  expected: CatalogSafetyResolutionCertificateRequest,
  now: string,
) {
  try {
    const verified = await verifier.verify(expected);
    return verified.status === "verified"
      && sameCertificateClaims(expected, verified.claims, now, verifier.trustedIssuerId)
      ? { status: "verified" as const, maxDepth: verified.claims.maxDepth, maxResults: verified.claims.maxResults }
      : { status: "invalid" as const };
  } catch {
    return { status: "invalid" as const };
  }
}

function constraintPayloadDigest(payload: Readonly<Record<string, unknown>>) {
  return `sha256:${sha256(canonicalJson(payload))}`;
}

function digestConstraints(request: EvaluateCatalogSafetyRequest) {
  const authority = {
    runId: request.runId,
    injuryApplicability: request.injuryApplicability,
    explicitExclusions: request.explicitExclusions,
    preferences: request.preferences,
  };
  return `sha256:${sha256(canonicalJson(authority))}`;
}

function randomHex(source: CatalogSafetyTokenSource) {
  const bytes = source.randomBytes(16);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 16) return undefined;
  return Buffer.from(bytes).toString("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function resolveMatches<T extends CatalogExplicitExclusionInput | CatalogPreferenceInput>(
  handle: MovementGraphReadHandle,
  matches: readonly CatalogSafetyMatchInput[],
  kind: "explicit" | "preference",
  contributionFor: (match: CatalogSafetyMatchInput, fact: CatalogFamilyFact) => T,
  resolutionFor: (match: CatalogSafetyMatchInput) => Promise<
    | { readonly status: "verified"; readonly maxDepth: number; readonly maxResults: number }
    | { readonly status: "invalid" }
  >,
  familyReadCache: Map<string, ReturnType<MovementGraphReadHandle["getCatalogFamilyFacts"]>>,
  unresolved: "clarification" | "omit" = "clarification",
): Promise<{
  readonly status: "ready";
  readonly byExercise: ReadonlyMap<string, readonly T[]>;
  readonly zeroMatchEvidenceIds: readonly string[];
} | { readonly status: "clarification_required" | "fail_closed"; readonly reasonCode: string }> {
  const byExercise = new Map<string, T[]>();
  const zeroMatchEvidenceIds: string[] = [];
  for (const match of matches) {
    const resolution = await resolutionFor(match);
    if (!match.evidenceId || resolution.status !== "verified" || match.conceptId.split(":", 1)[0] !== match.conceptKind
      || (kind === "preference" && (!Number.isInteger(match.rankPenalty) || match.rankPenalty! < 0))) {
      return { status: "clarification_required", reasonCode: "constraint-re-resolution-required" };
    }
    const familyQuery = {
      conceptId: match.conceptId,
      conceptKind: match.conceptKind,
      maxDepth: resolution.maxDepth,
      maxResults: resolution.maxResults,
    } as const;
    const familyKey = `${handle.graphRevisionId}\0${familyQuery.conceptKind}\0${familyQuery.conceptId}\0${familyQuery.maxDepth}\0${familyQuery.maxResults}`;
    let familyRead = familyReadCache.get(familyKey);
    if (!familyRead) {
      familyRead = handle.getCatalogFamilyFacts(familyQuery);
      familyReadCache.set(familyKey, familyRead);
    }
    const resolved = await familyRead;
    if (match.zeroMatchAttested) {
      if (resolved.status === "failed" && resolved.failure.code !== "unresolved_concept") {
        return { status: "fail_closed", reasonCode: "constraint-graph-unavailable" };
      }
      if (!match.emptyResultAttestationId || resolved.status === "ok") {
        return { status: "clarification_required", reasonCode: "zero-match-re-resolution-required" };
      }
      zeroMatchEvidenceIds.push(match.evidenceId, match.emptyResultAttestationId);
      continue;
    }
    if (resolved.status !== "ok") {
      if (resolved.failure.code === "unresolved_concept" && unresolved === "omit") {
        zeroMatchEvidenceIds.push(match.evidenceId);
        continue;
      }
      return { status: resolved.failure.code === "unresolved_concept" ? "clarification_required" : "fail_closed", reasonCode: "constraint-re-resolution-required" };
    }
    for (const fact of resolved.data) {
      const contribution = contributionFor(match, fact);
      const contributions = byExercise.get(fact.exerciseConceptId);
      if (contributions) contributions.push(contribution);
      else byExercise.set(fact.exerciseConceptId, [contribution]);
    }
  }
  return { status: "ready", byExercise, zeroMatchEvidenceIds: [...new Set(zeroMatchEvidenceIds)].sort() };
}

function hasDuplicates(values: readonly string[]) {
  return new Set(values).size !== values.length;
}

function invalidConstraintCollection(request: EvaluateCatalogSafetyRequest) {
  if (request.injuryApplicability.length > CATALOG_SAFETY_MAX_INJURY_APPLICABILITY
    || request.explicitExclusions.length > CATALOG_SAFETY_MAX_EXPLICIT_EXCLUSIONS
    || request.preferences.length > CATALOG_SAFETY_MAX_PREFERENCES) return "constraint-limit-exceeded";
  const injuryKeys = request.injuryApplicability.map((item) => `${item.memberEvidenceId}\0${item.evidenceId}\0${item.resolution?.certificateId ?? ""}`);
  const exclusionKeys = request.explicitExclusions.map((item) => `${item.conceptKind}\0${item.conceptId}\0${item.evidenceId}\0${item.resolution?.certificateId ?? ""}`);
  const preferenceKeys = request.preferences.map((item) => `${item.conceptKind}\0${item.conceptId}\0${item.evidenceId}\0${item.rankPenalty}\0${item.resolution?.certificateId ?? ""}`);
  return hasDuplicates(injuryKeys) || hasDuplicates(exclusionKeys) || hasDuplicates(preferenceKeys)
    ? "duplicate-constraints"
    : undefined;
}

function reviewedMovementIds(references: readonly { readonly state: string; readonly graph?: string; readonly stableConceptId?: string }[]) {
  return references.flatMap((reference) => reference.state === "reviewed" && reference.graph === "movement-clinical" && reference.stableConceptId
    ? [reference.stableConceptId] : []);
}

function findApplicability(
  request: EvaluateCatalogSafetyRequest,
  injury: { readonly evidenceId: string; readonly domainReferences: readonly { readonly state: string; readonly graph?: string; readonly stableConceptId?: string }[] },
) {
  const ids = new Set(reviewedMovementIds(injury.domainReferences));
  const matches = request.injuryApplicability.filter((item) => item.memberEvidenceId === injury.evidenceId
    && ids.has(item.conditionConceptId) && ids.has(item.affectedAnatomyConceptId));
  return matches.length === 1 ? matches[0] : undefined;
}

function clinicalInputs(
  safety: Exclude<Awaited<ReturnType<typeof evaluateMovementSafetyFactsWithHandle>>, { status: "fail_closed" }>,
) {
  const inputs: CatalogSafetyCandidateInput["clinicalEvaluations"][number][] = [];
  for (const path of safety.contributingPaths) {
    if (!path.sourceAssertionId || !path.sourceEvidenceId) return undefined;
    inputs.push({
      kind: "clinical" as const,
      conditionConceptId: path.conditionConceptId,
      conditionAssertionId: path.sourceAssertionId,
      conditionEvidenceId: path.sourceEvidenceId,
      affectedAnatomyConceptId: path.affectedAnatomyConceptId,
      ruleConceptId: path.ruleConceptId,
      ruleAssertionId: path.ruleAssertionIds[0]!,
      targetConceptId: path.targetConceptId,
      effect: path.effect,
      applicabilityMatched: true,
      targetPathAssertionIds: path.assertionIds,
      anatomyPathAssertionIds: path.affectedAnatomyPathAssertionIds,
      mappingAssertionIds: path.mappingAssertionIds,
      evidenceAssertionIds: path.evidenceAssertionIds,
    });
  }
  return inputs;
}

function requiredEquipment(candidate: { readonly relations: readonly { readonly kind: string; readonly targetConceptId: string; readonly targetAssertionId: string; readonly edgeAssertionId: string }[] }) {
  return candidate.relations.filter((relation) => relation.kind === "requires").map((relation) => ({
    equipmentConceptId: relation.targetConceptId,
    equipmentAssertionId: relation.targetAssertionId,
    requiresAssertionId: relation.edgeAssertionId,
  }));
}

export function createEvaluateCatalogSafety(dependencies: EvaluateCatalogSafetyDependencies) {
  const retrieveMember = createRetrieveMemberContext(dependencies);
  return async (request: EvaluateCatalogSafetyRequest): Promise<EvaluateCatalogSafetyResult> => {
    const auditBase = { coachId: request.coachId, memberId: request.memberId };
    const fail = async (
      status: Exclude<EvaluateCatalogSafetyResult["status"], "ready">,
      reasonCode: string,
      envelope: EvaluationEnvelope = safeEnvelope(),
      auditStatus: "authorization-denied" | "evaluation-fail-closed" = "evaluation-fail-closed",
    ): Promise<EvaluateCatalogSafetyResult> => {
      if (status === "denied" || status === "fail_closed") {
        await recordCatalogSafetyAudit(dependencies.securityAudit, {
          kind: "catalog-safety-security",
          statusCode: auditStatus,
          ...auditBase,
          movementGraphRevisionId: envelope.movementGraphRevisionId,
          memberContextRevisionId: envelope.memberContextRevisionId,
          reasonCode,
          assertionIds: envelope.assertionIds,
          evidenceIds: envelope.evidenceIds,
        });
      }
      return { status, reasonCode, ...envelope };
    };

    if (!request.coachId || !request.memberId || !request.authorizationId || !request.runId
      || !Array.isArray(request.injuryApplicability)
      || !Array.isArray(request.explicitExclusions)
      || !Array.isArray(request.preferences)
      || (request.availableEquipmentConceptIds !== undefined
        && (!Array.isArray(request.availableEquipmentConceptIds)
          || request.availableEquipmentConceptIds.length > CATALOG_SAFETY_MAX_EQUIPMENT
          || request.availableEquipmentConceptIds.some((id) => typeof id !== "string" || !id.startsWith("equipment:"))))) {
      return fail("fail_closed", "invalid-request");
    }
    let evaluationNow: string;
    try {
      evaluationNow = dependencies.now();
    } catch {
      return fail("fail_closed", "invalid-clock");
    }
    if (!Number.isFinite(Date.parse(evaluationNow))) return fail("fail_closed", "invalid-clock");
    const invalidCollection = invalidConstraintCollection(request);
    if (invalidCollection) return fail("fail_closed", invalidCollection);
    const memberOpened = await retrieveMember({
      coachId: request.coachId,
      memberId: request.memberId,
      authorizationId: request.authorizationId,
      contextRevisionId: request.memberContextRevisionId,
    });
    if (memberOpened.status !== "ready") {
      return fail(memberOpened.status === "denied" ? "denied" : "fail_closed", `member-context-${memberOpened.status}`, safeEnvelope(), memberOpened.status === "denied" ? "authorization-denied" : "evaluation-fail-closed");
    }
    const memberContextRevisionId = memberOpened.handle.contextRevisionId;
    if (memberOpened.handle.authority !== "canonical") {
      return fail("fail_closed", "non-authoritative-member-context", safeEnvelope({ memberContextRevisionId }));
    }
    const constraints = await memberOpened.handle.getWorkoutConstraints({ limit: 100, timeoutMs: 1_000 });
    if (constraints.status !== "ready") {
      return fail(constraints.status === "denied" ? "denied" : "fail_closed", `member-constraints-${constraints.status}`, safeEnvelope({ memberContextRevisionId }), constraints.status === "denied" ? "authorization-denied" : "evaluation-fail-closed");
    }
    const movementOpened = request.movementGraphRevisionId
      ? await dependencies.movement.openRevision(request.movementGraphRevisionId)
      : await dependencies.movement.openActive();
    if (movementOpened.status !== "ready") {
      return fail("fail_closed", "movement-graph-unavailable", safeEnvelope({ memberContextRevisionId }));
    }
    const { handle } = movementOpened;
    const revisions = { movementGraphRevisionId: handle.graphRevisionId, memberContextRevisionId };
    if (handle.authority !== "canonical") return fail("fail_closed", "non-authoritative-movement-graph", safeEnvelope(revisions));

    const catalog = await handle.getCatalogExerciseFacts({ maxResults: CATALOG_SAFETY_MAX_EXERCISES });
    if (catalog.status !== "ok") return fail("fail_closed", `catalog-${catalog.failure.code}`, safeEnvelope(revisions));
    const familyReadCache = new Map<string, ReturnType<MovementGraphReadHandle["getCatalogFamilyFacts"]>>();
    const verifyMatchResolution = (purpose: "explicit-exclusion" | "preference") => (match: CatalogSafetyMatchInput) => {
      if (!match.resolution?.certificateId) return Promise.resolve({ status: "invalid" as const });
      return verifyResolution(dependencies.resolutionCertificates, {
        certificateId: match.resolution.certificateId,
        purpose,
        runId: request.runId,
        movementGraphRevisionId: handle.graphRevisionId,
        payloadDigest: constraintPayloadDigest({
          conceptId: match.conceptId,
          conceptKind: match.conceptKind,
          evidenceId: match.evidenceId,
          zeroMatchAttested: match.zeroMatchAttested === true,
          emptyResultAttestationId: match.emptyResultAttestationId ?? null,
          rankPenalty: match.rankPenalty ?? null,
        }),
        ...(match.zeroMatchAttested && match.emptyResultAttestationId
          ? { emptyResultAttestationId: match.emptyResultAttestationId }
          : {}),
      }, evaluationNow);
    };
    const exclusions = await resolveMatches(handle, request.explicitExclusions, "explicit", (match, fact) => ({
      matchKind: fact.matchKind,
      resolvedConceptId: match.conceptId,
      evidenceId: match.evidenceId,
      assertionIds: fact.pathAssertionIds,
    }), verifyMatchResolution("explicit-exclusion"), familyReadCache);
    if (exclusions.status !== "ready") return fail(exclusions.status, exclusions.reasonCode, safeEnvelope(revisions));
    const preferenceContribution = (match: CatalogSafetyMatchInput, fact: CatalogFamilyFact): CatalogPreferenceInput => ({
      matchKind: fact.matchKind,
      resolvedConceptId: match.conceptId,
      evidenceId: match.evidenceId,
      rankPenalty: match.rankPenalty!,
      assertionIds: fact.pathAssertionIds,
    });
    const runPreferences = await resolveMatches(handle, request.preferences, "preference", preferenceContribution,
      verifyMatchResolution("preference"), familyReadCache);
    if (runPreferences.status !== "ready") return fail(runPreferences.status, runPreferences.reasonCode, safeEnvelope(revisions));

    const memberPreferences: CatalogSafetyMatchInput[] = constraints.data.preferences.flatMap((preference) => (
      reviewedMovementIds(preference.domainReferences).flatMap((conceptId) => (
        conceptId.startsWith("exercise:") || conceptId.startsWith("movement-pattern:") ? [{
          conceptId: conceptId as CatalogSafetyResolvedMatch["conceptId"],
          conceptKind: conceptId.startsWith("exercise:") ? "exercise" as const : "movement-pattern" as const,
          evidenceId: preference.evidenceId,
          rankPenalty: 1,
        }] : []
      ))
    ));
    const reviewedPreferences = await resolveMatches(handle, memberPreferences, "preference", preferenceContribution,
      async () => ({ status: "verified", maxDepth: CATALOG_SAFETY_MAX_FAMILY_DEPTH, maxResults: CATALOG_SAFETY_MAX_EXERCISES }),
      familyReadCache, "omit");
    if (reviewedPreferences.status !== "ready") return fail("fail_closed", reviewedPreferences.reasonCode, safeEnvelope(revisions));

    const contexts = [];
    if (request.injuryApplicability.length !== constraints.data.injuries.length) {
      return fail("clarification_required", "injury-applicability-required", safeEnvelope(revisions));
    }
    for (const injury of constraints.data.injuries) {
      const applicability = findApplicability(request, injury);
      if (!applicability || !applicability.conditionStatus || !applicability.recoveryStage || !applicability.severityBand) {
        return fail("clarification_required", "injury-applicability-required", safeEnvelope(revisions));
      }
      if (!applicability.resolution?.certificateId) {
        return fail("clarification_required", "injury-applicability-re-resolution-required", safeEnvelope(revisions));
      }
      const verifiedApplicability = await verifyResolution(dependencies.resolutionCertificates, {
        certificateId: applicability.resolution.certificateId,
        purpose: "injury-applicability",
        runId: request.runId,
        movementGraphRevisionId: handle.graphRevisionId,
        payloadDigest: constraintPayloadDigest({
          memberEvidenceId: applicability.memberEvidenceId,
          conditionConceptId: applicability.conditionConceptId,
          affectedAnatomyConceptId: applicability.affectedAnatomyConceptId,
          conditionStatus: applicability.conditionStatus,
          recoveryStage: applicability.recoveryStage,
          severityBand: applicability.severityBand,
          affectedLaterality: applicability.affectedLaterality,
          evidenceId: applicability.evidenceId,
        }),
      }, evaluationNow);
      if (verifiedApplicability.status !== "verified") {
        return fail("clarification_required", "injury-applicability-re-resolution-required", safeEnvelope(revisions));
      }
      const rules = await handle.getClinicalRuleFacts({
        conditionConceptId: applicability.conditionConceptId,
        maxResults: 32,
      });
      if (rules.status !== "ok" || rules.data.length === 0) {
        return fail(rules.status === "failed" && rules.failure.code === "unresolved_concept"
          ? "clarification_required" : "fail_closed", "injury-condition-re-resolution-required", safeEnvelope(revisions));
      }
      const applicabilityResolved = rules.data.some((rule) => (
        rule.applicability.conditionStatuses.includes(applicability.conditionStatus)
        && rule.applicability.recoveryStages.includes(applicability.recoveryStage)
        && rule.applicability.severityBands.includes(applicability.severityBand)
      ));
      const anatomy = await handle.getAnatomyPaths({
        conceptId: applicability.affectedAnatomyConceptId,
        includeSelf: true,
        maxDepth: 4,
        maxResults: 32,
      });
      if (!applicabilityResolved || anatomy.status !== "ok") {
        return fail("clarification_required", "injury-applicability-re-resolution-required", safeEnvelope(revisions));
      }
      contexts.push({
        conditionConceptId: applicability.conditionConceptId,
        affectedAnatomyConceptId: applicability.affectedAnatomyConceptId,
        conditionStatus: applicability.conditionStatus,
        recoveryStage: applicability.recoveryStage,
        severityBand: applicability.severityBand,
        affectedLaterality: applicability.affectedLaterality,
        loadedLaterality: "unknown" as const,
        sourceKey: `${injury.assertionId}\0${applicability.evidenceId}`,
        sourceAssertionId: injury.assertionId,
        sourceEvidenceId: applicability.evidenceId,
      });
    }

    const candidates: CatalogSafetyCandidateInput[] = [];
    const safetyReadCache = createMovementSafetyReadCache();
    for (const exercise of catalog.data) {
      const safety = await evaluateMovementSafetyFactsWithHandle(handle, {
        graphRevisionId: handle.graphRevisionId,
        exerciseConceptId: exercise.exerciseConceptId,
        conditions: contexts,
      }, exercise, safetyReadCache);
      if (safety.status === "fail_closed") {
        return fail("fail_closed", `movement-safety-${safety.reason}`, safeEnvelope({ ...revisions, assertionIds: safety.assertionIds, evidenceIds: [] }));
      }
      const clinicalEvaluations = clinicalInputs(safety);
      if (!clinicalEvaluations) {
        return fail("fail_closed", "movement-safety-missing-source-provenance", safeEnvelope(revisions));
      }
      candidates.push({
        ...revisions,
        exerciseConceptId: exercise.exerciseConceptId,
        exerciseAssertionId: exercise.exerciseAssertionId,
        isBilateral: exercise.attributes.isBilateral,
        evaluationComplete: true,
        requiredEquipment: requiredEquipment(exercise),
        clinicalEvaluations,
        explicitExclusions: exclusions.byExercise.get(exercise.exerciseConceptId) ?? [],
        preferences: [
          ...(runPreferences.byExercise.get(exercise.exerciseConceptId) ?? []),
          ...(reviewedPreferences.byExercise.get(exercise.exerciseConceptId) ?? []),
        ],
      });
    }

    const canonicalEquipment = constraints.data.equipment.flatMap((equipment) => {
      const reference = equipment.domainReference;
      return equipment.available && reference.state === "reviewed" && reference.graph === "movement-clinical"
        && reference.stableConceptId.startsWith("equipment:")
        ? [{ equipmentConceptId: reference.stableConceptId, assertionId: equipment.assertionId, evidenceId: equipment.evidenceId }]
        : [];
    });
    const availableEquipment = request.availableEquipmentConceptIds === undefined
      ? canonicalEquipment
      : canonicalEquipment.filter((equipment) => request.availableEquipmentConceptIds!.includes(equipment.equipmentConceptId));
    const policy = classifyCatalogSafety({
      ...revisions,
      authority: handle.authority,
      expectedExerciseConceptIds: catalog.data.map((exercise) => exercise.exerciseConceptId),
      availableEquipment,
      equipmentEvidenceIds: constraints.data.equipment.map((equipment) => equipment.evidenceId),
      candidates,
    });
    if (policy.status !== "ready") {
      const failure = policy as CatalogSafetyFailClosedResult;
      return fail("fail_closed", `catalog-policy-${failure.reason}`, safeEnvelope({ ...revisions, assertionIds: failure.assertionIds, evidenceIds: failure.evidenceIds }));
    }

    const evaluationToken = randomHex(dependencies.tokenSource);
    const sessionRandom = randomHex(dependencies.tokenSource);
    if (!evaluationToken || !sessionRandom || evaluationToken === sessionRandom) {
      return fail("fail_closed", "invalid-token-source", safeEnvelope(revisions));
    }
    const evaluationSessionId = `evaluation-session:${sessionRandom}`;
    const constraintDigest = digestConstraints(request);
    const createdAt = evaluationNow;
    const expiresAt = new Date(Date.parse(createdAt) + CATALOG_SAFETY_SESSION_TTL_MS).toISOString();
    const retainedPolicy = deepFreeze(clone(policy));
    const retained = dependencies.sessions.retain({
      token: evaluationToken,
      evaluationSessionId,
      runId: request.runId,
      claims: { coachId: request.coachId, memberId: request.memberId, authorizationId: request.authorizationId },
      ...revisions,
      constraintDigest,
      result: retainedPolicy,
      createdAt,
      expiresAt,
    }, createdAt);
    if (retained.status !== "stored") {
      return fail(retained.status === "capacity" ? "capacity" : "fail_closed",
        retained.status === "capacity" ? "session-capacity" : "token-collision", safeEnvelope(revisions));
    }
    for (const superseded of retained.superseded) {
      await recordCatalogSafetyAudit(dependencies.securityAudit, {
        kind: "catalog-safety-security",
        statusCode: "session-superseded",
        coachId: request.coachId,
        memberId: request.memberId,
        evaluationSessionId: superseded.evaluationSessionId,
        ...revisions,
        reasonCode: "replacement-evaluation",
        assertionIds: [],
        evidenceIds: [],
      });
    }
    const publicPolicy = clone(policy);
    return {
      status: "ready",
      evaluationToken,
      evaluationSessionId,
      constraintDigest,
      expiresAt,
      ...revisions,
      decisions: publicPolicy.decisions,
      excluded: publicPolicy.excluded,
      caution: publicPolicy.caution,
      downranked: publicPolicy.downranked,
      allowed: publicPolicy.allowed,
      zeroMatchEvidenceIds: [...new Set([
        ...exclusions.zeroMatchEvidenceIds,
        ...runPreferences.zeroMatchEvidenceIds,
        ...reviewedPreferences.zeroMatchEvidenceIds,
      ])].sort(),
    };
  };
}
