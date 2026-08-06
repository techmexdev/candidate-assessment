import { describe, expect, expectTypeOf, it } from "vitest";
import {
  MEMBER_CONTEXT_NODE_KINDS,
  MEMBER_CONTEXT_RELATIONSHIP_KINDS,
  type DomainConceptReference,
  type MemberContextGraphNode,
  type MemberContextGraphRelationship,
  type MemberContextRevisionScopedNode,
  type MovementClinicalStableConceptId,
} from "../../src/domain/contracts/member-context";
import type {
  MemberContextQueryResult,
  MemberContextReadHandle,
  MemberContextReadProvider,
} from "../../src/domain/contracts/member-context-queries";
import type { MemberContextPublisher } from "../../src/domain/contracts/member-context-publication";
import {
  MEMBER_CONTEXT_RELATIONSHIP_ENDPOINTS,
  type MemberContextRelationshipEndpoint,
} from "../../src/graph/schema/member-context-schema";
import type { GraphRepositories } from "../../src/application/ports/graph-repositories";

type IfEquals<X, Y, Yes = X, No = never> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? Yes : No;
type WritableKeys<T> = {
  [Key in keyof T]-?: IfEquals<{ [P in Key]: T[Key] }, { -readonly [P in Key]: T[Key] }, Key>;
}[keyof T];

