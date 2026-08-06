import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MEMBER_CONTEXT_NODE_KINDS,
  MEMBER_CONTEXT_RELATIONSHIP_KINDS,
} from "../../src/domain/contracts/member-context";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const documentPath = path.join(repositoryRoot, "docs/graph/member-context-schema.md");

describe("member context graph documentation", () => {
  it("names every shipped node and relationship kind", async () => {
    const documentation = await readFile(documentPath, "utf8");

    for (const kind of MEMBER_CONTEXT_NODE_KINDS) expect(documentation).toContain(`\`${kind}\``);
    for (const kind of MEMBER_CONTEXT_RELATIONSHIP_KINDS) expect(documentation).toContain(`\`${kind}\``);
  });

  it("defines the graph boundaries, operating contract, and two diagrams", async () => {
    const documentation = await readFile(documentPath, "utf8");

    expect(documentation.match(/```mermaid/g)).toHaveLength(2);
    for (const phrase of [
      "data/member-context.json",
      "source locator",
      "temporal precision",
      "PROV-O",
      "COPPER",
      "Movement/Clinical",
      "stable-reference property",
      "compare-and-swap",
      "bounded application read port",
      "insufficient_history",
      "backend_unavailable",
      "Semantic indexes are deferred",
      "synthetic only",
      "not clinically validated",
      "image contents are not analyzed",
      "Copilot is not implemented",
      "pin-and-cite",
    ]) expect(documentation).toContain(phrase);
  });

  it("references commands and files that exist from the repository root", async () => {
    const documentation = await readFile(documentPath, "utf8");

    for (const command of [
      "pnpm graph:seed:member -- --dry-run",
      "pnpm graph:seed:member",
      "pnpm graph:seed:member -- --inspect",
      "pnpm test:integration",
    ]) expect(documentation).toContain(command);

    for (const file of [
      "data/member-context.json",
      "data/member-context-concept-mappings.json",
      "data/member-context-synthetic-sources.json",
      "scripts/seed-member-context.ts",
      "src/application/use-cases/retrieve-member-context.ts",
    ]) await expect(access(path.join(repositoryRoot, file))).resolves.toBeUndefined();
  });
});
