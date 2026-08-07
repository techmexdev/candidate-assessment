import { createHash } from "node:crypto";
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
import type { MovementGraphReadHandle } from "../../domain/contracts/movement-clinical-queries";
import type { MovementLaterality } from "../../domain/contracts/movement-safety";
import { classifyCatalogSafety } from "../../domain/policies/catalog-safety";
import type {
  CatalogSafetySessionStore,
  CatalogSafetyTokenSource,
} from "../ports/catalog-safety-sessions";
import { CATALOG_SAFETY_SESSION_TTL_MS } from "../ports/catalog-safety-sessions";
import type { CatalogSafetyGraphBoundary } from "../ports/graph-repositories";
import type { CatalogSafetySecurityAudit } from "../ports/security-audit";
import { recordCatalogSafetyAudit } from "../ports/security-audit";
import { evaluateMovementSafetyFactsWithHandle } from "./evaluate-movement-safety";
import { createRetrieveMemberContext } from "./retrieve-member-context";

export type CatalogSafetyResolutionProof = {
  readonly resolverId: string;
  readonly movementGraphRevisionId: string;
  readonly policyRevision: string;
  readonly maxDepth: number;
  readonly maxResults: number;
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
};

const safeEnvelope = (overrides: Partial<EvaluationEnvelope> = {}): EvaluationEnvelope => ({
  assertionIds: [],
  evidenceIds: [],
  ...overrides,
});

