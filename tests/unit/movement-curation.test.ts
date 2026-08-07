import { describe, expect, it } from "vitest";
import catalog from "../../data/exercises.json";
import anatomy from "../../data/movement-anatomy.json";
import concepts from "../../data/movement-concepts.json";
import demands from "../../data/movement-demands.json";
import evidence from "../../data/clinical-evidence.json";
import legacyIds from "../../data/movement-legacy-ids.json";
import mappings from "../../data/movement-ontology-mappings.json";
import rules from "../../data/clinical-rules.json";
import sourceReviews from "../../data/movement-source-reviews.json";
import substitutions from "../../data/movement-substitutions.json";
import variants from "../../data/movement-variants.json";
import type { OntologyMappingRecord } from "../../src/domain/contracts/ontology";

const expectedDemandIds = [
  "movement-demand:deep-loaded-knee-flexion",
  "movement-demand:plyometric-impact-landing",
  "movement-demand:loaded-overhead-shoulder-elevation",
  "movement-demand:loaded-lumbar-flexion",
  "movement-demand:axial-spinal-loading",
];

const catalogFields = [
  "id",
  "name",
  "muscle_groups",
  "joints_loaded",
  "movement_patterns",
  "equipment_required",
  "is_bilateral",
  "side",
  "priority_tier",
  "is_reps",
  "is_duration",
  "supports_weight",
  "estimated_rep_duration",
  "bilateral_pair_id",
] as const;

function expectUnique(values: string[]) {
  expect(new Set(values).size).toBe(values.length);
}

