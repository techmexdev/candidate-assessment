import { describe, expect, it } from "vitest";
import { createProtectedWorkoutInputVault } from "../../src/server/workout-protected-input";

describe("protected workout input vault", () => {
  it("encrypts prompt revisions, binds them to scope, and appends clarification input", () => {
    const vault = createProtectedWorkoutInputVault("s".repeat(32));
    const scope = { coachId: "coach:one", memberId: "member:one", runId: "workout-run:one" };
    const first = vault.protect({ ...scope, prompt: "Lower-body strength" });
    expect(first.status).toBe("stored");
    if (first.status !== "stored") throw new Error("protection failed");
    expect(first.protectedPromptSnapshotId).not.toContain("Lower-body strength");
    expect(vault.read(first.protectedPromptSnapshotId, { ...scope, memberId: "member:other" })).toEqual({ status: "invalid" });

    const second = vault.protect({
      ...scope,
      prompt: JSON.stringify({ injuries: { "evidence:knee": { recoveryStage: "return-to-training" } } }),
      previousProtectedPromptSnapshotId: first.protectedPromptSnapshotId,
    });
    expect(second.status).toBe("stored");
    if (second.status !== "stored") throw new Error("clarification protection failed");
    expect(vault.read(second.protectedPromptSnapshotId, scope)).toEqual({
      status: "ready",
      entries: ["Lower-body strength", JSON.stringify({ injuries: { "evidence:knee": { recoveryStage: "return-to-training" } } })],
    });
  });

  it("rejects ciphertext tampering", () => {
    const vault = createProtectedWorkoutInputVault("s".repeat(32));
    const scope = { coachId: "coach:one", memberId: "member:one", runId: "workout-run:one" };
    const sealed = vault.protect({ ...scope, prompt: "Upper-body strength" });
    if (sealed.status !== "stored") throw new Error("protection failed");
    const parts = sealed.protectedPromptSnapshotId.split(":");
    parts[3] = `${parts[3]![0] === "A" ? "B" : "A"}${parts[3]!.slice(1)}`;
    const tampered = parts.join(":");
    expect(vault.read(tampered, scope)).toEqual({ status: "invalid" });
  });
});
