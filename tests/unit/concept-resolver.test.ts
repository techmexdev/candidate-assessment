import { describe, expect, it } from "vitest";
import type { ConceptCandidateFact } from "../../src/domain/contracts/movement-clinical-queries";
import type { ConceptMention } from "../../src/domain/contracts/concept-resolution";
import { decideConceptResolution } from "../../src/domain/policies/concept-resolution";
import { resolveMovementConcepts } from "../../src/application/use-cases/resolve-movement-concepts";
import { compileDefaultMovementGraph } from "../../src/graph/ingest/movement-clinical";
import { InMemoryMovementGraphReadProvider } from "../../src/graph/repositories/movement-graph";

function snapshot() {
  const result = compileDefaultMovementGraph();
  if (result.status !== "valid") throw new Error(JSON.stringify(result.report));
  return result.snapshot;
}

const injury = (text: string): ConceptMention => ({ text, kind: "joint", role: "injury", safetyCritical: true });

describe("revision-pinned concept resolver", () => {
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
      { conceptId: "joint:a", assertionId: "assertion:a", kind: "joint", label: "First", matchedAlias: "knee", exact: true, score: 1, groundingStatus: "active-mapping", mappingAssertionIds: ["mapping:a"] },
      { conceptId: "joint:b", assertionId: "assertion:b", kind: "joint", label: "Second", matchedAlias: "knee", exact: true, score: 1, groundingStatus: "active-mapping", mappingAssertionIds: ["mapping:b"] },
    ];

    expect(decideConceptResolution(injury("knee"), candidates, {
      graphRevisionId: "graph:a", authority: "canonical",
    })).toMatchObject({ status: "clarify", reason: "ambiguous" });
  });

  it("fails closed for deprecated grounding, fixture safety answers, non-resolvable kinds, and caps", async () => {
    const deprecated: ConceptCandidateFact = {
      conceptId: "joint:knee", assertionId: "assertion:knee", kind: "joint", label: "Knee",
      matchedAlias: "knee", exact: true, score: 1, groundingStatus: "deprecated-mapping", mappingAssertionIds: ["mapping:old"],
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
