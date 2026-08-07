import { describe, expect, it } from "vitest";
import type {
  ChurnAssessmentEvidenceProjection,
  ChurnReasonEvidenceProjection,
  MessageProjection,
  ObservationEvidenceProjection,
  WorkoutSessionEvidenceProjection,
} from "../../src/domain/contracts/member-context-queries";
import { deriveChurnRisk } from "../../src/domain/policies/churn-risk";

const scope = { memberId: "mbr_jordan", contextRevisionId: "member-context:sha256:r1", authority: "canonical" } as const;
const source = { locator: "/source", artifactDigest: "sha256:source" } as const;

function adherence(id: string, date: string, value: number): ObservationEvidenceProjection {
  return { evidenceId: id, assertionId: id, semanticId: id, kind: "observation", source, classification: "observation", temporal: { precision: "date", effectiveOn: date }, metric: "weekly-workout-completion", value, unit: "percent", sourceOrder: 0 };
}

function workout(id: string, date: string, completed: boolean): WorkoutSessionEvidenceProjection {
  return { evidenceId: id, assertionId: id, semanticId: id, kind: "workout-session", source, classification: "source-statement", temporal: { precision: "date", effectiveOn: date }, title: id, planned: true, completed, durationMinutes: completed ? 30 : 0, rpe: null };
}

function message(id: string, timestamp: string, senderRole: "member" | "coach" = "member"): MessageProjection {
  return { evidenceId: id, assertionId: id, semanticId: id, kind: "message", source, classification: "source-statement", temporal: { precision: "exact-timestamp", effectiveAt: timestamp }, senderRole, text: "untrusted prose", attachmentEvidenceIds: [], attachments: [] };
}

const sourceAssessment: ChurnAssessmentEvidenceProjection = {
  evidenceId: "assertion:aaaaaaaaaaaaaaaa", assertionId: "assertion:aaaaaaaaaaaaaaaa", semanticId: "source-risk", kind: "churn-assessment", source,
  classification: "source-provided-assessment", temporal: { precision: "date", effectiveOn: "2026-06-04" }, level: "elevated",
};
const sourceReasons: ChurnReasonEvidenceProjection[] = [{
  evidenceId: "assertion:bbbbbbbbbbbbbbbb", assertionId: "assertion:bbbbbbbbbbbbbbbb", semanticId: "login", kind: "churn-reason", source,
  classification: "source-statement", temporal: { precision: "date", effectiveOn: "2026-06-04" }, text: "Login frequency down", sourceOrder: 2, basisStatus: "unsupported-source",
}];

describe("churn-v1", () => {
  it("requires two adherence points and two planned workouts", () => {
    const result = deriveChurnRisk({ scope, evidenceAsOf: "2026-06-05T00:00:00.000Z", adherence: [adherence("assertion:1111111111111111", "2026-06-02", 50)], workouts: [workout("assertion:2222222222222222", "2026-06-03", false)], messages: [], sourceAssessment, sourceReasons });
    expect(result.derived).toMatchObject({ methodVersion: "churn-v1", level: "insufficient-evidence", reasons: [] });
    expect(result.source?.level).toBe("elevated");
    expect(result.derived.excludedSourceReasons).toEqual([{ code: "unsupported-source-risk", basisStatus: "unsupported-source", evidenceIds: [sourceReasons[0]!.evidenceId] }]);
  });

  it.each([
    { prior: 100, latest: 75, misses: 0, level: "elevated" },
    { prior: 100, latest: 76, misses: 0, level: "watch" },
    { prior: 100, latest: 91, misses: 2, level: "elevated" },
    { prior: 100, latest: 91, misses: 1, level: "watch" },
    { prior: 100, latest: 91, misses: 0, level: "low" },
  ])("applies exact adherence and miss thresholds: $level", ({ prior, latest, misses, level }) => {
    const workouts = [0, 1, 2, 3].map((index) => workout(`assertion:000000000000000${index}`, `2026-06-0${index + 1}`, index >= misses));
    const result = deriveChurnRisk({
      scope,
      evidenceAsOf: "2026-06-05T00:00:00.000Z",
      adherence: [adherence("assertion:1111111111111111", "2026-05-26", prior), adherence("assertion:2222222222222222", "2026-06-02", latest)],
      workouts,
      messages: [],
      sourceAssessment,
      sourceReasons,
    });
    expect(result.derived.level).toBe(level);
  });

  it("uses only member timestamps as an additive highest-signal and is record-order invariant", () => {
    const prior = [
      message("assertion:1111111111111111", "2026-05-10T12:00:00.000Z"),
      message("assertion:2222222222222222", "2026-05-15T12:00:00.000Z"),
      message("assertion:3333333333333333", "2026-05-17T12:00:00.000Z", "coach"),
    ];
    const input = {
      scope,
      evidenceAsOf: "2026-06-01T00:00:00.000Z",
      adherence: [adherence("assertion:4444444444444444", "2026-05-19", 100), adherence("assertion:5555555555555555", "2026-05-26", 100)],
      workouts: [workout("assertion:6666666666666666", "2026-05-29", true), workout("assertion:7777777777777777", "2026-05-30", true)],
      messages: prior,
      sourceAssessment,
      sourceReasons,
    } as const;
    const first = deriveChurnRisk(input);
    const shuffled = deriveChurnRisk({ ...input, adherence: [...input.adherence].reverse(), workouts: [...input.workouts].reverse(), messages: [...input.messages].reverse() });
    expect(first.derived.level).toBe("elevated");
    expect(shuffled).toEqual(first);
    expect(JSON.stringify(first.derived)).not.toContain("Login frequency");
    expect(JSON.stringify(first.derived)).not.toContain("untrusted prose");
  });
});
