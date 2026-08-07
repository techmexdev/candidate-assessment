import { describe, expect, it } from "vitest";
import type { CopilotFactEvidenceAtom } from "../../src/domain/contracts/copilot";
import {
  createCopilotChart,
  deriveBriefFreshness,
  deriveEvidenceAsOf,
} from "../../src/domain/policies/copilot-projections";

const scope = {
  memberId: "mbr_jordan",
  contextRevisionId: "member-context:sha256:r1",
  authority: "canonical",
} as const;

function atom(
  evidenceId: string,
  value: number,
  effectiveOn: string,
  overrides: Partial<CopilotFactEvidenceAtom> = {},
): CopilotFactEvidenceAtom {
  return {
    ...scope,
    atomKind: "fact",
    evidenceId,
    evidenceKind: "observation",
    source: { locator: `/adherence/${evidenceId}`, artifactDigest: "sha256:source" },
    classification: "observation",
    temporal: { precision: "date", effectiveOn },
    value,
    unit: "percent",
    ...overrides,
  };
}

describe("Copilot deterministic projections", () => {
  it("binds each chart point to exact evidence and derives its summary from the plotted array", () => {
    const result = createCopilotChart({
      scope,
      chartId: "chart_adherence",
      recipeId: "adherence-four-weeks",
      type: "bar",
      temporalMode: "calendar",
      minimumPoints: 2,
      atoms: [
        atom("assertion:1111111111111111", 0, "2026-05-26"),
        atom("assertion:2222222222222222", 0, "2026-06-02"),
      ],
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error(result.status);
    expect(result.chart.points).toEqual([
      { pointId: "chart_adherence:0", label: "2026-05-26", value: 0, evidenceIds: ["assertion:1111111111111111"] },
      { pointId: "chart_adherence:1", label: "2026-06-02", value: 0, evidenceIds: ["assertion:2222222222222222"] },
    ]);
    expect(result.chart.textSummary).toBe("2026-05-26: 0 percent; 2026-06-02: 0 percent.");
  });

  it("omits insufficient charts and rejects mixed scope, unit, precision, or temporal mode", () => {
    expect(createCopilotChart({
      scope,
      chartId: "short",
      recipeId: "adherence-four-weeks",
      type: "line",
      temporalMode: "calendar",
      minimumPoints: 2,
      atoms: [atom("assertion:1111111111111111", 50, "2026-06-02")],
    })).toEqual({ status: "insufficient-history", requiredPoints: 2, availablePoints: 1, chart: null });

    const conflicts = [
      atom("assertion:2222222222222222", 6, "2026-06-03", { unit: "hour" }),
      atom("assertion:2222222222222222", 6, "2026-06-03", { memberId: "other" }),
      atom("assertion:2222222222222222", 6, "2026-06-03", { temporal: { precision: "relative-order", sourceOrder: 1 } }),
    ];
    for (const conflict of conflicts) {
      expect(() => createCopilotChart({
        scope,
        chartId: "mixed",
        recipeId: "adherence-four-weeks",
        type: "line",
        temporalMode: "calendar",
        minimumPoints: 2,
        atoms: [atom("assertion:1111111111111111", 50, "2026-06-02"), conflict],
      })).toThrow(/chart/i);
    }
  });

  it("uses neutral relative-order labels and keeps requested day separate from source time", () => {
    const relative = createCopilotChart({
      scope,
      chartId: "sleep",
      recipeId: "sleep-relative-seven",
      type: "bar",
      temporalMode: "relative-order",
      minimumPoints: 2,
      atoms: [
        atom("assertion:1111111111111111", 6.1, "2026-06-02", { unit: "hour", temporal: { precision: "relative-order", sourceOrder: 0 } }),
        atom("assertion:2222222222222222", 7.2, "2026-06-02", { unit: "hour", temporal: { precision: "relative-order", sourceOrder: 1 } }),
      ],
    });
    expect(relative).toMatchObject({ status: "ready", chart: { points: [{ label: "Recorded 1" }, { label: "Recorded 2" }] } });
    expect(deriveBriefFreshness("2026-07-08", "2026-06-04")).toEqual({
      status: "latest-recorded",
      generatedFor: "2026-06-04",
    });
    expect(deriveEvidenceAsOf([
      atom("assertion:1111111111111111", 50, "2026-06-02"),
      atom("assertion:2222222222222222", 75, "2026-06-04"),
    ], "America/Los_Angeles")).toMatch(/^2026-06-04T23:59:59\.999/);
  });
});
