import { describe, expect, it, vi } from "vitest";
import type { MovementGraphPublisher } from "../../src/domain/contracts/movement-graph-publication";
import { prepareMovementGraphSeed, runMovementGraphSeedCli } from "../../scripts/seed-movement-graph";

describe("movement graph seed CLI", () => {
  it("returns an invalid seed result for malformed source manifests", () => {
    expect(() => prepareMovementGraphSeed({ sourceReviews: null })).not.toThrow();
    expect(prepareMovementGraphSeed({ sourceReviews: null })).toMatchObject({
      status: "invalid",
      validationStatus: "invalid",
      validationErrors: expect.arrayContaining(["invalid_source_manifest"]),
    });
  });

  it.each([
    { label: "active revision", args: ["inspect"], requestedRevisionId: undefined },
    {
      label: "named persisted revision",
      args: ["inspect", "--revision", "graph:sha256:persisted"],
      requestedRevisionId: "graph:sha256:persisted",
    },
  ])("inspects the $label without preparing invalid current seed inputs", async ({ args, requestedRevisionId }) => {
    const inspectedRevisionId = requestedRevisionId ?? "graph:sha256:active";
    const prepareSeed = vi.fn(() => ({
      status: "invalid" as const,
      validationStatus: "invalid" as const,
      validationErrors: ["invalid_current_source_manifest"],
    }));
    const inspect = vi.fn(async () => ({
      status: "ok" as const,
      data: {
        state: "sealed" as const,
        activeRevisionId: "graph:sha256:active",
        revisionId: inspectedRevisionId,
        validationErrors: [],
      },
    }));
    const publisher: MovementGraphPublisher = {
      stage: async () => { throw new Error("unexpected stage"); },
      validate: async () => { throw new Error("unexpected validate"); },
      activate: async () => { throw new Error("unexpected activate"); },
      inspect,
    };
    const close = vi.fn(async () => undefined);
    const writeOutput = vi.fn();

    await runMovementGraphSeedCli(args, {
      prepareSeed,
      openPublisher: async () => ({ publisher, close }),
      writeOutput,
    });

    expect(prepareSeed).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledWith(requestedRevisionId);
    expect(writeOutput).toHaveBeenCalledWith(`${JSON.stringify({
      validationStatus: "sealed",
      activeRevisionId: "graph:sha256:active",
      graphRevisionId: inspectedRevisionId,
    })}\n`);
    expect(close).toHaveBeenCalledOnce();
  });
});
