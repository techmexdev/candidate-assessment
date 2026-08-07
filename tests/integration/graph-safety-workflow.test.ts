import { describe, expect, it, vi } from "vitest";
import { InMemoryCatalogSafetySessionStore } from "../../src/application/ports/catalog-safety-sessions";
import {
  CATALOG_SAFETY_MAX_PREFERENCES,
  createEvaluateCatalogSafety,
  type CatalogSafetyResolutionCertificateVerifier,
} from "../../src/application/use-cases/evaluate-catalog-safety";
import { createValidateWorkoutCandidates } from "../../src/application/use-cases/validate-workout-candidates";
import type {
  MemberContextQueryResult,
  MemberContextReadHandle,
  MemberContextReadProvider,
  WorkoutConstraintsProjection,
} from "../../src/domain/contracts/member-context-queries";
import type {
  MovementGraphReadHandle,
  MovementGraphReadProvider,
} from "../../src/domain/contracts/movement-clinical-queries";
import { compileDefaultMovementGraph } from "../../src/graph/ingest/movement-clinical";
import { InMemoryMovementGraphReadProvider } from "../../src/graph/repositories/movement-graph";

const NOW = "2026-08-06T12:00:00.000Z";
const MEMBER_REVISION = "member-revision:integration";

function certificate(certificateId: string) {
  return { certificateId };
}

function syntheticCertificates(
  accepted: ReadonlySet<string> = new Set([
    "certificate:injury",
    "certificate:explicit",
    "certificate:empty",
    "certificate:preference",
  ]),
): CatalogSafetyResolutionCertificateVerifier {
  return {
    trustedIssuerId: "synthetic-test-resolver",
    verify: async (request) => accepted.has(request.certificateId) ? {
      status: "verified",
      claims: {
        ...request,
        issuerId: "synthetic-test-resolver",
        policyRevision: "synthetic-policy:v1",
        maxDepth: 4,
        maxResults: 100,
        issuedAt: "2026-08-06T11:55:00.000Z",
        expiresAt: "2026-08-06T12:05:00.000Z",
      },
    } : { status: "invalid" },
  };
}

function compiledMovement() {
  const compiled = compileDefaultMovementGraph();
  if (compiled.status !== "valid") throw new Error(JSON.stringify(compiled.report));
  return compiled.snapshot;
}

function readyConstraints(
  overrides: Partial<WorkoutConstraintsProjection> = {},
): MemberContextQueryResult<WorkoutConstraintsProjection> {
  const source = { locator: "synthetic://member", artifactDigest: "sha256:synthetic" };
  const temporal = { precision: "date" as const, effectiveOn: "2026-08-06" };
  return {
    status: "ready",
    memberId: "member:1",
    contextRevisionId: MEMBER_REVISION,
    authority: "canonical",
    evidenceIds: ["assertion:equipment", "assertion:injury", "assertion:preference"],
    data: {
      equipment: [{
        kind: "equipment-availability",
        evidenceId: "evidence:equipment",
        semanticId: "equipment-availability:1",
        assertionId: "assertion:equipment",
        source,
        classification: "source-statement",
        temporal,
        originalLabel: "Dumbbell",
        available: true,
        domainReference: {
          state: "reviewed",
          graph: "movement-clinical",
          stableConceptId: "equipment:dumbbell",
          reviewedBy: "reviewer:1",
          reviewedAt: NOW,
          sourceArtifactDigest: "sha256:synthetic",
        },
      }],
      injuries: [{
        kind: "injury-episode",
        evidenceId: "evidence:injury",
        semanticId: "injury:1",
        assertionId: "assertion:injury",
        source,
        classification: "source-statement",
        temporal,
        region: "redacted test value",
        joint: "redacted test value",
        status: "redacted test value",
        severity: "redacted test value",
        since: "2026-07-01",
        notes: "must-never-leak",
        domainReferences: [{
          state: "reviewed",
          graph: "movement-clinical",
          stableConceptId: "condition:patellofemoral-pain-syndrome",
          reviewedBy: "reviewer:1",
          reviewedAt: NOW,
          sourceArtifactDigest: "sha256:synthetic",
        }, {
          state: "reviewed",
          graph: "movement-clinical",
          stableConceptId: "joint:knee",
          reviewedBy: "reviewer:1",
          reviewedAt: NOW,
          sourceArtifactDigest: "sha256:synthetic",
        }],
      }],
      preferences: [{
        kind: "preference",
        evidenceId: "evidence:preference",
        semanticId: "preference:1",
        assertionId: "assertion:preference",
        source,
        classification: "source-statement",
        temporal,
        preferredSessionMinutes: 30,
        trainingDaysPerWeek: 3,
        preferredDays: ["Monday"],
        dislikes: ["must-never-leak"],
        notes: "must-never-leak",
        domainReferences: [],
      }],
      ...overrides,
    },
  };
}

