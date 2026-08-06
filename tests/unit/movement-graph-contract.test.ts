import { describe, expect, expectTypeOf, it } from "vitest";
import {
  MOVEMENT_EDGE_KINDS,
  MOVEMENT_NODE_KINDS,
  type JointNodeAssertion,
  type MovementGraphEdgeAssertion,
  type MovementGraphNodeAssertion,
  type MovementNodeKind,
  type ResolvableConceptKind,
} from "../../src/domain/contracts/movement-graph";
import {
  conceptKindsForQuery,
  RESOLVABLE_CONCEPT_KINDS,
  type CandidateSummary,
} from "../../src/domain/contracts/concept-resolution";
import { ONTOLOGY_SUBSETS, type OntologyMappingRecord, type OntologySubset } from "../../src/domain/contracts/ontology";
import type {
  MovementGraphReadHandle,
  MovementGraphReadProvider,
} from "../../src/domain/contracts/movement-clinical-queries";
import type { MovementGraphPublisher } from "../../src/domain/contracts/movement-graph-publication";
import type { GraphRepositories } from "../../src/application/ports/graph-repositories";

type IfEquals<X, Y, Yes = X, No = never> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? Yes : No;
type WritableKeys<T> = {
  [Key in keyof T]-?: IfEquals<{ [P in Key]: T[Key] }, { -readonly [P in Key]: T[Key] }, Key>;
}[keyof T];

describe("Movement and Clinical graph contract", () => {
  it("exposes exactly the immutable target node and edge vocabulary", () => {
    expect(MOVEMENT_NODE_KINDS).toEqual([
      "exercise",
      "muscle",
      "joint",
      "body-region",
      "movement-pattern",
      "movement-demand",
      "equipment",
      "condition",
      "clinical-rule",
      "ontology-concept",
      "evidence-source",
      "graph-revision",
      "ingestion-activity",
    ]);
    expect(MOVEMENT_EDGE_KINDS).toEqual([
      "targets",
      "stresses",
      "expresses",
      "has-demand",
      "requires",
      "part-of",
      "variant-of",
      "substitution-candidate-for",
      "has-constraint",
      "contraindicates",
      "cautions",
      "downranks",
      "maps-to",
      "supported-by",
      "in-revision",
      "was-generated-by",
      "used",
    ]);
    expect(MOVEMENT_NODE_KINDS).not.toContain("anatomy");
    expect(MOVEMENT_EDGE_KINDS).not.toContain("contraindicated-for");

    expectTypeOf<MovementGraphNodeAssertion>().not.toHaveProperty("metadata");
    expectTypeOf<MovementGraphNodeAssertion["conceptId"]>().toEqualTypeOf<string>();
    expectTypeOf<MovementGraphNodeAssertion["assertionId"]>().toEqualTypeOf<string>();
    expectTypeOf<MovementGraphNodeAssertion["graphRevisionId"]>().toEqualTypeOf<string>();
    expectTypeOf<WritableKeys<MovementGraphNodeAssertion>>().toEqualTypeOf<never>();
    expectTypeOf<WritableKeys<MovementGraphEdgeAssertion>>().toEqualTypeOf<never>();

    const knee = {
      assertionId: "assertion:graph-abc:joint:knee",
      conceptId: "joint:knee",
      graphRevisionId: "graph:sha256:abc",
      kind: "joint",
      label: "Knee joint",
      aliases: ["knee"],
      source: { sourceId: "source:catalog", sourceRevision: "catalog-v1" },
    } satisfies JointNodeAssertion;
    expect(knee.conceptId).toBe("joint:knee");
  });

  it("keeps anatomy as an input filter over joint and body-region", () => {
    expect(conceptKindsForQuery("anatomy")).toEqual(["joint", "body-region"]);
    expect(RESOLVABLE_CONCEPT_KINDS).not.toEqual(expect.arrayContaining([
      "clinical-rule",
      "ontology-concept",
      "evidence-source",
      "graph-revision",
      "ingestion-activity",
    ]));

    expectTypeOf<CandidateSummary["kind"]>().toEqualTypeOf<ResolvableConceptKind>();
    expectTypeOf<Extract<MovementNodeKind, "anatomy">>().toEqualTypeOf<never>();
    expectTypeOf<Extract<CandidateSummary["kind"], "clinical-rule" | "ontology-concept" | "evidence-source" | "graph-revision" | "ingestion-activity">>().toEqualTypeOf<never>();
  });

  it("excludes COPPER and makes mappings revisioned review records", () => {
    expect(ONTOLOGY_SUBSETS).toEqual(["OPE", "SNOMED CT", "SKOS", "PROV-O"]);
    expectTypeOf<Extract<OntologySubset, "COPPER">>().toEqualTypeOf<never>();

    const mapping = {
      mappingId: "mapping:joint-knee:snomed",
      assertionId: "assertion:graph-abc:mapping:joint-knee:snomed",
      graphRevisionId: "graph:sha256:abc",
      sourceOntology: "SNOMED CT",
      sourceCode: "49076000",
      sourceTerm: "Knee joint structure",
      sourceUri: "http://snomed.info/id/49076000",
      sourceRelease: "2025_09_01",
      targetKind: "joint",
      targetConceptId: "joint:knee",
      ontologyConceptId: "ontology-concept:snomed-ct:49076000",
      relation: "exactMatch",
      confidence: 1,
      rationale: "Reviewed identity match",
      curator: "terminology-reviewer",
      reviewedAt: "2026-08-06",
      sourceArtifactDigest: "sha256:source",
      status: "reviewed",
    } satisfies OntologyMappingRecord;
    expect(mapping.graphRevisionId).toBe("graph:sha256:abc");
  });

  it("pins reads to a revision and authority without exposing graph administration", async () => {
    const handle: MovementGraphReadHandle = {
      graphRevisionId: "graph:sha256:abc",
      authority: "canonical",
      resolveConceptCandidates: async () => ({
        status: "ok",
        graphRevisionId: "graph:sha256:abc",
        authority: "canonical",
        data: [],
      }),
      getAnatomyPaths: async () => ({
        status: "ok",
        graphRevisionId: "graph:sha256:abc",
        authority: "canonical",
        data: [],
      }),
      getClinicalRuleFacts: async () => ({
        status: "ok",
        graphRevisionId: "graph:sha256:abc",
        authority: "canonical",
        data: [],
      }),
      getSubstitutionCandidates: async () => ({
        status: "ok",
        graphRevisionId: "graph:sha256:abc",
        authority: "canonical",
        data: [],
      }),
      getAssertions: async () => ({
        status: "ok",
        graphRevisionId: "graph:sha256:abc",
        authority: "canonical",
        data: [],
      }),
    };
    const provider: MovementGraphReadProvider = {
      openActive: async () => ({ status: "ready", handle }),
      openRevision: async () => ({ status: "ready", handle }),
    };
    const publisher = {} as MovementGraphPublisher;

    const opened = await provider.openActive();
    expect(opened.status).toBe("ready");
    expect("stage" in handle).toBe(false);
    expect("activate" in provider).toBe(false);
    expectTypeOf<GraphRepositories["movement"]>().toEqualTypeOf<MovementGraphReadProvider>();
    expectTypeOf<Extract<keyof MovementGraphReadHandle, keyof MovementGraphPublisher>>().toEqualTypeOf<never>();
    expectTypeOf(publisher).toHaveProperty("stage");
    expectTypeOf(publisher).toHaveProperty("validate");
    expectTypeOf(publisher).toHaveProperty("activate");
    expectTypeOf(publisher).toHaveProperty("inspect");
  });
});