function expectReviewedRecord(record: {
  schema_version: string;
  source: { source_id: string; source_revision: string };
  review: { status: string; reviewer: string; reviewed_at: string };
}) {
  expect(record.schema_version).toBe("1.0.0");
  expect(record.source.source_id).toMatch(/^source:/);
  expect(record.source.source_revision).not.toBe("");
  expect(record.review).toMatchObject({ status: "reviewed" });
  expect(record.review.reviewer).not.toBe("");
  expect(record.review.reviewed_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
}

describe("Movement and Clinical curated manifests", () => {
  it("preserves the complete catalog under stable local identities", () => {
    const catalogConcepts = concepts.records.filter((record) => record.catalog_scope === "catalog");
    const byKind = (kind: string) => catalogConcepts.filter((record) => record.kind === kind);

    expect(byKind("exercise")).toHaveLength(50);
    expect(byKind("muscle")).toHaveLength(19);
    expect(byKind("joint")).toHaveLength(9);
    expect(byKind("movement-pattern")).toHaveLength(36);
    expect(byKind("equipment")).toHaveLength(32);
    expectUnique(concepts.records.map((record) => record.stable_id));

    for (const sourceExercise of catalog) {
      const curated = byKind("exercise").find((record) => record.catalog_id === sourceExercise.id);
      expect(curated, sourceExercise.id).toBeDefined();
      if (!curated?.catalog) throw new Error(`Missing curated exercise catalog payload: ${sourceExercise.id}`);
      for (const field of catalogFields) {
        expect(curated.catalog[field]).toEqual(sourceExercise[field]);
      }
      expect(curated.stable_id).toBe(`exercise:${sourceExercise.id}`);
      expect(curated.aliases).toContain(sourceExercise.name.toLowerCase());
      expectUnique(curated.aliases);
      expectReviewedRecord(curated);
    }

    const unresolvedPairs = catalog.filter((exercise) => exercise.bilateral_pair_id !== null);
    expect(unresolvedPairs).toHaveLength(18);
    expect(legacyIds.external_bilateral_pairs).toHaveLength(18);
    expect(legacyIds.external_bilateral_pairs.every((pair) => pair.edge_emitted === false)).toBe(true);
    expectUnique(legacyIds.records.map((record) => record.legacy_id));
  });

  it("provides non-dangling anatomy and the five reviewed demand concepts", () => {
    const conceptIds = new Set(concepts.records.map((record) => record.stable_id));
    const demandIds = demands.records.map((record) => record.stable_id);

    expect(demandIds).toEqual(expectedDemandIds);
    expectUnique(demandIds);
    demands.records.forEach(expectReviewedRecord);
    demands.records.forEach((record) => {
      expect(record.definition).not.toBe("");
      expect(record.scope).toMatchObject({ type: expect.any(String) });
      expect(record.reviewer_evidence_ids.length).toBeGreaterThan(0);
    });

    for (const relationship of anatomy.part_of) {
      expect(conceptIds.has(relationship.child_id)).toBe(true);
      expect(conceptIds.has(relationship.parent_id)).toBe(true);
      expect(relationship.assertion_id).toMatch(/^assertion:/);
      expect(relationship.source.source_id).toMatch(/^source:/);
    }
    for (const stress of anatomy.exercise_stresses) {
      expect(conceptIds.has(stress.exercise_id)).toBe(true);
      expect(conceptIds.has(stress.anatomy_id)).toBe(true);
    }
    for (const assignment of demands.assignments) {
      expect(conceptIds.has(assignment.exercise_id)).toBe(true);
      expect(demandIds).toContain(assignment.demand_id);
      expect(assignment.assertion_id).toMatch(/^assertion:/);
      expect(assignment.source.source_id).toMatch(/^source:/);
    }

    expect(anatomy.part_of).toContainEqual(expect.objectContaining({
      child_id: "joint:patellofemoral",
      parent_id: "joint:knee",
    }));
    expect(anatomy.exercise_stresses.some((stress) => stress.anatomy_id === "joint:patellofemoral")).toBe(true);
  });

  it("records typed synthetic rules with evidence and clinical review", () => {
    const conceptIds = new Set(concepts.records.map((record) => record.stable_id));
    const targetIds = new Set([...conceptIds, ...demands.records.map((record) => record.stable_id)]);
    const evidenceIds = new Set(evidence.records.map((record) => record.stable_id));

    expect(rules.records.length).toBeGreaterThanOrEqual(4);
    expectUnique(rules.records.map((record) => record.stable_id));
    expectUnique(evidence.records.map((record) => record.stable_id));
    evidence.records.forEach(expectReviewedRecord);
    expect(evidence.records.every((record) => record.evidence_role === "project-policy")).toBe(true);
    expect(evidence.records.every((record) => record.clinically_validated === false)).toBe(true);

    for (const rule of rules.records) {
      expectReviewedRecord(rule);
      expect(conceptIds.has(rule.condition_id)).toBe(true);
      expect(targetIds.has(rule.target.target_id)).toBe(true);
      expect(["hard-contraindication", "caution", "down-rank"]).toContain(rule.effect);
      expect(rule.target.edge_kind).toBe(
        rule.effect === "hard-contraindication" ? "contraindicates" : rule.effect === "caution" ? "cautions" : "downranks",
      );
      expect(rule.applicability).toMatchObject({
        condition_statuses: expect.any(Array),
        recovery_stages: expect.any(Array),
        severity_bands: expect.any(Array),
        laterality_policy: expect.stringMatching(/^(same-side|either-side|conservative-when-unknown)$/),
      });
      expect(rule.override_policy).toMatchObject({ allowed: expect.any(Boolean), rationale_required: expect.any(Boolean) });
      expect(rule.evidence_ids.length).toBeGreaterThan(0);
      expect(rule.evidence_ids.every((id) => evidenceIds.has(id))).toBe(true);
      expect(rule.clinical_review).toMatchObject({ status: "approved", synthetic_take_home_policy: true });
      expect(rule.assertion_id).toMatch(/^assertion:/);
    }
  });

  it("seeds reviewed substitutions while requiring a later safety recheck", () => {
    const exerciseIds = new Set(
      concepts.records.filter((record) => record.kind === "exercise").map((record) => record.stable_id),
    );
    expectUnique(substitutions.records.map((record) => record.assertion_id));

    for (const substitution of substitutions.records) {
      expect(substitution.source_exercise_id).not.toBe(substitution.target_exercise_id);
      expect(exerciseIds.has(substitution.source_exercise_id)).toBe(true);
      expect(exerciseIds.has(substitution.target_exercise_id)).toBe(true);
      expect(substitution.review).toMatchObject({ status: "reviewed" });
      expect(substitution.source.source_id).toMatch(/^source:/);
    }

    const barbellCase = substitutions.records
      .filter((record) => record.preserved_intent === "loaded unilateral knee-dominant strength")
      .sort((a, b) => a.rank - b.rank);
    expect(barbellCase.map((record) => record.candidate_equipment)).toEqual(["Dumbbell", "Medicine Ball", "Kettlebell"]);
    expect(barbellCase[0].safety_recheck).toMatchObject({ expected_result: "reject", rule_id: expect.any(String) });
    expect(barbellCase.slice(1).some((record) => record.safety_recheck.expected_result === "eligible"))
      .toBe(true);

    const unreviewedEdges = substitutions.records.filter((record) => record.review.status !== "reviewed");
    expect(unreviewedEdges).toHaveLength(0);
    const reversePairs = new Set(substitutions.records.map((record) => `${record.target_exercise_id}->${record.source_exercise_id}`));
    expect(substitutions.records.some((record) => reversePairs.has(`${record.source_exercise_id}->${record.target_exercise_id}`)))
      .toBe(false);
  });

  it("seeds one reviewed split-squat family with stable exercise endpoints", () => {
    const exerciseIds = new Set(
      concepts.records.filter((record) => record.kind === "exercise").map((record) => record.stable_id),
    );
    expect(variants.records).toHaveLength(2);
    expectUnique(variants.records.map((record) => record.assertion_id));
    expect(variants.records.map((record) => record.family_root_exercise_id)).toEqual([
      "exercise:00cc383b-f156-4b23-952a-15340100c261",
      "exercise:00cc383b-f156-4b23-952a-15340100c261",
    ]);
    expect(variants.records.map((record) => record.variant_exercise_id).sort()).toEqual([
      "exercise:0252c3c1-435f-49a2-9f79-5ef53eec3b1b",
      "exercise:02fe4cf5-bb21-4bef-868f-fea1477e2a53",
    ]);
    for (const record of variants.records) {
      expectReviewedRecord(record);
      expect(record.variant_exercise_id).not.toBe(record.family_root_exercise_id);
      expect(exerciseIds.has(record.variant_exercise_id)).toBe(true);
      expect(exerciseIds.has(record.family_root_exercise_id)).toBe(true);
    }
  });

  it("pins eight reviewed SNOMED records and keeps OPE candidates explicitly local-only", () => {
    const conceptIds = new Set(concepts.records.map((record) => record.stable_id));
    const reviewed = mappings.records.filter((record) => record.status === "reviewed");
    const localOnly = mappings.records.filter((record) => record.status === "local-only");

    expect(reviewed).toHaveLength(8);
    expect(reviewed.every((record) => record.source_ontology === "SNOMED CT")).toBe(true);
    expect(reviewed.map((record) => record.source_code)).toEqual([
      "45326000", "1003722009", "430725003", "279039007",
      "31398001", "49076000", "129160003", "52612000",
    ]);
    for (const mapping of reviewed) {
      expect(typeof mapping.source_code).toBe("string");
      expect(mapping.source_uri).toBe(`http://snomed.info/id/${mapping.source_code}`);
      expect(mapping.source_release).toBe("SNOMEDCT_US 2025_09_01");
      expect(mapping.source_term).not.toBe("");
      expect(mapping.scope_rationale).not.toBe("");
      expect(mapping.source_artifact_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(conceptIds.has(mapping.target_concept_id)).toBe(true);
    }

    expect(localOnly.length).toBeGreaterThanOrEqual(12);
    expect(localOnly.every((record) => record.source_ontology === "OPE")).toBe(true);
    expect(localOnly.every((record) => !("source_code" in record) && !("source_uri" in record))).toBe(true);
    expect(localOnly.every((record) => record.verification_status === "not-verified")).toBe(true);
    expect(localOnly.every((record) => {
      const reason = record.review_reason;
      return typeof reason === "string" && reason.includes("No class IRI verified");
    })).toBe(true);
    expect(JSON.stringify(mappings)).not.toMatch(/COPPER/i);
    expect(JSON.stringify(mappings)).not.toMatch(/evsexplore\.semantics\.cancer\.gov\/evsexplore\/concept\/snomedct_us\/?"/);

    const localOnlyContract = {
      status: "local-only",
      verificationId: "verification:ope:equipment-kettlebell:v1",
      verificationStatus: "not-verified",
      graphRevisionId: "graph:pending:movement-curation-v1",
      sourceOntology: "OPE",
      sourceRelease: "0.0.1",
      targetKind: "equipment",
      targetConceptId: "equipment:kettlebell",
      reviewReason: "No class IRI verified under clear license metadata.",
      curator: "ontology-curator",
      reviewedAt: "2026-08-06",
    } satisfies OntologyMappingRecord;
    expect("sourceCode" in localOnlyContract).toBe(false);
    expect("sourceUri" in localOnlyContract).toBe(false);
  });

  it("records source/license review without importing external ontology content", () => {
    const snomed = sourceReviews.records.find((record) => record.source_id === "source:snomed-gps-license");
    const ope = sourceReviews.records.find((record) => record.source_id === "source:ope-bioportal-0.0.1");

    expect(snomed).toMatchObject({
      review_status: "approved-for-bounded-mapping-metadata",
      license: "CC BY-ND 4.0",
      attribution_required: true,
      derivatives_permitted: false,
      hierarchy_imported: false,
      preferred_labels_modified: false,
    });
    expect(snomed?.terms_summary).toMatch(/share, store, and display/i);
    expect(ope).toMatchObject({
      source_release: "0.0.1",
      review_status: "citation-only",
      ontology_content_embedded: false,
      class_ids_embedded: false,
    });
    expect(ope?.review_reason).toMatch(/no clear ontology license metadata/i);
    expect(JSON.stringify({ concepts, anatomy, demands, evidence, rules, substitutions, mappings, legacyIds }))
      .not.toMatch(/member_id|recommendation_result|decision_result/i);
  });
});