function memberProvider(
  constraints: MemberContextQueryResult<WorkoutConstraintsProjection> = readyConstraints(),
): MemberContextReadProvider {
  const empty = async (): Promise<MemberContextQueryResult<never>> => ({
    status: "empty",
    memberId: "member:1",
    contextRevisionId: MEMBER_REVISION,
    authority: "canonical",
    evidenceIds: [],
    message: "Unavailable.",
  });
  const handle: MemberContextReadHandle = {
    memberId: "member:1",
    coachId: "coach:1",
    contextRevisionId: MEMBER_REVISION,
    authority: "canonical",
    getSummary: empty,
    getEvidence: empty,
    getLongitudinalSeries: empty,
    getConversation: empty,
    getCoachBrief: empty,
    getWorkoutConstraints: async () => constraints,
    getRelatedEvidence: empty,
    getCitations: empty,
  };
  return {
    openActive: async () => ({ status: "ready", handle }),
    openRevision: async (_scope, revisionId) => revisionId === MEMBER_REVISION
      ? { status: "ready", handle }
      : { status: "stale", requestedRevisionId: revisionId, activeRevisionId: MEMBER_REVISION },
  };
}

function movementProvider(
  snapshot: ReturnType<typeof compiledMovement>,
  mapHandle: (handle: MovementGraphReadHandle) => MovementGraphReadHandle = (handle) => handle,
): MovementGraphReadProvider {
  const base = new InMemoryMovementGraphReadProvider([snapshot], { authority: "canonical" });
  const open = async (result: Awaited<ReturnType<MovementGraphReadProvider["openActive"]>>) => (
    result.status === "ready" ? { status: "ready" as const, handle: mapHandle(result.handle) } : result
  );
  return {
    openActive: async () => open(await base.openActive()),
    openRevision: async (revisionId) => open(await base.openRevision(revisionId)),
  };
}

function overrideHandle(
  handle: MovementGraphReadHandle,
  overrides: Partial<MovementGraphReadHandle>,
): MovementGraphReadHandle {
  return Object.assign(Object.create(Object.getPrototypeOf(handle)), handle, overrides) as MovementGraphReadHandle;
}

function baseRequest(graphRevisionId: string) {
  return {
    coachId: "coach:1",
    memberId: "member:1",
    authorizationId: "grant:1",
    runId: "run:test",
    memberContextRevisionId: MEMBER_REVISION,
    movementGraphRevisionId: graphRevisionId,
    injuryApplicability: [],
    explicitExclusions: [],
    preferences: [],
  };
}

