import { describe, expect, it } from "vitest";
import type { ConceptCandidateFact } from "../../src/domain/contracts/movement-clinical-queries";
import type { ConceptMention } from "../../src/domain/contracts/concept-resolution";
import { decideConceptResolution } from "../../src/domain/policies/concept-resolution";
import { resolveMovementConcepts } from "../../src/application/use-cases/resolve-movement-concepts";
import { compileDefaultMovementGraph } from "../../src/graph/ingest/movement-clinical";
import { InMemoryMovementGraphReadProvider } from "../../src/graph/repositories/movement-graph";
import { translateLegacyMovementConceptId } from "../../src/domain/policies/legacy-movement-ids";

function snapshot() {
  const result = compileDefaultMovementGraph();
  if (result.status !== "valid") throw new Error(JSON.stringify(result.report));
  return result.snapshot;
}

const injury = (text: string): ConceptMention => ({ text, kind: "joint", role: "injury", safetyCritical: true });

describe("revision-pinned concept resolver", () => {
  it("resolves exact catalog terms before later matching passes", async () => {
    const graph = snapshot();
    const provider = new InMemoryMovementGraphReadProvider([graph], { authority: "canonical" });
    const result = await resolveMovementConcepts(provider, {
      mentions: [
        injury("knee"),
        { text: "kettlebell", kind: "equipment", role: "equipment", safetyCritical: false },
      ],
    });

    expect(result.status).toBe("resolved");
    expect(result.resolutions).toMatchObject([
      { status: "resolved", conceptId: "joint:knee", method: "exact" },
      { status: "resolved", conceptId: "equipment:kettlebell", method: "exact" },
    ]);
  });

  it("uses fuzzy matching for a typo only after exact matching misses", async () => {
    const graph = snapshot();
    const provider = new InMemoryMovementGraphReadProvider([graph], { authority: "canonical" });
    const result = await resolveMovementConcepts(provider, {
      mentions: [{ text: "ketlebell", kind: "equipment", role: "equipment", safetyCritical: false }],
    });

    expect(result.resolutions[0]).toMatchObject({
      status: "resolved",
      conceptId: "equipment:kettlebell",
      method: "fuzzy",
    });
  });

  it("uses the deterministic local vector fallback for a grounded anatomy phrase", async () => {
    const graph = snapshot();
    const provider = new InMemoryMovementGraphReadProvider([graph], { authority: "canonical" });
    const result = await resolveMovementConcepts(provider, {
      mentions: [{ text: "bad lower back", kind: "anatomy", role: "injury", safetyCritical: true }],
    });

    expect(result.resolutions[0]).toMatchObject({
      status: "resolved",
      conceptId: "body-region:lumbar-back",
      method: "vector",
      threshold: 0.95,
      groundingStatus: "active-mapping",
      graphRevisionId: graph.graphRevisionId,
      authority: "canonical",
    });
  });

  it("degrades to a typed below-threshold result when no candidate has usable signal", async () => {
    const graph = snapshot();
    const provider = new InMemoryMovementGraphReadProvider([graph], { authority: "canonical" });
    const result = await resolveMovementConcepts(provider, {
      mentions: [{ text: "zzzz qqqq", kind: "equipment", role: "equipment", safetyCritical: false }],
    });

    expect(result).toMatchObject({
      status: "needs_clarification",
      resolutions: [{ status: "unresolved", reason: "below-threshold", requiredConfidence: 0.9 }],
    });
  });

  it("translates only reviewed legacy IDs and fails explicitly for unknown IDs", () => {
    expect(translateLegacyMovementConceptId("anatomy:knee")).toEqual({
      status: "translated",
      legacyId: "anatomy:knee",
      conceptId: "joint:knee",
    });
    expect(translateLegacyMovementConceptId("anatomy:not-real")).toEqual({
      status: "unknown",
      legacyId: "anatomy:not-real",
    });
  });

  it("retrieves from one canonical revision and keeps assertion provenance", async () => {
    const graph = snapshot();
    const provider = new InMemoryMovementGraphReadProvider([graph], { authority: "canonical" });
    const result = await resolveMovementConcepts(provider, { mentions: [injury("knee")] });

    expect(result.status).toBe("resolved");
    expect(result.resolutions[0]).toMatchObject({
      status: "resolved",
      conceptId: "joint:knee",
      method: "exact",
      authority: "canonical",
      graphRevisionId: graph.graphRevisionId,
      groundingStatus: "active-mapping",
    });
    const resolution = result.resolutions[0];
    expect(resolution?.status === "resolved" && resolution.assertionId).toMatch(/^assertion:sha256:/);
    expect(resolution?.status === "resolved" && resolution.mappingAssertionIds).toEqual([expect.stringMatching(/^assertion:sha256:/)]);
  });

  it("keeps local-only grounding visible instead of inventing an external mapping", async () => {
    const graph = snapshot();
    const provider = new InMemoryMovementGraphReadProvider([graph], { authority: "canonical" });
    const result = await resolveMovementConcepts(provider, {
      mentions: [{ text: "medicine ball", kind: "equipment", role: "equipment", safetyCritical: false }],
    });

    expect(result.resolutions[0]).toMatchObject({
      status: "resolved",
      groundingStatus: "local-only",
      mappingAssertionIds: [],
    });
  });

  it("honors an explicit revision even after a different revision becomes active", async () => {
    const first = snapshot();
    const second = structuredClone(first);
    Object.assign(second, { graphRevisionId: "graph:sha256:second" });
    second.nodes.forEach((node) => Object.assign(node, { graphRevisionId: second.graphRevisionId }));
    second.edges.forEach((edge) => Object.assign(edge, { graphRevisionId: second.graphRevisionId }));
    const provider = new InMemoryMovementGraphReadProvider([first, second], { activeRevisionId: second.graphRevisionId, authority: "canonical" });

    const result = await resolveMovementConcepts(provider, { graphRevisionId: first.graphRevisionId, mentions: [injury("knee")] });
    expect(result.resolutions[0]?.graphRevisionId).toBe(first.graphRevisionId);
  });

  it("keeps exact-alias ambiguity instead of picking by ordering", () => {
    const candidates: ConceptCandidateFact[] = [
      { conceptId: "joint:a", assertionId: "assertion:a", kind: "joint", label: "First", exactMatchedAlias: "knee", fuzzyMatchedAlias: "knee", fuzzyScore: 1, vectorMatchedAlias: "knee", vectorScore: 1, groundingStatus: "active-mapping", mappingAssertionIds: ["mapping:a"] },
      { conceptId: "joint:b", assertionId: "assertion:b", kind: "joint", label: "Second", exactMatchedAlias: "knee", fuzzyMatchedAlias: "knee", fuzzyScore: 1, vectorMatchedAlias: "knee", vectorScore: 1, groundingStatus: "active-mapping", mappingAssertionIds: ["mapping:b"] },
    ];

    expect(decideConceptResolution(injury("knee"), candidates, {
      graphRevisionId: "graph:a", authority: "canonical",
    })).toMatchObject({ status: "clarify", reason: "ambiguous" });
  });

  it("reports an exact result's alternatives using their strongest real match signal", () => {
    const candidates: ConceptCandidateFact[] = [
      { conceptId: "joint:knee", assertionId: "assertion:knee", kind: "joint", label: "Knee", exactMatchedAlias: "knee", fuzzyMatchedAlias: "knee", fuzzyScore: 1, vectorMatchedAlias: "knee", vectorScore: 1, groundingStatus: "active-mapping", mappingAssertionIds: ["mapping:knee"] },
      { conceptId: "joint:hip", assertionId: "assertion:hip", kind: "joint", label: "Hip", fuzzyMatchedAlias: "hip joint", fuzzyScore: 0.2, vectorMatchedAlias: "leg joint", vectorScore: 0.6, groundingStatus: "active-mapping", mappingAssertionIds: ["mapping:hip"] },
    ];

    const resolution = decideConceptResolution(injury("knee"), candidates, {
      graphRevisionId: "graph:a", authority: "canonical",
    });
    expect(resolution).toMatchObject({
      status: "resolved",
      method: "exact",
      alternatives: [{
        conceptId: "joint:hip",
        matchedAlias: "leg joint",
        confidence: 0.6,
        fuzzyMatchedAlias: "hip joint",
        fuzzyScore: 0.2,
        vectorMatchedAlias: "leg joint",
        vectorScore: 0.6,
      }],
    });
    expect(resolution.status === "resolved" && resolution.alternatives[0]).not.toHaveProperty("exactMatchedAlias");
  });

  it("clarifies a near tie in the vector pass instead of using stable-ID ordering as meaning", () => {
    const candidates: ConceptCandidateFact[] = [
      { conceptId: "body-region:a", assertionId: "assertion:a", kind: "body-region", label: "First", fuzzyMatchedAlias: "first", fuzzyScore: 0.2, vectorMatchedAlias: "lower back", vectorScore: 0.9, groundingStatus: "active-mapping", mappingAssertionIds: ["mapping:a"] },
      { conceptId: "body-region:b", assertionId: "assertion:b", kind: "body-region", label: "Second", fuzzyMatchedAlias: "second", fuzzyScore: 0.2, vectorMatchedAlias: "low back", vectorScore: 0.86, groundingStatus: "active-mapping", mappingAssertionIds: ["mapping:b"] },
    ];

    expect(decideConceptResolution(
      { text: "bad lower back", kind: "anatomy", role: "injury", safetyCritical: false },
      candidates,
      { graphRevisionId: "graph:a", authority: "canonical" },
    )).toMatchObject({
      status: "clarify",
      reason: "ambiguous",
      candidates: [
        { conceptId: "body-region:a", vectorScore: 0.9, fuzzyScore: 0.2 },
        { conceptId: "body-region:b", vectorScore: 0.86, fuzzyScore: 0.2 },
      ],
    });
  });

  it("reports the vector threshold when the fallback is the deciding pass", () => {
    const candidates: ConceptCandidateFact[] = [
      { conceptId: "body-region:a", assertionId: "assertion:a", kind: "body-region", label: "First", fuzzyMatchedAlias: "first", fuzzyScore: 0.2, vectorMatchedAlias: "lower back", vectorScore: 0.7, groundingStatus: "active-mapping", mappingAssertionIds: ["mapping:a"] },
    ];

    expect(decideConceptResolution(
      { text: "bad lower back", kind: "anatomy", role: "injury", safetyCritical: false },
      candidates,
      { graphRevisionId: "graph:a", authority: "canonical" },
    )).toMatchObject({
      status: "unresolved",
      reason: "below-threshold",
      requiredConfidence: 0.75,
    });
  });

  it("fails closed for deprecated grounding, fixture safety answers, non-resolvable kinds, and caps", async () => {
    const deprecated: ConceptCandidateFact = {
      conceptId: "joint:knee", assertionId: "assertion:knee", kind: "joint", label: "Knee",
      exactMatchedAlias: "knee", fuzzyMatchedAlias: "knee", fuzzyScore: 1, vectorMatchedAlias: "knee", vectorScore: 1,
      groundingStatus: "deprecated-mapping", mappingAssertionIds: ["mapping:old"],
    };
    expect(decideConceptResolution(injury("knee"), [deprecated], {
      graphRevisionId: "graph:a", authority: "canonical",
    })).toMatchObject({ status: "unresolved", reason: "deprecated-mapping" });

    const fixture = new InMemoryMovementGraphReadProvider([snapshot()], { authority: "fixture" });
    await expect(resolveMovementConcepts(fixture, { mentions: [injury("knee")] }))
      .resolves.toMatchObject({ status: "failed_closed", resolutions: [{ reason: "non-authoritative" }] });
    await expect(resolveMovementConcepts(fixture, {
      mentions: [{ ...injury("knee"), kind: "clinical-rule" as never }],
    })).resolves.toMatchObject({ status: "failed_closed", resolutions: [{ reason: "invalid-input" }] });
    await expect(resolveMovementConcepts(fixture, {
      mentions: Array.from({ length: 17 }, () => injury("knee")),
    })).resolves.toMatchObject({ status: "failed_closed" });
  });
});
