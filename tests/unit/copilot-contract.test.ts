import { describe, expect, expectTypeOf, it } from "vitest";
import {
  COPILOT_CANONICAL_INTENT_IDS,
  COPILOT_QUICK_PROMPT_IDS,
  createCopilotAnswerPacket,
  createCopilotPin,
  createSignedCopilotContinuation,
  type CopilotAnswerPacket,
  type CopilotEvidenceAtom,
  type CopilotOutcome,
  type CopilotQuestionInput,
} from "../../src/domain/contracts/copilot";
import {
  decodeCopilotModelCandidate,
  type CopilotModelCandidate,
} from "../../src/application/ports/copilot-model";

type IfEquals<X, Y, Yes = X, No = never> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? Yes : No;
type WritableKeys<T> = {
  [Key in keyof T]-?: IfEquals<{ [P in Key]: T[Key] }, { -readonly [P in Key]: T[Key] }, Key>;
}[keyof T];

const scope = {
  memberId: "mbr_jordan",
  contextRevisionId: "member-context:sha256:r1",
  authority: "canonical",
} as const;

const atom = {
  ...scope,
  atomKind: "fact",
  evidenceId: "assertion:1111111111111111",
  evidenceKind: "observation",
  source: { locator: "/adherence/0", artifactDigest: "sha256:source" },
  classification: "observation",
  temporal: { precision: "date", effectiveOn: "2026-06-02" },
  value: 50,
  unit: "percent",
} as const satisfies CopilotEvidenceAtom;

function packetInput(revision: string = scope.contextRevisionId) {
  const scopedAtom = { ...atom, contextRevisionId: revision };
  const continuation = createSignedCopilotContinuation({
    claims: {
      schemaVersion: "copilot-continuation-claims/v1",
      coachId: "coach_casey",
      memberId: scope.memberId,
      contextRevisionId: revision,
      answerId: "answer_1",
      intentId: "adherence",
      selectedEvidenceIds: [atom.evidenceId],
      issuedAt: "2026-08-07T12:00:00.000Z",
      expiresAt: "2026-08-07T12:10:00.000Z",
    },
    signature: "signed-value",
  });
  return {
    schemaVersion: "copilot-answer/v1",
    requestId: "request_1",
    answerId: "answer_1",
    ...scope,
    contextRevisionId: revision,
    intentId: "adherence",
    requestedFor: "2026-08-07",
    evidenceAsOf: "2026-06-04T23:59:59.999-05:00",
    memberTimezone: "America/Chicago",
    briefFreshness: null,
    evidence: { ...scope, contextRevisionId: revision, atoms: [scopedAtom] },
    sections: [{
      sectionId: "answer",
      clauses: [{ clauseId: "clause_1", text: "Completion was 50%.", evidenceIds: [atom.evidenceId] }],
    }],
    tasks: [],
    chart: {
      ...scope,
      contextRevisionId: revision,
      chartId: "chart_1",
      recipeId: "adherence-weekly",
      type: "bar",
      unit: "percent",
      precision: "date",
      temporalMode: "calendar",
      points: [{
        pointId: "point_1",
        label: "Jun 2",
        value: 50,
        evidenceIds: [atom.evidenceId],
      }],
      textSummary: "Jun 2: 50 percent.",
    },
    citations: [{
      ...scope,
      contextRevisionId: revision,
      citationId: "citation_1",
      evidenceId: atom.evidenceId,
      label: "Weekly workout completion",
      source: atom.source,
      classification: atom.classification,
      temporal: atom.temporal,
      unit: atom.unit,
    }],
    churn: {
      derived: {
        ...scope,
        contextRevisionId: revision,
        methodVersion: "churn-v1",
        level: "watch",
        reasons: [{ code: "adherence-drop", evidenceIds: [atom.evidenceId] }],
        excludedSourceReasons: [],
        evidenceIds: [atom.evidenceId],
      },
      source: null,
    },
    continuation,
  } as const;
}