describe("Member Context graph contract", () => {
  it("exposes the complete typed node and relationship vocabulary", () => {
    expect(MEMBER_CONTEXT_NODE_KINDS).toEqual([
      "member",
      "coach",
      "member-profile",
      "goal",
      "preference",
      "equipment-availability",
      "injury-episode",
      "workout-session",
      "exercise-mention",
      "observation",
      "lab-panel",
      "conversation",
      "message",
      "media-attachment",
      "coach-brief",
      "coach-task",
      "churn-assessment",
      "churn-reason",
      "source-artifact",
      "member-context-revision",
      "ingestion-activity",
      "publication-attempt",
      "revision-seal",
      "member-context-catalog",
      "activation-event",
    ]);
    expect(MEMBER_CONTEXT_RELATIONSHIP_KINDS).toEqual([
      "COACHES",
      "HAS_PROFILE",
      "PURSUES",
      "HAS_PREFERENCE",
      "HAS_EQUIPMENT",
      "HAS_INJURY",
      "HAS_WORKOUT",
      "MENTIONS_EXERCISE",
      "HAS_OBSERVATION",
      "HAS_PANEL",
      "CONTAINS_MEASUREMENT",
      "HAS_CONVERSATION",
      "CONTAINS_MESSAGE",
      "SENT_BY",
      "HAS_ATTACHMENT",
      "HAS_BRIEF",
      "HAS_TASK",
      "HAS_ASSESSMENT",
      "HAS_REASON",
      "SUPPORTED_BY",
      "WAS_DERIVED_FROM",
      "ASSERTS",
      "USED",
      "GENERATED",
      "SEALED",
      "ACTIVATED",
    ]);

    expectTypeOf<MemberContextGraphNode["kind"]>().toEqualTypeOf<(typeof MEMBER_CONTEXT_NODE_KINDS)[number]>();
    expectTypeOf<MemberContextGraphRelationship["kind"]>().toEqualTypeOf<(typeof MEMBER_CONTEXT_RELATIONSHIP_KINDS)[number]>();
    expectTypeOf<MemberContextGraphRelationship["sourceOrder"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<WritableKeys<MemberContextGraphNode>>().toEqualTypeOf<never>();
    expectTypeOf<WritableKeys<MemberContextGraphRelationship>>().toEqualTypeOf<never>();
  });

  it("allowlists endpoint roles for every relationship without a generic escape hatch", () => {
    expect(Object.keys(MEMBER_CONTEXT_RELATIONSHIP_ENDPOINTS)).toEqual(MEMBER_CONTEXT_RELATIONSHIP_KINDS);
    expect(MEMBER_CONTEXT_RELATIONSHIP_ENDPOINTS.COACHES).toEqual({ from: ["coach"], to: ["member"] });
    expect(MEMBER_CONTEXT_RELATIONSHIP_ENDPOINTS.MENTIONS_EXERCISE).toEqual({
      from: ["workout-session"],
      to: ["exercise-mention"],
    });
    expect(MEMBER_CONTEXT_RELATIONSHIP_ENDPOINTS.SENT_BY).toEqual({
      from: ["message"],
      to: ["member", "coach"],
    });
    expect(MEMBER_CONTEXT_RELATIONSHIP_ENDPOINTS.USED).toEqual({
      from: ["ingestion-activity"],
      to: ["source-artifact"],
    });
    expectTypeOf<keyof typeof MEMBER_CONTEXT_RELATIONSHIP_ENDPOINTS>().toEqualTypeOf<MemberContextGraphRelationship["kind"]>();
    expectTypeOf<MemberContextRelationshipEndpoint["from"]>().not.toEqualTypeOf<string>();
    expectTypeOf<MemberContextRelationshipEndpoint["to"]>().not.toEqualTypeOf<string>();
  });

  it("requires immutable assertion, provenance, revision, classification, time, and synthetic metadata", () => {
    const observation = {
      kind: "observation",
      semanticId: "member:jordan:observation:resting-heart-rate",
      assertionId: "assertion:member-context:abc:resting-heart-rate",
      memberId: "member:jordan",
      contextRevisionId: "member-context:sha256:abc",
      source: {
        locator: "/biomarkers/resting_hr_bpm",
        artifactDigest: "sha256:source",
      },
      classification: "observation",
      temporal: { precision: "unknown" },
      synthetic: true,
      metric: "resting-heart-rate",
      value: 58,
      unit: "beats/minute",
      sourceOrder: 0,
    } as const satisfies MemberContextRevisionScopedNode;

    expect(observation.temporal.precision).toBe("unknown");
    expectTypeOf<MemberContextRevisionScopedNode["semanticId"]>().toEqualTypeOf<string>();
    expectTypeOf<MemberContextRevisionScopedNode["assertionId"]>().toEqualTypeOf<string>();
    expectTypeOf<MemberContextRevisionScopedNode["source"]["locator"]>().toEqualTypeOf<string>();
    expectTypeOf<MemberContextRevisionScopedNode["source"]["artifactDigest"]>().toEqualTypeOf<string>();
    expectTypeOf<MemberContextRevisionScopedNode["synthetic"]>().toEqualTypeOf<boolean>();
    expectTypeOf<WritableKeys<MemberContextRevisionScopedNode>>().toEqualTypeOf<never>();
  });

  it("uses reviewed stable cross-graph IDs or an explicit unresolved state", () => {
    const reviewed = {
      state: "reviewed",
      graph: "movement-clinical",
      stableConceptId: "equipment:dumbbell",
      reviewedBy: "curator:1",
      reviewedAt: "2026-08-06",
      sourceArtifactDigest: "sha256:mapping",
    } as const satisfies DomainConceptReference;
    const unresolved = {
      state: "unresolved",
      originalText: "mystery movement",
      reason: "no-deterministic-match",
    } as const satisfies DomainConceptReference;

    expect(reviewed.stableConceptId).toBe("equipment:dumbbell");
    expect(unresolved.state).toBe("unresolved");
    expectTypeOf<Extract<MovementClinicalStableConceptId, `graph:${string}`>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<DomainConceptReference, { state: "reviewed" }>>().not.toHaveProperty("graphRevisionId");
    expectTypeOf<Extract<DomainConceptReference, { state: "unresolved" }>>().not.toHaveProperty("stableConceptId");
  });

  it("pins bounded async reads to trusted scope and excludes query and publisher authority", async () => {
    const handle: MemberContextReadHandle = {
      memberId: "member:jordan",
      coachId: "coach:casey",
      contextRevisionId: "member-context:sha256:abc",
      authority: "canonical",
      getSummary: async () => ({
        status: "ready",
        memberId: "member:jordan",
        contextRevisionId: "member-context:sha256:abc",
        authority: "canonical",
        evidenceIds: [],
        data: { profileAssertionId: "assertion:profile", goalAssertionIds: [], riskAssessmentAssertionId: null },
      }),
      getEvidence: async () => ({
        status: "empty",
        memberId: "member:jordan",
        contextRevisionId: "member-context:sha256:abc",
        authority: "canonical",
        evidenceIds: [],
        message: "No evidence in the requested domain and window",
      }),
      getLongitudinalSeries: async () => ({
        status: "insufficient-history",
        memberId: "member:jordan",
        contextRevisionId: "member-context:sha256:abc",
        authority: "canonical",
        evidenceIds: [],
        requiredPoints: 2,
        availablePoints: 1,
      }),
      getConversation: async () => ({
        status: "empty",
        memberId: "member:jordan",
        contextRevisionId: "member-context:sha256:abc",
        authority: "canonical",
        evidenceIds: [],
        message: "No messages in the requested window",
      }),
      getCoachBrief: async () => ({
        status: "empty",
        memberId: "member:jordan",
        contextRevisionId: "member-context:sha256:abc",
        authority: "canonical",
        evidenceIds: [],
        message: "No brief for the requested date",
      }),
      getRelatedEvidence: async () => ({
        status: "empty",
        memberId: "member:jordan",
        contextRevisionId: "member-context:sha256:abc",
        authority: "canonical",
        evidenceIds: [],
        message: "No related evidence",
      }),
      getCitations: async () => ({
        status: "ready",
        memberId: "member:jordan",
        contextRevisionId: "member-context:sha256:abc",
        authority: "canonical",
        evidenceIds: [],
        data: [],
      }),
    };

    expect((await handle.getSummary({ limit: 1, timeoutMs: 100 })).status).toBe("ready");
    expect("query" in handle).toBe(false);
    expect("cypher" in handle).toBe(false);
    expect("stage" in handle).toBe(false);
    expect("scope" in handle.getEvidence).toBe(false);
    expectTypeOf<GraphRepositories["memberContext"]>().toEqualTypeOf<MemberContextReadProvider>();
    expectTypeOf<Extract<keyof MemberContextReadHandle, keyof MemberContextPublisher>>().toEqualTypeOf<never>();
    expectTypeOf<Parameters<MemberContextReadHandle["getEvidence"]>[0]>().not.toHaveProperty("cypher");
    expectTypeOf<Parameters<MemberContextReadHandle["getEvidence"]>[0]>().not.toHaveProperty("relationshipType");
    expectTypeOf<Parameters<MemberContextReadHandle["getEvidence"]>[0]>().not.toHaveProperty("coachId");
    expectTypeOf<Parameters<MemberContextReadHandle["getEvidence"]>[0]>().not.toHaveProperty("memberId");
  });

  it("keeps all read result states distinct", () => {
    type Status = MemberContextQueryResult<readonly []>["status"];
    expectTypeOf<Status>().toEqualTypeOf<
      "ready" | "empty" | "insufficient-history" | "stale" | "denied" | "invalid" | "unavailable"
    >();

    const stale = {
      status: "stale",
      memberId: "member:jordan",
      contextRevisionId: "member-context:sha256:old",
      authority: "canonical",
      evidenceIds: [],
      requestedRevisionId: "member-context:sha256:old",
      activeRevisionId: "member-context:sha256:new",
    } satisfies MemberContextQueryResult<readonly []>;
    expect(stale.status).toBe("stale");
  });
});
