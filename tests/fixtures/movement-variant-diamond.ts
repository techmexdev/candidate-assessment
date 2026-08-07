import type { MovementGraphSnapshot } from "../../src/domain/contracts/movement-graph";
import { compileDefaultMovementGraph } from "../../src/graph/ingest/movement-clinical";

export type MovementVariantDiamondFixture = {
  readonly snapshot: MovementGraphSnapshot;
  readonly rootConceptId: string;
  readonly parentConceptIds: readonly [string, string];
  readonly mergedConceptId: string;
  readonly expectedMergedPathAssertionIds: readonly string[];
};

export function buildMovementVariantDiamondFixture(): MovementVariantDiamondFixture {
  const compiled = compileDefaultMovementGraph();
  if (compiled.status !== "valid") throw new Error(JSON.stringify(compiled.report));

  const baseline = structuredClone(compiled.snapshot);
  const variantEdges = baseline.edges.filter((edge) => edge.kind === "variant-of");
  const rootConceptId = variantEdges[0]?.toConceptId;
  const rootEdges = variantEdges
    .filter((edge) => edge.toConceptId === rootConceptId)
    .sort((left, right) => left.assertionId.localeCompare(right.assertionId));
  const firstParentEdge = rootEdges[0];
  const secondParentEdge = rootEdges[1];
  const root = baseline.nodes.find((node) => node.conceptId === rootConceptId);
  const firstParent = baseline.nodes.find((node) => node.conceptId === firstParentEdge?.fromConceptId);
  const secondParent = baseline.nodes.find((node) => node.conceptId === secondParentEdge?.fromConceptId);
  const familyConceptIds = new Set(variantEdges.flatMap((edge) => [edge.fromConceptId, edge.toConceptId]));
  const merged = baseline.nodes
    .filter((node) => node.kind === "exercise" && !familyConceptIds.has(node.conceptId))
    .sort((left, right) => left.conceptId.localeCompare(right.conceptId))[0];
  if (!rootConceptId || !firstParentEdge || !secondParentEdge || !root || !firstParent || !secondParent || !merged) {
    throw new Error("Default movement graph cannot construct the variant diamond fixture");
  }

  const firstMergeAssertionId = "assertion:test:variant-diamond:first";
  const secondMergeAssertionId = "assertion:test:variant-diamond:second";
  const snapshot: MovementGraphSnapshot = {
    ...baseline,
    edges: [
      ...baseline.edges,
      {
        ...firstParentEdge,
        assertionId: firstMergeAssertionId,
        fromConceptId: merged.conceptId,
        toConceptId: firstParent.conceptId,
      },
      {
        ...secondParentEdge,
        assertionId: secondMergeAssertionId,
        fromConceptId: merged.conceptId,
        toConceptId: secondParent.conceptId,
      },
    ],
  };

  return {
    snapshot,
    rootConceptId,
    parentConceptIds: [firstParent.conceptId, secondParent.conceptId],
    mergedConceptId: merged.conceptId,
    expectedMergedPathAssertionIds: [
      root.assertionId,
      firstParentEdge.assertionId,
      firstParent.assertionId,
      firstMergeAssertionId,
      merged.assertionId,
    ],
  };
}
