import { describe, expect, it } from "vitest";
import jordan from "../../data/member-context.json";
import { compileMemberContextGraph } from "../../src/graph/ingest/member-context";
import {
  MemberContextValidationError,
  isMovementClinicalStableConceptId,
  validateMemberContextGraph,
  validateMemberContextSource,
} from "../../src/graph/validation/member-context";
import { buildMemberContextFixture } from "../fixtures/member-context-builder";

describe("member context validation", () => {
  it("validates the complete source before emitting graph records", () => {
    expect(validateMemberContextSource(jordan)).toEqual({ valid: true, errors: [] });
    expect(validateMemberContextGraph(compileMemberContextGraph(jordan))).toEqual({ valid: true, errors: [] });
  });

  it.each([
    ["duplicate source ID", (document: ReturnType<typeof buildMemberContextFixture>) => document.goals.push(structuredClone(document.goals[0]))],
    ["duplicate semantic identity", (document: ReturnType<typeof buildMemberContextFixture>) => document.equipment_available.push(document.equipment_available[0])],
    ["invalid date", (document: ReturnType<typeof buildMemberContextFixture>) => { document.injuries[0].since = "2026-02-31"; }],
    ["invalid timezone", (document: ReturnType<typeof buildMemberContextFixture>) => { document.profile.timezone = "Mars/Olympus"; }],
    ["unsupported author", (document: ReturnType<typeof buildMemberContextFixture>) => { document.chat_history[0].from = "admin"; }],
    ["unsupported attachment", (document: ReturnType<typeof buildMemberContextFixture>) => { document.chat_history[0].attachments = [{ type: "pdf", caption: "no" }]; }],
    ["false synthetic marker", (document: ReturnType<typeof buildMemberContextFixture>) => { document._note = "Real member"; }],
  ])("rejects the whole revision for %s", (_label, mutate) => {
    const document = buildMemberContextFixture(mutate);
    const validation = validateMemberContextSource(document);
    expect(validation.valid).toBe(false);
    expect(() => compileMemberContextGraph(document)).toThrow(MemberContextValidationError);
  });

  it("rejects unsupported lab metrics/units and dangling graph references", () => {
    const badUnit = buildMemberContextFixture((document) => {
      document.labs.blood_panel.ldl_mmol_l = 3.1;
    });
    expect(() => compileMemberContextGraph(badUnit)).toThrow(/labs\.blood_panel has unsupported field/i);

    const graph = structuredClone(compileMemberContextGraph(jordan)) as unknown as {
      memberId: string;
      contextRevisionId: string;
      sourceArtifactDigest: string;
      nodes: ReturnType<typeof compileMemberContextGraph>["nodes"];
      relationships: ReturnType<typeof compileMemberContextGraph>["relationships"][number][];
    };
    graph.relationships[0] = { ...graph.relationships[0], toSemanticId: "missing:node" };
    expect(validateMemberContextGraph(graph).errors).toEqual(expect.arrayContaining([expect.stringMatching(/dangling/i)]));
  });

  it("rejects incomplete graph roots and missing or duplicate ASSERTS relationships", () => {
    const compiled = compileMemberContextGraph(jordan);
    const missingRoot = structuredClone(compiled) as unknown as {
      nodes: Record<string, unknown>[];
      relationships: Record<string, unknown>[];
    };
    missingRoot.nodes = missingRoot.nodes.filter((node) => node.kind !== "member-profile");
    missingRoot.relationships = missingRoot.relationships.filter((edge) => edge.toKind !== "member-profile");
    expect(validateMemberContextGraph(missingRoot).errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/member-profile cardinality/i),
    ]));

    const missingAssertion = structuredClone(compiled) as unknown as {
      nodes: Record<string, unknown>[];
      relationships: Record<string, unknown>[];
    };
    const goal = missingAssertion.nodes.find((node) => node.kind === "goal");
    missingAssertion.relationships = missingAssertion.relationships.filter((edge) => !(edge.kind === "ASSERTS" && edge.toSemanticId === goal?.semanticId));
    expect(validateMemberContextGraph(missingAssertion).errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/exactly one ASSERTS/i),
    ]));

    const duplicateAssertion = structuredClone(compiled) as unknown as {
      relationships: Record<string, unknown>[];
    };
    const assertion = duplicateAssertion.relationships.find((edge) => edge.kind === "ASSERTS");
    duplicateAssertion.relationships.push({ ...assertion, semanticId: "relationship:duplicate-asserts", assertionId: "assertion:duplicate-asserts" });
    expect(validateMemberContextGraph(duplicateAssertion).errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/exactly one ASSERTS/i),
    ]));
  });

  it.each([
    ["exact timestamp", { precision: "exact-timestamp", effectiveAt: "not-a-timestamp" }],
    ["date", { precision: "date", effectiveOn: "2026-02-31" }],
    ["relative order", { precision: "relative-order", sourceOrder: -1 }],
    ["fractional relative order", { precision: "relative-order", sourceOrder: 1.5 }],
    ["unknown", { precision: "unknown", effectiveOn: "2026-01-01" }],
    ["unsupported", { precision: "fuzzy", effectiveOn: "2026-01-01" }],
  ])("rejects malformed %s temporal assertions without throwing", (_label, temporal) => {
    const graph = structuredClone(compileMemberContextGraph(jordan)) as unknown as {
      nodes: Record<string, unknown>[];
    };
    const node = graph.nodes.find((candidate) => candidate.kind === "message");
    if (!node) throw new Error("expected message node");
    node.temporal = temporal;
    expect(() => validateMemberContextGraph(graph)).not.toThrow();
    expect(validateMemberContextGraph(graph).errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/temporal is invalid/i),
    ]));
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects %s node sourceOrder values", (_label, sourceOrder) => {
    const graph = structuredClone(compileMemberContextGraph(jordan)) as unknown as {
      nodes: Record<string, unknown>[];
    };
    const message = graph.nodes.find((node) => node.kind === "message");
    if (!message) throw new Error("expected message node");
    message.sourceOrder = sourceOrder;
    expect(validateMemberContextGraph(graph).errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/sourceOrder is invalid/i),
    ]));
  });

  it.each(["member", "coach", "source-artifact", "member-context-revision", "ingestion-activity"])(
    "requires synthetic === true for compiler node kind %s",
    (kind) => {
      const graph = structuredClone(compileMemberContextGraph(jordan)) as unknown as {
        nodes: Record<string, unknown>[];
      };
      const node = graph.nodes.find((candidate) => candidate.kind === kind);
      if (!node) throw new Error(`expected ${kind} node`);
      node.synthetic = false;
      expect(validateMemberContextGraph(graph).errors).toEqual(expect.arrayContaining([
        expect.stringMatching(/synthetic/i),
      ]));
    },
  );

  it("runtime-checks discriminated node and relationship shapes without trusting TypeScript", () => {
    const graph = structuredClone(compileMemberContextGraph(jordan)) as unknown as {
      nodes: Record<string, unknown>[];
      relationships: Record<string, unknown>[];
    };
    const profile = graph.nodes.find((node) => node.kind === "member-profile");
    const relation = graph.relationships.find((edge) => edge.kind === "HAS_PROFILE");
    if (!profile || !relation) throw new Error("expected profile records");
    profile.heightCm = "secret-height";
    relation.fromKind = "message";
    expect(validateMemberContextGraph(graph).errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/heightCm is invalid/i),
      expect.stringMatching(/declared endpoint kinds/i),
    ]));

    expect(() => validateMemberContextGraph({ nodes: [{ kind: "future-secret-kind" }], relationships: [{}] })).not.toThrow();
    expect(validateMemberContextGraph({ nodes: [{ kind: "future-secret-kind" }], relationships: [{}] }).valid).toBe(false);
  });

  it("accepts only reviewed Movement/Clinical stable concept ID namespaces with nonempty suffixes", () => {
    expect(isMovementClinicalStableConceptId("equipment:dumbbell")).toBe(true);
    expect(isMovementClinicalStableConceptId("ontology-concept:12345")).toBe(true);
    expect(isMovementClinicalStableConceptId("copper:dumbbell")).toBe(false);
    expect(isMovementClinicalStableConceptId("equipment:")).toBe(false);

    const graph = structuredClone(compileMemberContextGraph(jordan)) as unknown as {
      nodes: Record<string, unknown>[];
    };
    const equipment = graph.nodes.find((node) => node.kind === "equipment-availability") as Record<string, unknown> | undefined;
    const reference = equipment?.domainReference as Record<string, unknown> | undefined;
    if (!reference) throw new Error("expected reviewed equipment mapping");
    reference.stableConceptId = "unreviewed-graph:secret-value";
    expect(validateMemberContextGraph(graph).errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/domainReference is invalid/i),
    ]));
  });

  it("never includes raw member text or measured values in validation errors", () => {
    const secrets = {
      chat: "CHAT-SECRET-9931",
      task: "TASK-SECRET-4482",
      churn: "CHURN-SECRET-7719",
      caption: "CAPTION-SECRET-6640",
      biomarker: "BIOMARKER-SECRET-2234",
      lab: "LAB-SECRET-1187",
    };
    const document = buildMemberContextFixture((value) => {
      value.chat_history = [
        { ts: "2026-08-06T08:00:00-05:00", from: "member", text: secrets.chat, attachments: [{ type: "image", caption: secrets.caption }] },
        { ts: "2026-08-06T08:00:00-05:00", from: "member", text: secrets.chat, attachments: [{ type: "image", caption: secrets.caption }] },
      ];
      value.coach_brief.morning_tasks = [
        { type: "follow-up", text: secrets.task },
        { type: "follow-up", text: secrets.task },
      ];
      value.coach_brief.churn_risk.reasons = [secrets.churn, secrets.churn];
      (value.biomarkers as unknown as Record<string, unknown>).resting_hr_bpm = secrets.biomarker;
      value.labs.blood_panel.ldl_mg_dl = secrets.lab;
    });
    const result = validateMemberContextSource(document);
    expect(result.valid).toBe(false);
    const rendered = result.errors.join(" ");
    for (const secret of Object.values(secrets)) expect(rendered).not.toContain(secret);
  });
});
