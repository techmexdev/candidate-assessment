import { describe, expect, it } from "vitest";
import jordan from "../../data/member-context.json";
import { compileMemberContextGraph } from "../../src/graph/ingest/member-context";
import {
  MemberContextValidationError,
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
});
