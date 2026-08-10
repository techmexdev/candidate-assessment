import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MEMBER_CONTEXT_NODE_KINDS,
  MEMBER_CONTEXT_RELATIONSHIP_KINDS,
} from "../../src/domain/contracts/member-context";
import {
  CATALOG_SAFETY_MAX_ACTIVE_SESSIONS_PER_SCOPE,
  CATALOG_SAFETY_SESSION_TTL_MS,
} from "../../src/application/ports/catalog-safety-sessions";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const documentPath = path.join(repositoryRoot, "docs/graph/member-context-schema.md");
const auditContractPath = path.join(repositoryRoot, "src/application/ports/security-audit.ts");

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
      "data/member-context-avery.json",
      "data/member-context-morgan.json",
      "MEMBER_CONTEXT_SEED_TARGETS",
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
      "Semantic indexes remain deferred",
      "synthetic only",
      "not clinically validated",
      "image contents are not analyzed",
      "graph layer does not itself generate Copilot answers",
      "pin-and-cite",
    ]) expect(documentation).toContain(phrase);
  });

  it("documents the Copilot exact-retrieval, churn, failure, and evaluation boundaries", async () => {
    const documentation = await readFile(documentPath, "utf8");

    for (const phrase of [
      "Copilot exact-retrieval and answer boundary",
      "copilot-intents/v1",
      "changes-since-last-week",
      "churn-v1",
      "insufficient-history",
      "unsupported login frequency",
      "deterministic fake model",
      "Language quality and elapsed latency",
      "Production isolation",
      "synthetic-dashboard-base.ts",
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
      "data/member-context-avery.json",
      "data/member-context-morgan.json",
      "data/member-context-concept-mappings.json",
      "data/member-context-synthetic-sources.json",
      "scripts/seed-member-context.ts",
      "src/application/use-cases/retrieve-member-context.ts",
    ]) await expect(access(path.join(repositoryRoot, file))).resolves.toBeUndefined();
  });

  it("documents the safety projection, dual-revision handoff, and fail-closed applicability", async () => {
    const documentation = await readFile(documentPath, "utf8");

    for (const phrase of [
      "Workout safety constraint projection",
      "getWorkoutConstraints",
      "memberContextRevisionId",
      "movementGraphRevisionId",
      "incomplete applicability",
      "fail closed",
      "separately cited run constraint",
      "graph-controlled",
    ]) expect(documentation).toContain(phrase);
  });

  it("documents server-owned evaluation sessions and the diagnostic allowlist", async () => {
    const documentation = await readFile(documentPath, "utf8");
    const auditContract = await readFile(auditContractPath, "utf8");

    for (const phrase of [
      "Evaluation session lifecycle",
      "128 bits",
      "evaluationSessionId",
      "constraint digest",
      "re-authorizes",
      "10 minutes",
      "128 active",
      "capacity",
      "supersession",
      "explicit invalidation",
      "fresh dual-revision evaluation",
      "process-local",
      "Diagnostic allowlist",
      "status and reason codes",
      "raw injury, applicability, preference, or prompt values",
    ]) expect(documentation).toContain(phrase);

    expect(documentation).toContain(`${CATALOG_SAFETY_SESSION_TTL_MS / 60_000} minutes`);
    expect(documentation).toContain(`${CATALOG_SAFETY_MAX_ACTIVE_SESSIONS_PER_SCOPE} active`);
    for (const statusCode of [
      "authorization-denied",
      "evaluation-fail-closed",
      "token-rejected",
      "candidate-validation-rejected",
      "session-superseded",
      "session-invalidated",
    ]) {
      expect(auditContract).toContain(`"${statusCode}"`);
      expect(documentation).toContain(`\`${statusCode}\``);
    }
  });
});