describe("cross-graph catalog safety workflow", () => {
  it("authorizes and pins both graphs before returning a complete retained result", async () => {
    const movementSnapshot = compiledMovement();
    const audit = vi.fn(async () => undefined);
    let randomValue = 1;
    const evaluate = createEvaluateCatalogSafety({
      movement: new InMemoryMovementGraphReadProvider([movementSnapshot], { authority: "canonical" }),
      memberContext: memberProvider(),
      authorizeMemberContext: ({ authorizationId }) => authorizationId === "grant:1",
      sessions: new InMemoryCatalogSafetySessionStore(),
      tokenSource: { randomBytes: (length) => new Uint8Array(length).fill(randomValue++) },
      now: () => NOW,
      securityAudit: { record: audit },
      resolutionCertificates: syntheticCertificates(),
    });

    const result = await evaluate({
      coachId: "coach:1",
      memberId: "member:1",
      authorizationId: "grant:1",
      runId: "run:1",
      memberContextRevisionId: MEMBER_REVISION,
      movementGraphRevisionId: movementSnapshot.graphRevisionId,
      injuryApplicability: [{
        memberEvidenceId: "evidence:injury",
        conditionConceptId: "condition:patellofemoral-pain-syndrome",
        affectedAnatomyConceptId: "joint:knee",
        conditionStatus: "active",
        recoveryStage: "return-to-training",
        severityBand: "moderate",
        affectedLaterality: "unknown",
        evidenceId: "evidence:run-applicability",
        resolution: certificate("certificate:injury"),
      }],
      explicitExclusions: [{
        conceptId: "exercise:00cc383b-f156-4b23-952a-15340100c261",
        conceptKind: "exercise",
        evidenceId: "evidence:explicit-exclusion",
        resolution: certificate("certificate:explicit"),
      }, {
        conceptId: "exercise:certified-absent",
        conceptKind: "exercise",
        evidenceId: "evidence:zero-match",
        zeroMatchAttested: true,
        emptyResultAttestationId: "attestation:empty-search",
        resolution: certificate("certificate:empty"),
      }],
      preferences: [{
        conceptId: "movement-pattern:lower-push-split-squat",
        conceptKind: "movement-pattern",
        evidenceId: "evidence:preference-run",
        rankPenalty: 2,
        resolution: certificate("certificate:preference"),
      }],
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.movementGraphRevisionId).toBe(movementSnapshot.graphRevisionId);
    expect(result.memberContextRevisionId).toBe(MEMBER_REVISION);
    expect(result.decisions).toHaveLength(50);
    expect(result.evaluationToken).toMatch(/^[0-9a-f]{32}$/);
    expect(result.evaluationSessionId).toMatch(/^evaluation-session:[0-9a-f]{32}$/);
    expect(result.zeroMatchEvidenceIds).toEqual(["attestation:empty-search", "evidence:zero-match"]);
    expect(result.decisions.some((item) => item.contributions.some((contribution) => contribution.kind === "explicit-exclusion"))).toBe(true);
    expect(result.decisions.some((item) => item.contributions.some((contribution) => contribution.kind === "preference"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("must-never-leak");
    expect(audit).not.toHaveBeenCalled();
  });

  it("rejects unverified certificates and over-cap or duplicate run constraints before graph traversal", async () => {
    const movementSnapshot = compiledMovement();
    const audit = vi.fn(async () => undefined);
    const familyRead = vi.fn();
    const provider = movementProvider(movementSnapshot, (handle) => overrideHandle(handle, {
      getCatalogFamilyFacts: async (query) => {
        familyRead(query);
        return handle.getCatalogFamilyFacts(query);
      },
    }));
    const evaluate = createEvaluateCatalogSafety({
      movement: provider,
      memberContext: memberProvider(readyConstraints({ injuries: [] })),
      authorizeMemberContext: () => true,
      sessions: new InMemoryCatalogSafetySessionStore(),
      tokenSource: { randomBytes: (length) => new Uint8Array(length).fill(2) },
      now: () => NOW,
      securityAudit: { record: audit },
      resolutionCertificates: syntheticCertificates(new Set()),
    });
    const unverified = {
      conceptId: "exercise:not-trusted" as const,
      conceptKind: "exercise" as const,
      evidenceId: "evidence:untrusted",
      resolution: certificate("certificate:caller-made"),
    };

    await expect(evaluate({ ...baseRequest(movementSnapshot.graphRevisionId), explicitExclusions: [unverified] }))
      .resolves.toMatchObject({ status: "clarification_required", reasonCode: "constraint-re-resolution-required" });
    expect(familyRead).not.toHaveBeenCalled();

    const forgedClaims = createEvaluateCatalogSafety({
      movement: provider,
      memberContext: memberProvider(readyConstraints({ injuries: [] })),
      authorizeMemberContext: () => true,
      sessions: new InMemoryCatalogSafetySessionStore(),
      tokenSource: { randomBytes: (length) => new Uint8Array(length).fill(2) },
      now: () => NOW,
      securityAudit: { record: audit },
      resolutionCertificates: {
        trustedIssuerId: "synthetic-test-resolver",
        verify: async (request) => ({
          status: "verified",
          claims: {
            ...request,
            payloadDigest: "sha256:forged-payload",
            issuerId: "synthetic-test-resolver",
            policyRevision: "synthetic-policy:v1",
            maxDepth: 4,
            maxResults: 100,
            issuedAt: "2026-08-06T11:55:00.000Z",
            expiresAt: "2026-08-06T12:05:00.000Z",
          },
        }),
      },
    });
    await expect(forgedClaims({ ...baseRequest(movementSnapshot.graphRevisionId), explicitExclusions: [unverified] }))
      .resolves.toMatchObject({ status: "clarification_required", reasonCode: "constraint-re-resolution-required" });
    expect(familyRead).not.toHaveBeenCalled();

    const overflow = Array.from({ length: CATALOG_SAFETY_MAX_PREFERENCES + 1 }, (_, index) => ({
      conceptId: `exercise:${index}` as `exercise:${string}`,
      conceptKind: "exercise" as const,
      evidenceId: `evidence:${index}`,
      rankPenalty: 1,
      resolution: certificate(`certificate:${index}`),
    }));
    await expect(evaluate({ ...baseRequest(movementSnapshot.graphRevisionId), preferences: overflow }))
      .resolves.toMatchObject({ status: "fail_closed", reasonCode: "constraint-limit-exceeded" });
    await expect(evaluate({ ...baseRequest(movementSnapshot.graphRevisionId), explicitExclusions: [unverified, unverified] }))
      .resolves.toMatchObject({ status: "fail_closed", reasonCode: "duplicate-constraints" });
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it("memoizes repeated family reads while preserving distinct exclusion and preference evidence", async () => {
    const movementSnapshot = compiledMovement();
    const familyRead = vi.fn();
    const provider = movementProvider(movementSnapshot, (handle) => overrideHandle(handle, {
      getCatalogFamilyFacts: async (query) => {
        familyRead(query);
        return handle.getCatalogFamilyFacts(query);
      },
    }));
    let randomValue = 3;
    const evaluate = createEvaluateCatalogSafety({
      movement: provider,
      memberContext: memberProvider(readyConstraints({ injuries: [], preferences: [] })),
      authorizeMemberContext: () => true,
      sessions: new InMemoryCatalogSafetySessionStore(),
      tokenSource: { randomBytes: (length) => new Uint8Array(length).fill(randomValue++) },
      now: () => NOW,
      securityAudit: { record: vi.fn(async () => undefined) },
      resolutionCertificates: syntheticCertificates(new Set(["certificate:explicit", "certificate:preference"])),
    });
    const conceptId = "exercise:00cc383b-f156-4b23-952a-15340100c261" as const;
    const result = await evaluate({
      ...baseRequest(movementSnapshot.graphRevisionId),
      explicitExclusions: [{
        conceptId,
        conceptKind: "exercise",
        evidenceId: "evidence:exclude",
        resolution: certificate("certificate:explicit"),
      }],
      preferences: [{
        conceptId,
        conceptKind: "exercise",
        evidenceId: "evidence:prefer",
        rankPenalty: 2,
        resolution: certificate("certificate:preference"),
      }],
    });

    expect(result.status).toBe("ready");
    expect(familyRead).toHaveBeenCalledOnce();
    if (result.status !== "ready") return;
    const decision = result.decisions.find((item) => item.exerciseConceptId === conceptId)!;
    expect(decision.evidenceIds).toEqual(expect.arrayContaining(["evidence:exclude", "evidence:prefer"]));
  });

  it("fails closed and audits when a zero-match attestation encounters a graph outage", async () => {
    const movementSnapshot = compiledMovement();
    const audit = vi.fn(async () => undefined);
    const provider = movementProvider(movementSnapshot, (handle) => overrideHandle(handle, {
      getCatalogFamilyFacts: async () => ({
        status: "failed",
        graphRevisionId: handle.graphRevisionId,
        authority: handle.authority,
        failure: { code: "graph_unavailable", message: "synthetic outage" },
      }),
    }));
    const evaluate = createEvaluateCatalogSafety({
      movement: provider,
      memberContext: memberProvider(readyConstraints({ injuries: [], preferences: [] })),
      authorizeMemberContext: () => true,
      sessions: new InMemoryCatalogSafetySessionStore(),
      tokenSource: { randomBytes: (length) => new Uint8Array(length).fill(4) },
      now: () => NOW,
      securityAudit: { record: audit },
      resolutionCertificates: syntheticCertificates(new Set(["certificate:empty"])),
    });
    const result = await evaluate({
      ...baseRequest(movementSnapshot.graphRevisionId),
      explicitExclusions: [{
        conceptId: "exercise:missing",
        conceptKind: "exercise",
        evidenceId: "evidence:empty",
        zeroMatchAttested: true,
        emptyResultAttestationId: "attestation:empty",
        resolution: certificate("certificate:empty"),
      }],
    });

    expect(result).toMatchObject({ status: "fail_closed", reasonCode: "constraint-graph-unavailable" });
    expect(audit).toHaveBeenCalledOnce();
  });

  it("retains a frozen result that cannot be changed through the returned response", async () => {
    const movementSnapshot = compiledMovement();
    const sessions = new InMemoryCatalogSafetySessionStore();
    let randomValue = 5;
    const evaluate = createEvaluateCatalogSafety({
      movement: movementProvider(movementSnapshot),
      memberContext: memberProvider(readyConstraints({ injuries: [], preferences: [] })),
      authorizeMemberContext: () => true,
      sessions,
      tokenSource: { randomBytes: (length) => new Uint8Array(length).fill(randomValue++) },
      now: () => NOW,
      securityAudit: { record: vi.fn(async () => undefined) },
      resolutionCertificates: syntheticCertificates(new Set()),
    });
    const result = await evaluate(baseRequest(movementSnapshot.graphRevisionId));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const candidate = result.decisions.find((item) => item.classification !== "excluded")!;
    (result.decisions as unknown as unknown[]).splice(0);
    (result.allowed as unknown as unknown[]).splice(0);

    const retained = sessions.lookup(result.evaluationToken, NOW);
    expect(retained.status).toBe("found");
    if (retained.status !== "found") return;
    expect(Object.isFrozen(retained.record.result)).toBe(true);
    expect(Object.isFrozen(retained.record.result.decisions)).toBe(true);
    const validate = createValidateWorkoutCandidates({
      sessions,
      authorizeMemberContext: () => true,
      now: () => NOW,
      securityAudit: { record: vi.fn(async () => undefined) },
      trustedBinding: {
        runId: "run:test",
        expectedEvaluationSessionId: result.evaluationSessionId,
        movementGraphRevisionId: result.movementGraphRevisionId,
        memberContextRevisionId: result.memberContextRevisionId,
        constraintDigest: result.constraintDigest,
      },
    });
    await expect(validate({
      coachId: "coach:1",
      memberId: "member:1",
      authorizationId: "grant:1",
      evaluationToken: result.evaluationToken,
      exerciseConceptIds: [candidate.exerciseConceptId],
    })).resolves.toMatchObject({ status: "accepted" });
  });

  it("preserves separate bilateral clinical provenance for repeated injury episodes", async () => {
    const movementSnapshot = compiledMovement();
    const originalConstraints = readyConstraints();
    if (originalConstraints.status !== "ready") throw new Error("synthetic constraints must be ready");
    const firstInjury = originalConstraints.data.injuries[0]!;
    const secondInjury = {
      ...firstInjury,
      evidenceId: "evidence:injury-recurrence",
      semanticId: "injury:recurrence",
      assertionId: "assertion:injury-recurrence",
    };
    let randomValue = 7;
    const evaluate = createEvaluateCatalogSafety({
      movement: movementProvider(movementSnapshot),
      memberContext: memberProvider(readyConstraints({ injuries: [firstInjury, secondInjury], preferences: [] })),
      authorizeMemberContext: () => true,
      sessions: new InMemoryCatalogSafetySessionStore(),
      tokenSource: { randomBytes: (length) => new Uint8Array(length).fill(randomValue++) },
      now: () => NOW,
      securityAudit: { record: vi.fn(async () => undefined) },
      resolutionCertificates: syntheticCertificates(new Set(["certificate:injury-left", "certificate:injury-right"])),
    });
    const applicabilityBase = {
      conditionConceptId: "condition:patellofemoral-pain-syndrome" as const,
      affectedAnatomyConceptId: "joint:knee" as const,
      conditionStatus: "active",
      recoveryStage: "return-to-training",
      severityBand: "moderate",
    };
    const result = await evaluate({
      ...baseRequest(movementSnapshot.graphRevisionId),
      injuryApplicability: [{
        ...applicabilityBase,
        memberEvidenceId: firstInjury.evidenceId,
        affectedLaterality: "left",
        evidenceId: "evidence:applicability-left",
        resolution: certificate("certificate:injury-left"),
      }, {
        ...applicabilityBase,
        memberEvidenceId: secondInjury.evidenceId,
        affectedLaterality: "right",
        evidenceId: "evidence:applicability-right",
        resolution: certificate("certificate:injury-right"),
      }],
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const bilateral = result.decisions.find((decision) => decision.loadedLaterality === "bilateral"
      && decision.contributions.filter((item) => item.kind === "clinical").length >= 2)!;
    const clinicalEvidence = bilateral.contributions
      .filter((item) => item.kind === "clinical")
      .flatMap((item) => item.evidenceIds);
    expect(clinicalEvidence).toEqual(expect.arrayContaining([
      "evidence:applicability-left",
      "evidence:applicability-right",
    ]));
  });

  it("omits an unresolved member-derived preference but fails closed on a real graph failure", async () => {
    const movementSnapshot = compiledMovement();
    const originalConstraints = readyConstraints();
    if (originalConstraints.status !== "ready") throw new Error("synthetic constraints must be ready");
    const preference = {
      ...originalConstraints.data.preferences[0]!,
      evidenceId: "evidence:member-soft-missing",
      assertionId: "assertion:member-soft-missing",
      domainReferences: [{
        state: "reviewed" as const,
        graph: "movement-clinical" as const,
        stableConceptId: "exercise:member-soft-missing" as const,
        reviewedBy: "reviewer:1",
        reviewedAt: NOW,
        sourceArtifactDigest: "sha256:synthetic",
      }],
    };
    const constraints = readyConstraints({ injuries: [], preferences: [preference] });
    const audit = vi.fn(async () => undefined);
    let randomValue = 8;
    const evaluate = createEvaluateCatalogSafety({
      movement: movementProvider(movementSnapshot),
      memberContext: memberProvider(constraints),
      authorizeMemberContext: () => true,
      sessions: new InMemoryCatalogSafetySessionStore(),
      tokenSource: { randomBytes: (length) => new Uint8Array(length).fill(randomValue++) },
      now: () => NOW,
      securityAudit: { record: audit },
      resolutionCertificates: syntheticCertificates(new Set()),
    });
    const result = await evaluate(baseRequest(movementSnapshot.graphRevisionId));
    expect(result).toMatchObject({ status: "ready", zeroMatchEvidenceIds: ["evidence:member-soft-missing"] });
    expect(audit).not.toHaveBeenCalled();

    const unavailable = createEvaluateCatalogSafety({
      movement: movementProvider(movementSnapshot, (handle) => overrideHandle(handle, {
        getCatalogFamilyFacts: async () => ({
          status: "failed",
          graphRevisionId: handle.graphRevisionId,
          authority: handle.authority,
          failure: { code: "graph_unavailable", message: "synthetic outage" },
        }),
      })),
      memberContext: memberProvider(constraints),
      authorizeMemberContext: () => true,
      sessions: new InMemoryCatalogSafetySessionStore(),
      tokenSource: { randomBytes: (length) => new Uint8Array(length).fill(randomValue++) },
      now: () => NOW,
      securityAudit: { record: audit },
      resolutionCertificates: syntheticCertificates(new Set()),
    });
    await expect(unavailable(baseRequest(movementSnapshot.graphRevisionId)))
      .resolves.toMatchObject({ status: "fail_closed", reasonCode: "constraint-re-resolution-required" });
    expect(audit).toHaveBeenCalledOnce();
  });

  it("rejects fixture authority with no candidate payload and exactly one redacted audit", async () => {
    const movementSnapshot = compiledMovement();
    const audit = vi.fn(async () => undefined);
    const evaluate = createEvaluateCatalogSafety({
      movement: new InMemoryMovementGraphReadProvider([movementSnapshot], { authority: "fixture" }),
      memberContext: memberProvider(),
      authorizeMemberContext: () => true,
      sessions: new InMemoryCatalogSafetySessionStore(),
      tokenSource: { randomBytes: (length) => new Uint8Array(length).fill(7) },
      now: () => NOW,
      securityAudit: { record: audit },
      resolutionCertificates: syntheticCertificates(),
    });

    const result = await evaluate({
      coachId: "coach:1",
      memberId: "member:1",
      authorizationId: "grant:1",
      runId: "run:fixture",
      memberContextRevisionId: MEMBER_REVISION,
      movementGraphRevisionId: movementSnapshot.graphRevisionId,
      injuryApplicability: [],
      explicitExclusions: [],
      preferences: [],
    });

    expect(result).toMatchObject({ status: "fail_closed", reasonCode: "non-authoritative-movement-graph" });
    expect(result).not.toHaveProperty("allowed");
    expect(audit).toHaveBeenCalledOnce();
    expect(JSON.stringify(audit.mock.calls)).not.toContain("must-never-leak");
  });

  it("fails closed before graph access when the evaluation clock is invalid", async () => {
    const movementSnapshot = compiledMovement();
    const audit = vi.fn(async () => undefined);
    const evaluate = createEvaluateCatalogSafety({
      movement: new InMemoryMovementGraphReadProvider([movementSnapshot], { authority: "canonical" }),
      memberContext: memberProvider(),
      authorizeMemberContext: () => true,
      sessions: new InMemoryCatalogSafetySessionStore(),
      tokenSource: { randomBytes: (length) => new Uint8Array(length).fill(7) },
      now: () => "not-a-timestamp",
      securityAudit: { record: audit },
      resolutionCertificates: syntheticCertificates(),
    });

    await expect(evaluate(baseRequest(movementSnapshot.graphRevisionId))).resolves.toMatchObject({
      status: "fail_closed",
      reasonCode: "invalid-clock",
    });
    expect(audit).toHaveBeenCalledOnce();
  });
});
