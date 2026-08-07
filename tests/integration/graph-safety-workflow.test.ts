import { describe, expect, it, vi } from "vitest";
import { InMemoryCatalogSafetySessionStore } from "../../src/application/ports/catalog-safety-sessions";
import { createEvaluateCatalogSafety } from "../../src/application/use-cases/evaluate-catalog-safety";
import type {
  MemberContextQueryResult,
  MemberContextReadHandle,
  MemberContextReadProvider,
  WorkoutConstraintsProjection,
} from "../../src/domain/contracts/member-context-queries";
import { compileDefaultMovementGraph } from "../../src/graph/ingest/movement-clinical";
import { InMemoryMovementGraphReadProvider } from "../../src/graph/repositories/movement-graph";

const NOW = "2026-08-06T12:00:00.000Z";
const MEMBER_REVISION = "member-revision:integration";

function compiledMovement() {
  const compiled = compileDefaultMovementGraph();
  if (compiled.status !== "valid") throw new Error(JSON.stringify(compiled.report));
  return compiled.snapshot;
}

function readyConstraints(): MemberContextQueryResult<WorkoutConstraintsProjection> {
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
    },
  };
}

function memberProvider(): MemberContextReadProvider {
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
    getWorkoutConstraints: async () => readyConstraints(),
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
        resolution: {
          resolverId: "resolver:server",
          movementGraphRevisionId: movementSnapshot.graphRevisionId,
          policyRevision: "resolver-policy:v1",
          maxDepth: 4,
          maxResults: 100,
        },
      }],
      explicitExclusions: [{
        conceptId: "exercise:00cc383b-f156-4b23-952a-15340100c261",
        conceptKind: "exercise",
        evidenceId: "evidence:explicit-exclusion",
        resolution: {
          resolverId: "resolver:server",
          movementGraphRevisionId: movementSnapshot.graphRevisionId,
          policyRevision: "resolver-policy:v1",
          maxDepth: 4,
          maxResults: 100,
        },
      }, {
        conceptId: "exercise:certified-absent",
        conceptKind: "exercise",
        evidenceId: "evidence:zero-match",
        zeroMatchAttested: true,
        emptyResultAttestationId: "attestation:empty-search",
        resolution: {
          resolverId: "resolver:server",
          movementGraphRevisionId: movementSnapshot.graphRevisionId,
          policyRevision: "resolver-policy:v1",
          maxDepth: 4,
          maxResults: 100,
        },
      }],
      preferences: [{
        conceptId: "movement-pattern:lower-push-split-squat",
        conceptKind: "movement-pattern",
        evidenceId: "evidence:preference-run",
        rankPenalty: 2,
        resolution: {
          resolverId: "resolver:server",
          movementGraphRevisionId: movementSnapshot.graphRevisionId,
          policyRevision: "resolver-policy:v1",
          maxDepth: 4,
          maxResults: 100,
        },
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
});