function validResolution(proof: CatalogSafetyResolutionProof, revisionId: string) {
  return proof.movementGraphRevisionId === revisionId
    && proof.resolverId.length > 0
    && proof.policyRevision.length > 0
    && Number.isInteger(proof.maxDepth)
    && proof.maxDepth > 0
    && proof.maxDepth <= CATALOG_SAFETY_MAX_FAMILY_DEPTH
    && Number.isInteger(proof.maxResults)
    && proof.maxResults > 0
    && proof.maxResults <= CATALOG_SAFETY_MAX_EXERCISES;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestConstraints(request: EvaluateCatalogSafetyRequest) {
  const authority = {
    runId: request.runId,
    injuryApplicability: request.injuryApplicability,
    explicitExclusions: request.explicitExclusions,
    preferences: request.preferences,
  };
  return `sha256:${createHash("sha256").update(stableJson(authority)).digest("hex")}`;
}

function randomHex(source: CatalogSafetyTokenSource) {
  const bytes = source.randomBytes(16);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 16) return undefined;
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function resolveMatches(
  handle: MovementGraphReadHandle,
  matches: readonly CatalogSafetyResolvedMatch[],
  kind: "explicit" | "preference",
): Promise<{
  readonly status: "ready";
  readonly byExercise: ReadonlyMap<string, readonly (CatalogExplicitExclusionInput | CatalogPreferenceInput)[]>;
  readonly zeroMatchEvidenceIds: readonly string[];
} | { readonly status: "clarification_required" | "fail_closed"; readonly reasonCode: string }> {
  const byExercise = new Map<string, (CatalogExplicitExclusionInput | CatalogPreferenceInput)[]>();
  const zeroMatchEvidenceIds: string[] = [];
  for (const match of matches) {
    if (!match.evidenceId || !validResolution(match.resolution, handle.graphRevisionId)
      || match.conceptId.split(":", 1)[0] !== match.conceptKind
      || (kind === "preference" && (!Number.isInteger(match.rankPenalty) || match.rankPenalty! < 0))) {
      return { status: "clarification_required", reasonCode: "constraint-re-resolution-required" };
    }
    const resolved = await handle.getCatalogFamilyFacts({
      conceptId: match.conceptId,
      conceptKind: match.conceptKind,
      maxDepth: match.resolution.maxDepth,
      maxResults: match.resolution.maxResults,
    });
    if (match.zeroMatchAttested) {
      if (!match.emptyResultAttestationId || resolved.status === "ok"
        || (resolved.status === "failed" && resolved.failure.code !== "unresolved_concept")) {
        return { status: "clarification_required", reasonCode: "zero-match-re-resolution-required" };
      }
      zeroMatchEvidenceIds.push(match.evidenceId, match.emptyResultAttestationId);
      continue;
    }
    if (resolved.status !== "ok") {
      return { status: resolved.failure.code === "unresolved_concept" ? "clarification_required" : "fail_closed", reasonCode: "constraint-re-resolution-required" };
    }
    for (const fact of resolved.data) {
      const contribution = kind === "explicit"
        ? {
            matchKind: fact.matchKind,
            resolvedConceptId: match.conceptId,
            evidenceId: match.evidenceId,
            assertionIds: fact.pathAssertionIds,
          } satisfies CatalogExplicitExclusionInput
        : {
            matchKind: fact.matchKind,
            resolvedConceptId: match.conceptId,
            evidenceId: match.evidenceId,
            rankPenalty: match.rankPenalty!,
            assertionIds: fact.pathAssertionIds,
          } satisfies CatalogPreferenceInput;
      byExercise.set(fact.exerciseConceptId, [...(byExercise.get(fact.exerciseConceptId) ?? []), contribution]);
    }
  }
  return { status: "ready", byExercise, zeroMatchEvidenceIds: [...new Set(zeroMatchEvidenceIds)].sort() };
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
  evidenceByCondition: ReadonlyMap<string, { readonly assertionId: string; readonly evidenceId: string }>,
) {
  return safety.contributingPaths.map((path) => {
    const source = evidenceByCondition.get(`${path.conditionConceptId}\0${path.affectedAnatomyConceptId}`)!;
    return {
      kind: "clinical" as const,
      conditionConceptId: path.conditionConceptId,
      conditionAssertionId: source.assertionId,
      conditionEvidenceId: source.evidenceId,
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
    };
  });
}

function requiredEquipment(candidate: { readonly relations: readonly { readonly kind: string; readonly targetConceptId: string; readonly targetAssertionId: string; readonly edgeAssertionId: string }[] }) {
  return candidate.relations.filter((relation) => relation.kind === "requires").map((relation) => ({
    equipmentConceptId: relation.targetConceptId,
    equipmentAssertionId: relation.targetAssertionId,
    requiresAssertionId: relation.edgeAssertionId,
  }));
}

function isPreferenceInput(
  item: CatalogExplicitExclusionInput | CatalogPreferenceInput,
): item is CatalogPreferenceInput {
  return "rankPenalty" in item && typeof item.rankPenalty === "number";
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

    if (!request.coachId || !request.memberId || !request.authorizationId || !request.runId) {
      return fail("fail_closed", "invalid-request");
    }
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
    const exclusions = await resolveMatches(handle, request.explicitExclusions, "explicit");
    if (exclusions.status !== "ready") return fail(exclusions.status, exclusions.reasonCode, safeEnvelope(revisions));
    const runPreferences = await resolveMatches(handle, request.preferences, "preference");
    if (runPreferences.status !== "ready") return fail(runPreferences.status, runPreferences.reasonCode, safeEnvelope(revisions));

    const memberPreferences: CatalogSafetyResolvedMatch[] = constraints.data.preferences.flatMap((preference) => (
      reviewedMovementIds(preference.domainReferences).flatMap((conceptId) => (
        conceptId.startsWith("exercise:") || conceptId.startsWith("movement-pattern:") ? [{
          conceptId: conceptId as CatalogSafetyResolvedMatch["conceptId"],
          conceptKind: conceptId.startsWith("exercise:") ? "exercise" as const : "movement-pattern" as const,
          evidenceId: preference.evidenceId,
          rankPenalty: 1,
          resolution: {
            resolverId: "member-context-reviewed-reference",
            movementGraphRevisionId: handle.graphRevisionId,
            policyRevision: "reviewed-reference:v1",
            maxDepth: CATALOG_SAFETY_MAX_FAMILY_DEPTH,
            maxResults: CATALOG_SAFETY_MAX_EXERCISES,
          },
        }] : []
      ))
    ));
    const reviewedPreferences = await resolveMatches(handle, memberPreferences, "preference");
    if (reviewedPreferences.status !== "ready") return fail("fail_closed", reviewedPreferences.reasonCode, safeEnvelope(revisions));

    const contexts = [];
    const evidenceByCondition = new Map<string, { assertionId: string; evidenceId: string }>();
    for (const injury of constraints.data.injuries) {
      const applicability = findApplicability(request, injury);
      if (!applicability || !validResolution(applicability.resolution, handle.graphRevisionId)
        || !applicability.conditionStatus || !applicability.recoveryStage || !applicability.severityBand) {
        return fail("clarification_required", "injury-applicability-required", safeEnvelope(revisions));
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
      });
      evidenceByCondition.set(`${applicability.conditionConceptId}\0${applicability.affectedAnatomyConceptId}`, {
        assertionId: injury.assertionId,
        evidenceId: applicability.evidenceId,
      });
    }

    const candidates: CatalogSafetyCandidateInput[] = [];
    for (const exercise of catalog.data) {
      const safety = await evaluateMovementSafetyFactsWithHandle(handle, {
        graphRevisionId: handle.graphRevisionId,
        exerciseConceptId: exercise.exerciseConceptId,
        conditions: contexts,
      }, exercise);
      if (safety.status === "fail_closed") {
        return fail("fail_closed", `movement-safety-${safety.reason}`, safeEnvelope({ ...revisions, assertionIds: safety.assertionIds, evidenceIds: [] }));
      }
      candidates.push({
        ...revisions,
        exerciseConceptId: exercise.exerciseConceptId,
        exerciseAssertionId: exercise.exerciseAssertionId,
        isBilateral: exercise.attributes.isBilateral,
        evaluationComplete: true,
        requiredEquipment: requiredEquipment(exercise),
        clinicalEvaluations: clinicalInputs(safety, evidenceByCondition),
        explicitExclusions: (exclusions.byExercise.get(exercise.exerciseConceptId) ?? [])
          .filter((item): item is CatalogExplicitExclusionInput => !isPreferenceInput(item)),
        preferences: [
          ...(runPreferences.byExercise.get(exercise.exerciseConceptId) ?? []),
          ...(reviewedPreferences.byExercise.get(exercise.exerciseConceptId) ?? []),
        ].filter(isPreferenceInput),
      });
    }

    const availableEquipment = constraints.data.equipment.flatMap((equipment) => {
      const reference = equipment.domainReference;
      return equipment.available && reference.state === "reviewed" && reference.graph === "movement-clinical"
        && reference.stableConceptId.startsWith("equipment:")
        ? [{ equipmentConceptId: reference.stableConceptId, assertionId: equipment.assertionId, evidenceId: equipment.evidenceId }]
        : [];
    });
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
    const createdAt = dependencies.now();
    const expiresAt = new Date(Date.parse(createdAt) + CATALOG_SAFETY_SESSION_TTL_MS).toISOString();
    const retained = dependencies.sessions.retain({
      token: evaluationToken,
      evaluationSessionId,
      runId: request.runId,
      claims: { coachId: request.coachId, memberId: request.memberId, authorizationId: request.authorizationId },
      ...revisions,
      constraintDigest,
      result: policy,
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
    return {
      status: "ready",
      evaluationToken,
      evaluationSessionId,
      constraintDigest,
      expiresAt,
      ...revisions,
      decisions: policy.decisions,
      excluded: policy.excluded,
      caution: policy.caution,
      downranked: policy.downranked,
      allowed: policy.allowed,
      zeroMatchEvidenceIds: [...new Set([...exclusions.zeroMatchEvidenceIds, ...runPreferences.zeroMatchEvidenceIds])].sort(),
    };
  };
}
