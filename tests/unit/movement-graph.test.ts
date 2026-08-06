import { describe, expect, it } from "vitest";
import exercises from "../../data/exercises.json";
import { buildMovementGraph } from "../../src/graph/ingest/exercises";
import { InMemoryMovementGraphRepository } from "../../src/graph/repositories/movement-graph";

describe("movement graph", () => {
  const repository = new InMemoryMovementGraphRepository(buildMovementGraph(exercises));

  it("ingests catalog taxonomy into stable typed nodes and edges", () => {
    const snapshot = repository.snapshot();

    expect(snapshot.revision).toBe("movement-v1");
    expect(snapshot.nodes.some((node) => node.id === `exercise:${exercises[0].id}`)).toBe(true);
    expect(snapshot.nodes.some((node) => node.id === "equipment:barbell")).toBe(true);
    expect(snapshot.edges.some((edge) => edge.kind === "requires")).toBe(true);
    expect(snapshot.edges.some((edge) => edge.kind === "targets")).toBe(true);
  });

  it("traverses knee descendants and exposes ontology mapping metadata", () => {
    const descendants = repository.getAnatomyDescendants("anatomy:knee");

    expect(descendants.map((node) => node.id)).toContain("anatomy:patellofemoral-joint");
    expect(repository.getNode("anatomy:knee")?.ontologyMappings.length).toBeGreaterThan(0);
  });

  it("finds typed candidates and equivalent exercises deterministically", () => {
    const candidates = repository.findConceptCandidates("kettle bell", "equipment");
    const barbellExercise = repository.findConceptCandidates("barbell decline bench press", "exercise")[0];

    expect(candidates[0]?.node.id).toBe("equipment:kettlebell");
    expect(barbellExercise).toBeDefined();
    expect(repository.findEquivalentExercises(barbellExercise!.node.id).some((node) => node.label.includes("Dumbbell"))).toBe(true);
  });

  it("rejects duplicate catalog IDs before building a graph", () => {
    expect(() => buildMovementGraph([exercises[0], exercises[0]])).toThrow(/duplicate exercise id/i);
  });
});
