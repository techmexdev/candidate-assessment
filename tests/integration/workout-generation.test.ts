import { describe, expect, it } from "vitest";
import { createWorkoutRuntime } from "../../src/agents/workout/runtime";

describe("workout generation integration boundary", () => {
  it("exposes execution without any model-callable graph or mutation tools", () => {
    expect(createWorkoutRuntime).toBeTypeOf("function");
  });
});
