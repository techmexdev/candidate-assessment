import { describe, expect, it } from "vitest";
import jordan from "../../data/member-context.json";
import avery from "../../data/member-context-avery.json";
import { buildMemberContextSnapshot } from "../../src/graph/ingest/member-context";
import { InMemoryMemberContextRepository } from "../../src/graph/repositories/member-context";

describe("member context graph", () => {
  const jordanSnapshot = buildMemberContextSnapshot(jordan, "dataset-v1");
  const averySnapshot = buildMemberContextSnapshot(avery, "dataset-v1");
  const repository = new InMemoryMemberContextRepository([jordanSnapshot, averySnapshot]);

  it("preserves every required synthetic member domain as revisioned evidence", () => {
    const kinds = new Set(jordanSnapshot.evidence.map((evidence) => evidence.kind));

    expect(jordanSnapshot.synthetic).toBe(true);
    expect(jordanSnapshot.contextRevision).toMatch(/^context-/);
    expect([...kinds]).toEqual(expect.arrayContaining([
      "profile",
      "goal",
      "preference",
      "equipment",
      "injury",
      "workout",
      "adherence",
      "biomarker",
      "lab",
      "message",
      "image",
      "coach-task",
      "churn-signal",
    ]));
  });

  it("scopes snapshots to the coach and member without leaking evidence", () => {
    expect(repository.getSnapshot({ coachId: jordan.profile.coach_id, memberId: jordan.profile.id }).status).toBe("ready");
    expect(repository.getSnapshot({ coachId: jordan.profile.coach_id, memberId: avery.profile.id }).status).toBe("ready");
    expect(repository.getSnapshot({ coachId: "coach_other", memberId: jordan.profile.id }).status).toBe("denied");
    expect(repository.getSnapshot({ coachId: "coach_other", memberId: jordan.profile.id }, "missing-revision").status).toBe("denied");
    expect(repository.listEvidence({ coachId: jordan.profile.coach_id, memberId: jordan.profile.id }, "message").every((item) => item.memberId === jordan.profile.id)).toBe(true);
  });

  it("creates stable revisions and preserves historical snapshots", () => {
    const next = buildMemberContextSnapshot(jordan, "dataset-v2");

    expect(next.contextRevision).not.toBe(jordanSnapshot.contextRevision);
    expect(next.datasetRevision).not.toBe(jordanSnapshot.datasetRevision);
    expect(repository.addSnapshot(next).status).toBe("ready");
    const historical = repository.getSnapshot({ coachId: jordan.profile.coach_id, memberId: jordan.profile.id }, jordanSnapshot.contextRevision);
    expect(historical.status).toBe("ready");
    if (historical.status === "ready") expect(historical.data.datasetRevision).toBe("dataset-v1");
  });
});
