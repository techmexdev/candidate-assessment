import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MOVEMENT_EDGE_KINDS,
  MOVEMENT_NODE_KINDS,
} from "../../src/domain/contracts/movement-graph";

const schemaDoc = readFileSync(
  new URL("../../docs/graph/movement-clinical-schema.md", import.meta.url),
  "utf8",
);
const ontologyDoc = readFileSync(
  new URL("../../docs/ontology-model.md", import.meta.url),
  "utf8",
);
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const catalogSafetyContract = readFileSync(
  new URL("../../src/domain/contracts/catalog-safety.ts", import.meta.url),
  "utf8",
);

describe("Movement and Clinical graph documentation contract", () => {
  it("names every public node role and edge kind", () => {
    for (const kind of MOVEMENT_NODE_KINDS) expect(schemaDoc).toContain(`\`${kind}\``);
    for (const kind of MOVEMENT_EDGE_KINDS) expect(schemaDoc).toContain(`\`${kind}\``);
  });

  it("defines identity, provenance, endpoints, direction, and safety meaning", () => {
    for (const requiredText of [
      "Required properties",
      "Allowed endpoints",
      "Safety consequence",
      "assertionId",
      "conceptId",
      "graphRevisionId",
      "sourceId",
      "sourceRevision",
      "child to parent",
      "fail closed",
      "contraindicates > cautions > downranks",
    ]) expect(schemaDoc).toContain(requiredText);
  });

  it("contains the seven exact operating and decision walkthroughs", () => {
    for (const walkthrough of [
      "Knee rule walkthrough",
      "Anatomy descendant walkthrough",
      "Shoulder rule walkthrough",
      "Lumbar rule walkthrough",
      "Limited-equipment substitution walkthrough",
      "Failed activation walkthrough",
      "Historical explanation walkthrough",
    ]) expect(schemaDoc).toContain(walkthrough);
  });

  it("states the three-graph boundary and pinned read architecture", () => {
    for (const requiredText of [
      "Movement and Clinical graph",
      "Member Context graph",
      "Decision and Run graph",
      "MovementGraphReadHandle",
      "InMemoryMovementGraphReadProvider",
      "Neo4jMovementGraphReadProvider",
      "Mermaid",
    ]) expect(schemaDoc).toContain(requiredText);
    expect(schemaDoc).toContain("COPPER belongs only in the Member Context graph");
  });

  it("documents reviewed ontology grounding and its limits", () => {
    for (const requiredText of [
      "SNOMED CT",
      "OPE",
      "local-only",
      "SKOS",
      "exactMatch",
      "closeMatch",
      "broadMatch",
      "narrowMatch",
      "PROV-O",
      "CC BY-ND 4.0",
      "release",
      "license",
      "synthetic",
      "not clinically validated medical guidance",
    ]) expect(ontologyDoc).toContain(requiredText);
  });

  it("documents reproducible and non-destructive operator commands", () => {
    for (const command of [
      "docker compose up -d neo4j",
      "pnpm graph:seed -- --dry-run",
      "pnpm graph:seed",
      "pnpm graph:seed -- --activate --expected-prior",
      "pnpm graph:inspect",
      "pnpm test:integration",
      "docker compose restart neo4j",
    ]) expect(readme).toContain(command);
    for (const name of [
      "NEO4J_URI",
      "NEO4J_USERNAME",
      "NEO4J_PASSWORD",
      "NEO4J_DATABASE",
    ]) expect(readme).toContain(name);
    expect(readme).toContain("No reset-all or prune command is provided");
    expect(readme).toContain("COPPER belongs to the Member Context graph");
  });

  it("keeps complete-catalog decisions and family path kinds aligned with the domain contract", () => {
    for (const status of ["excluded", "caution", "downranked", "allowed"]) {
      expect(catalogSafetyContract).toContain(`"${status}"`);
      expect(schemaDoc).toContain(`\`${status}\``);
    }
    for (const pathKind of ["exact-exercise", "variant-of", "expresses"]) {
      expect(catalogSafetyContract).toContain(`"${pathKind}"`);
      expect(schemaDoc).toContain(`\`${pathKind}\``);
    }
  });

  it("documents graph-traversed catalog safety and its synthetic acceptance walkthroughs", () => {
    for (const requiredText of [
      "Complete-catalog safety boundary",
      "Catalog knee traversal walkthrough",
      "Catalog equipment walkthrough",
      "Catalog family-exclusion walkthrough",
      "Catalog preference walkthrough",
      "Catalog fail-closed walkthrough",
      "Catalog zero-match walkthrough",
      "condition-rule",
      "part-of",
      "stresses alone",
      "incomplete applicability",
      "memberContextRevisionId",
      "movementGraphRevisionId",
    ]) expect(schemaDoc).toContain(requiredText);
  });

  it("keeps the README safety posture visible", () => {
    for (const requiredText of [
      "Graph-controlled catalog safety",
      "complete catalog",
      "fail closed",
      "synthetic",
      "not clinically validated",
      "prompt text cannot authorize safety",
    ]) expect(readme).toContain(requiredText);
  });
});
