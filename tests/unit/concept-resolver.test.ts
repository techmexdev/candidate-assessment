import { describe, expect, it } from "vitest";
import exercises from "../../data/exercises.json";
import { buildLegacyMovementResolverGraph } from "../../src/graph/ingest/exercises";
import { LegacyMovementResolverBridge } from "../../src/graph/repositories/movement-graph";
import { resolveConcept, resolveConcepts } from "../../src/domain/policies/concept-resolution";

describe("concept resolver", () => {
  const repository = new LegacyMovementResolverBridge(buildLegacyMovementResolverGraph(exercises));

  it("resolves exact aliases at full confidence", () => {
    const result = resolveConcept(repository, { text: "knee", kind: "anatomy", role: "injury", safetyCritical: true });

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.conceptId).toBe("anatomy:knee");
      expect(result.method).toBe("exact");
      expect(result.confidence).toBe(1);
    }
  });

  it("uses fuzzy and semantic fallback without accepting a weak safety match", () => {
    const fuzzy = resolveConcept(repository, { text: "kettle bell", kind: "equipment", role: "equipment", safetyCritical: false });
    const weak = resolveConcept(repository, { text: "knee-ish unknown", kind: "anatomy", role: "injury", safetyCritical: true });

    expect(fuzzy.status).toBe("resolved");
    expect(weak.status).toBe("unresolved");
  });

  it("returns clarification for below-threshold candidates and blocks mixed batches", () => {
    const ambiguous = resolveConcept(repository, { text: "decline bench press", kind: "exercise", role: "target", safetyCritical: false });
    const batch = resolveConcepts(repository, [
      { text: "knee", kind: "anatomy", role: "injury", safetyCritical: true },
      { text: "unknown injury phrase", kind: "anatomy", role: "injury", safetyCritical: true },
    ]);

    expect(ambiguous.status).toBe("clarify");
    if (ambiguous.status === "clarify") expect(ambiguous.reason).toBe("below-threshold");
    expect(batch.status).toBe("needs_clarification");
  });
});
