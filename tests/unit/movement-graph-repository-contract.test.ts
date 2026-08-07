import { describe, expect, it } from "vitest";
import { CATALOG_SAFETY_MAX_EXERCISES } from "../../src/domain/contracts/catalog-safety";
import type { MovementGraphSnapshot } from "../../src/domain/contracts/movement-graph";
import { compileDefaultMovementGraph } from "../../src/graph/ingest/movement-clinical";
import { InMemoryMovementGraphReadProvider } from "../../src/graph/repositories/movement-graph";
import { validateMovementGraph } from "../../src/graph/validation/movement-graph";
import { buildMovementVariantDiamondFixture } from "../fixtures/movement-variant-diamond";

function snapshot() {
  const result = compileDefaultMovementGraph();
  if (result.status !== "valid") throw new Error(JSON.stringify(result.report));
  return result.snapshot;
}

async function openHandle(authority: "canonical" | "fixture" = "fixture") {
  const provider = new InMemoryMovementGraphReadProvider([snapshot()], { authority });
  const opened = await provider.openActive();
  if (opened.status !== "ready") throw new Error("graph unavailable");
  return { provider, handle: opened.handle };
}

describe("in-memory movement graph read contract", () => {
  it("returns stable candidates and identical facts with configurable authority", async () => {
    const fixture = await openHandle("fixture");
    const canonical = await openHandle("canonical");
    const query = { text: "knee", kinds: ["joint" as const], maxResults: 10 };
    const fixtureResult = await fixture.handle.resolveConceptCandidates(query);
    const canonicalResult = await canonical.handle.resolveConceptCandidates(query);
    expect(fixtureResult.status).toBe("ok");
    expect(canonicalResult.status).toBe("ok");
    if (fixtureResult.status !== "ok" || canonicalResult.status !== "ok") return;
    expect(fixtureResult.data).toEqual(canonicalResult.data);
    expect(fixtureResult.authority).toBe("fixture");
    expect(canonicalResult.authority).toBe("canonical");
    expect(fixtureResult.data[0]).toMatchObject({
      conceptId: "joint:knee",
      exactMatchedAlias: "knee",
      fuzzyMatchedAlias: "knee",
      fuzzyScore: 1,
      vectorMatchedAlias: "knee",
      vectorScore: 1,
    });
    await expect(fixture.handle.resolveConceptCandidates({ ...query, maxResults: 1 }))
      .resolves.toMatchObject({ status: "failed", failure: { code: "traversal_limit_exceeded", maxResults: 1 } });
  });

  it("keeps fuzzy and local-vector candidate signals separate", async () => {
    const { handle } = await openHandle("canonical");
    const typo = await handle.resolveConceptCandidates({ text: "ketlebell", kinds: ["equipment"], maxResults: 20 });
    expect(typo.status).toBe("ok");
    if (typo.status === "ok") {
      expect(typo.data[0]).toMatchObject({ conceptId: "equipment:kettlebell", fuzzyScore: expect.any(Number), vectorScore: 0 });
      expect(typo.data[0]!.fuzzyScore).toBeGreaterThan(0.9);
    }

    const phrase = await handle.resolveConceptCandidates({ text: "bad lower back", kinds: ["joint", "body-region"], maxResults: 10 });
    expect(phrase.status).toBe("ok");
    if (phrase.status === "ok") {
      expect(phrase.data[0]).toMatchObject({ conceptId: "body-region:lumbar-back", vectorMatchedAlias: "lower back region", vectorScore: 1 });
      expect(phrase.data[0]!.fuzzyScore).toBeLessThan(0.9);
    }
  });

  it("preserves the full bounded knee descendant path and assertion lookup", async () => {
    const { handle } = await openHandle();
    const result = await handle.getAnatomyPaths({ conceptId: "joint:knee", includeSelf: true, maxDepth: 4, maxResults: 10 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const path = result.data.find((fact) => fact.descendantConceptId === "joint:patellofemoral");
    expect(path).toBeDefined();
    expect(path?.nodeAssertionIds).toHaveLength(2);
    expect(path?.edgeAssertionIds).toHaveLength(1);
    const lookup = await handle.getAssertions({ assertionIds: [...path!.nodeAssertionIds, ...path!.edgeAssertionIds], maxResults: 10 });
    expect(lookup.status).toBe("ok");
    if (lookup.status === "ok") expect(lookup.data).toHaveLength(3);
  });

  it("returns condition-rule-target facts and reviewed substitution facts", async () => {
    const { handle } = await openHandle();
    const rules = await handle.getClinicalRuleFacts({ conditionConceptId: "condition:patellofemoral-pain-syndrome", maxResults: 10 });
    expect(rules.status).toBe("ok");
    if (rules.status === "ok") {
      expect(rules.data.some((fact) => fact.effect === "hard-contraindication" && fact.pathAssertionIds.length >= 3)).toBe(true);
      expect(rules.data.every((fact) => fact.evidenceAssertionIds.length > 0 && fact.mappingAssertionIds.length > 0)).toBe(true);
    }
    const substitutions = await handle.getSubstitutionCandidates({ exerciseConceptId: "exercise:00b26731-066f-4b69-96e8-3472fc6fbc09", maxResults: 10 });
    expect(substitutions.status).toBe("ok");
    if (substitutions.status === "ok") expect(substitutions.data).toHaveLength(3);
  });

  it("returns bounded deterministic exercise constraint facts", async () => {
    const { handle } = await openHandle();
    const exerciseConceptId = "exercise:00b26731-066f-4b69-96e8-3472fc6fbc09";
    const result = await handle.getExerciseConstraintFacts({ exerciseConceptId, maxResults: 20 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.exerciseConceptId).toBe(exerciseConceptId);
    expect(result.data.relations.some((fact) => fact.kind === "has-demand" && fact.targetConceptId === "movement-demand:deep-loaded-knee-flexion")).toBe(true);
    expect(result.data.relations).toEqual([...result.data.relations].sort((left, right) => left.kind.localeCompare(right.kind) || left.targetConceptId.localeCompare(right.targetConceptId) || left.edgeAssertionId.localeCompare(right.edgeAssertionId)));
    await expect(handle.getExerciseConstraintFacts({ exerciseConceptId: "exercise:missing", maxResults: 20 }))
      .resolves.toMatchObject({ status: "failed", failure: { code: "unresolved_concept" } });
    await expect(handle.getExerciseConstraintFacts({ exerciseConceptId, maxResults: 1 }))
      .resolves.toMatchObject({ status: "failed", failure: { code: "traversal_limit_exceeded" } });
  });

  it("returns the complete bounded catalog with assertion-bearing relations", async () => {
    const { handle } = await openHandle("canonical");
    const result = await handle.getCatalogExerciseFacts({ maxResults: CATALOG_SAFETY_MAX_EXERCISES });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data).toHaveLength(50);
    expect(result.data.map((fact) => fact.exerciseConceptId)).toEqual(
      [...result.data.map((fact) => fact.exerciseConceptId)].sort(),
    );
    expect(result.data.every((fact) => fact.exerciseAssertionId.startsWith("assertion:")
      && typeof fact.attributes.isBilateral === "boolean"
      && fact.relations.every((relation) => relation.edgeAssertionId.startsWith("assertion:")
        && relation.targetAssertionId.startsWith("assertion:")))).toBe(true);
    expect(result.data.some((fact) => fact.relations.some((relation) => relation.kind === "targets"))).toBe(true);
  });

  it("returns only reviewed exercise variants and exact movement-pattern members", async () => {
    const { handle } = await openHandle("canonical");
    const splitSquatRoot = "exercise:00cc383b-f156-4b23-952a-15340100c261";
    const variants = await handle.getCatalogFamilyFacts({
      conceptId: splitSquatRoot,
      conceptKind: "exercise",
      maxDepth: 2,
      maxResults: 10,
    });
    expect(variants.status).toBe("ok");
    if (variants.status === "ok") {
      expect(variants.data.map((fact) => [fact.matchKind, fact.exerciseConceptId])).toEqual([
        ["exact-exercise", splitSquatRoot],
        ["variant-of", "exercise:0252c3c1-435f-49a2-9f79-5ef53eec3b1b"],
        ["variant-of", "exercise:02fe4cf5-bb21-4bef-868f-fea1477e2a53"],
      ]);
      expect(variants.data.every((fact) => fact.pathAssertionIds.every((id) => id.startsWith("assertion:")))).toBe(true);
      expect(variants.data.some((fact) => fact.exerciseConceptId === "exercise:00b26731-066f-4b69-96e8-3472fc6fbc09")).toBe(false);
      expect(variants.data.some((fact) => fact.exerciseConceptId === "exercise:00036a08-7c22-42e4-8fe5-323b53e31667")).toBe(false);
    }

    const pattern = await handle.getCatalogFamilyFacts({
      conceptId: "movement-pattern:lower-push-split-squat",
      conceptKind: "movement-pattern",
      maxDepth: 1,
      maxResults: 10,
    });
    expect(pattern.status).toBe("ok");
    if (pattern.status === "ok") {
      expect(pattern.data.map((fact) => fact.exerciseConceptId)).toEqual([
        splitSquatRoot,
        "exercise:0252c3c1-435f-49a2-9f79-5ef53eec3b1b",
        "exercise:02fe4cf5-bb21-4bef-868f-fea1477e2a53",
      ].sort());
      expect(pattern.data.every((fact) => fact.matchKind === "expresses")).toBe(true);
    }
  });

  it("traverses a valid variant diamond once using the first deterministic shortest path", async () => {
    const diamond = buildMovementVariantDiamondFixture();
    expect(validateMovementGraph(diamond.snapshot).status).toBe("valid");
    const reversed: MovementGraphSnapshot = { ...diamond.snapshot, edges: [...diamond.snapshot.edges].reverse() };
    const providers = [diamond.snapshot, reversed].map((graph) => (
      new InMemoryMovementGraphReadProvider([graph], { authority: "canonical" })
    ));
    const results = [];
    for (const provider of providers) {
      const opened = await provider.openActive();
      if (opened.status !== "ready") throw new Error("diamond graph unavailable");
      results.push(await opened.handle.getCatalogFamilyFacts({
        conceptId: diamond.rootConceptId,
        conceptKind: "exercise",
        maxDepth: 2,
        maxResults: 10,
      }));
    }

    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.status).toBe("ok");
    if (results[0]?.status !== "ok") return;
    expect(results[0].data.map((fact) => fact.exerciseConceptId)).toEqual([
      diamond.rootConceptId,
      ...diamond.parentConceptIds,
      diamond.mergedConceptId,
    ].sort((left, right) => Number(left !== diamond.rootConceptId) - Number(right !== diamond.rootConceptId)
      || left.localeCompare(right)));
    expect(results[0].data.filter((fact) => fact.exerciseConceptId === diamond.mergedConceptId)).toHaveLength(1);
    expect(results[0].data.find((fact) => fact.exerciseConceptId === diamond.mergedConceptId)?.pathAssertionIds)
      .toEqual(diamond.expectedMergedPathAssertionIds);

    const opened = await providers[0]!.openActive();
    if (opened.status !== "ready") throw new Error("diamond graph unavailable");
    await expect(opened.handle.getCatalogFamilyFacts({
      conceptId: diamond.rootConceptId,
      conceptKind: "exercise",
      maxDepth: 1,
      maxResults: 10,
    })).resolves.toMatchObject({ status: "failed", failure: { code: "traversal_limit_exceeded" } });
  });

  it("fails closed for invalid family bounds, missing concepts, broken paths, and catalog overflow", async () => {
    const { handle } = await openHandle("canonical");
    await expect(handle.getCatalogFamilyFacts({
      conceptId: "exercise:00cc383b-f156-4b23-952a-15340100c261",
      conceptKind: "exercise",
      maxDepth: 0,
      maxResults: 10,
    })).resolves.toMatchObject({ status: "failed", failure: { code: "invalid_query" } });
    await expect(handle.getCatalogFamilyFacts({
      conceptId: "exercise:missing",
      conceptKind: "exercise",
      maxDepth: 2,
      maxResults: 10,
    })).resolves.toMatchObject({ status: "failed", failure: { code: "unresolved_concept" } });

    const baseline = snapshot();
    const exercise = baseline.nodes.find((node) => node.kind === "exercise")!;
    const overflow: MovementGraphSnapshot = {
      ...baseline,
      nodes: [
        ...baseline.nodes,
        ...Array.from({ length: CATALOG_SAFETY_MAX_EXERCISES + 1 - 50 }, (_, index) => ({
          ...exercise,
          conceptId: `exercise:overflow-${index}`,
          assertionId: `assertion:overflow-${index}`,
        })),
      ],
    };
    const overflowOpened = await new InMemoryMovementGraphReadProvider([overflow], { authority: "canonical" }).openActive();
    if (overflowOpened.status !== "ready") throw new Error("overflow graph unavailable");
    await expect(overflowOpened.handle.getCatalogExerciseFacts({ maxResults: CATALOG_SAFETY_MAX_EXERCISES }))
      .resolves.toMatchObject({
        status: "failed",
        failure: { code: "traversal_limit_exceeded", maxResults: CATALOG_SAFETY_MAX_EXERCISES },
      });

    const broken = structuredClone(baseline);
    const familyEdge = broken.edges.find((edge) => edge.kind === "variant-of")!;
    Object.assign(familyEdge, { fromConceptId: "exercise:missing" });
    const brokenOpened = await new InMemoryMovementGraphReadProvider([broken], { authority: "canonical" }).openActive();
    if (brokenOpened.status !== "ready") throw new Error("broken graph unavailable");
    await expect(brokenOpened.handle.getCatalogFamilyFacts({
      conceptId: familyEdge.toConceptId,
      conceptKind: "exercise",
      maxDepth: 2,
      maxResults: 10,
    })).resolves.toMatchObject({ status: "failed", failure: { code: "broken_assertion" } });
  });

  it("fails closed for invalid queries, unresolved concepts, and caps", async () => {
    const { handle } = await openHandle();
    await expect(handle.getAnatomyPaths({ conceptId: "joint:knee", includeSelf: true, maxDepth: 0, maxResults: 10 }))
      .resolves.toMatchObject({ status: "failed", failure: { code: "invalid_query" } });
    await expect(handle.getClinicalRuleFacts({ conditionConceptId: "condition:missing", maxResults: 10 }))
      .resolves.toMatchObject({ status: "failed", failure: { code: "unresolved_concept" } });
    await expect(handle.getAnatomyPaths({ conceptId: "joint:knee", includeSelf: true, maxDepth: 1, maxResults: 1 }))
      .resolves.toMatchObject({ status: "failed", failure: { code: "traversal_limit_exceeded" } });
    await expect(handle.getAssertions({ assertionIds: ["assertion:missing"], maxResults: 1 }))
      .resolves.toMatchObject({ status: "failed", failure: { code: "broken_assertion" } });
    await expect(new InMemoryMovementGraphReadProvider([]).openActive())
      .resolves.toMatchObject({ status: "unavailable", failure: { code: "graph_unavailable" } });
  });

  it("pins an opened handle when the provider active pointer changes", async () => {
    const first = snapshot();
    const second = structuredClone(first);
    Object.assign(second, { graphRevisionId: "graph:sha256:alternate" });
    second.nodes.forEach((node) => { Object.assign(node, { graphRevisionId: second.graphRevisionId }); });
    second.edges.forEach((edge) => { Object.assign(edge, { graphRevisionId: second.graphRevisionId }); });
    Object.freeze(second);
    const provider = new InMemoryMovementGraphReadProvider([first, second], { activeRevisionId: first.graphRevisionId });
    const opened = await provider.openActive();
    if (opened.status !== "ready") throw new Error("graph unavailable");
    provider.setActiveRevisionForTesting(second.graphRevisionId);
    expect(opened.handle.graphRevisionId).toBe(first.graphRevisionId);
    const later = await provider.openActive();
    expect(later.status === "ready" && later.handle.graphRevisionId).toBe(second.graphRevisionId);
  });

  it("returns stale instead of serving a non-active full revision", async () => {
    const first = snapshot();
    const second = structuredClone(first);
    Object.assign(second, { graphRevisionId: "graph:sha256:full-read-alternate" });
    second.nodes.forEach((node) => { Object.assign(node, { graphRevisionId: second.graphRevisionId }); });
    second.edges.forEach((edge) => { Object.assign(edge, { graphRevisionId: second.graphRevisionId }); });
    const provider = new InMemoryMovementGraphReadProvider([first, second], { activeRevisionId: second.graphRevisionId });

    await expect(provider.readFullRevision(first.graphRevisionId)).resolves.toEqual({
      status: "stale",
      domain: "movement-clinical",
      requestedRevisionId: first.graphRevisionId,
      activeRevisionId: second.graphRevisionId,
    });
  });
});