describe("Copilot contracts", () => {
  it("keeps quick prompts and free text distinct behind one question and outcome contract", () => {
    expect(COPILOT_QUICK_PROMPT_IDS).toEqual([
      "morning-brief",
      "adherence",
      "sleep",
      "changes-since-last-week",
      "churn-risk",
    ]);
    expect(COPILOT_CANONICAL_INTENT_IDS).toEqual(COPILOT_QUICK_PROMPT_IDS);
    expectTypeOf<CopilotQuestionInput>().toEqualTypeOf<
      | { readonly kind: "quick-prompt"; readonly promptId: (typeof COPILOT_QUICK_PROMPT_IDS)[number] }
      | { readonly kind: "free-text"; readonly question: string }
    >();
    expectTypeOf<CopilotOutcome["status"]>().toEqualTypeOf<
      | "ready"
      | "empty"
      | "insufficient-history"
      | "stale"
      | "continuation-expired"
      | "denied"
      | "invalid"
      | "unavailable"
      | "model-error"
      | "unsupported"
      | "cancelled"
    >();
  });

  it("accepts only bounded canonical model selections and rejects every authority or content field", () => {
    const bounds = {
      intentIds: COPILOT_CANONICAL_INTENT_IDS,
      sectionIds: ["answer", "trend"],
      evidenceIds: [atom.evidenceId],
      actionIds: ["review-with-member"],
    } as const;
    const accepted = decodeCopilotModelCandidate({
      schemaVersion: "copilot-model-candidate/v1",
      intentId: "adherence",
      selections: [{
        sectionId: "trend",
        evidenceIds: [atom.evidenceId],
        actionIds: ["review-with-member"],
      }],
    }, bounds);
    expect(accepted).toMatchObject({ status: "accepted", candidate: { intentId: "adherence" } });
    if (accepted.status === "accepted") {
      expectTypeOf<WritableKeys<CopilotModelCandidate>>().toEqualTypeOf<never>();
      expect(Object.isFrozen(accepted.candidate)).toBe(true);
    }

    for (const forbidden of [
      { prose: "Jordan is injured" },
      { rawQuery: "MATCH (n) RETURN n" },
      { memberId: "other-member" },
      { contextRevisionId: "other-revision" },
      { chart: { values: [99] } },
      { citations: [{ url: "https://example.test" }] },
      { churnLevel: "elevated" },
      { authority: "canonical" },
    ]) {
      expect(decodeCopilotModelCandidate({
        schemaVersion: "copilot-model-candidate/v1",
        intentId: "adherence",
        selections: [{ sectionId: "trend", evidenceIds: [atom.evidenceId], actionIds: [] }],
        ...forbidden,
      }, bounds)).toMatchObject({ status: "rejected" });
    }
  });

  it("creates one deeply immutable packet and rejects mixed member or revision claims", () => {
    const packet = createCopilotAnswerPacket(packetInput());
    expect(packet.memberId).toBe(scope.memberId);
    expect(packet.chart?.contextRevisionId).toBe(packet.contextRevisionId);
    expect(packet.citations.every((citation) => citation.memberId === packet.memberId)).toBe(true);
    expect(Object.isFrozen(packet)).toBe(true);
    expect(Object.isFrozen(packet.sections[0].clauses)).toBe(true);
    expectTypeOf<WritableKeys<CopilotAnswerPacket>>().toEqualTypeOf<never>();

    expect(() => createCopilotAnswerPacket({
      ...packetInput(),
      chart: { ...packetInput().chart, contextRevisionId: "member-context:sha256:r2" },
    })).toThrow(/member and revision/i);
    expect(() => createCopilotAnswerPacket({
      ...packetInput(),
      sections: [{
        sectionId: "answer",
        clauses: [{ clauseId: "clause_bad", text: "Unsupported claim.", evidenceIds: ["assertion:2222222222222222"] }],
      }],
    })).toThrow(/evidence/i);
  });

  it("keeps media metadata-only and pins rendered snapshots across refreshes", () => {
    const media = {
      ...scope,
      atomKind: "media-metadata",
      evidenceId: "assertion:3333333333333333",
      evidenceKind: "media-attachment",
      source: { locator: "/chat/0/attachments/0", artifactDigest: "sha256:source" },
      classification: "source-statement",
      temporal: { precision: "exact-timestamp", effectiveAt: "2026-06-01T12:00:00.000Z" },
      mediaType: "image",
      caption: "Home setup photo",
      assetStatus: "metadata-only",
      analysisStatus: "not-analyzed",
      unit: null,
    } as const satisfies CopilotEvidenceAtom;
    expect(media.analysisStatus).toBe("not-analyzed");
    expect(media).not.toHaveProperty("analysis");
    expect(media).not.toHaveProperty("assetUrl");

    const firstPacket = createCopilotAnswerPacket(packetInput());
    const pin = createCopilotPin({
      pinId: "pin_1",
      answer: firstPacket,
      sectionId: "answer",
      createdAt: "2026-08-07T12:01:00.000Z",
    });
    const beforeRefresh = JSON.stringify(pin);
    createCopilotAnswerPacket(packetInput("member-context:sha256:r2"));
    expect(JSON.stringify(pin)).toBe(beforeRefresh);
    expect(Object.isFrozen(pin.renderedSnapshot)).toBe(true);
  });
});
