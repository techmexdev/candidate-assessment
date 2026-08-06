import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const checker = path.join(repositoryRoot, "scripts/check-production-isolation.mjs");
const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true })));
});

async function fixture(files: Record<string, string>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "production-isolation-"));
  fixtures.push(directory);
  await Promise.all(Object.entries(files).map(async ([file, contents]) => {
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }));
  return directory;
}

async function check(directory: string) {
  try {
    const result = await run(process.execPath, [checker], { cwd: directory });
    return { code: 0, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    const result = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: result.code, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }
}

describe("production isolation check", () => {
  it("passes against the production repository", async () => {
    const result = await check(repositoryRoot);

    expect(result).toMatchObject({ code: 0 });
  });

  it("rejects prototype CSS imports", async () => {
    const result = await check(await fixture({
      "src/app.css": '@import "../ui/prototype.css";',
      "ui/prototype.css": ".prototype {}",
    }));

    expect(result.code).toBe(1);
    expect(result.output).toContain("src/app.css references prototype archive ../ui/prototype.css");
  });

  it("rejects JavaScript and JSX prototype imports", async () => {
    const result = await check(await fixture({
      "src/page.jsx": 'import Prototype from "../ui/bridge.js"; export default Prototype;',
      "src/prototype.js": 'export { default } from "../ui/bridge.js";',
      "ui/bridge.js": "export default null;",
    }));

    expect(result.code).toBe(1);
    expect(result.output).toContain("src/page.jsx references prototype archive ../ui/bridge.js");
    expect(result.output).toContain("src/prototype.js references prototype archive ../ui/bridge.js");
  });

  it("rejects root config imports from the prototype archive", async () => {
    const result = await check(await fixture({
      "next.config.mjs": 'import "./ui/bridge.js"; export default {};',
      "ui/bridge.js": "export default null;",
    }));

    expect(result.code).toBe(1);
    expect(result.output).toContain("next.config.mjs references prototype archive ./ui/bridge.js");
  });

  it("resolves configured TypeScript aliases before allowing imports", async () => {
    const result = await check(await fixture({
      "src/page.ts": 'import "@prototype/bridge.js";',
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@prototype/*": ["./ui/*"] } } }),
      "ui/bridge.js": "export default null;",
    }));

    expect(result.code).toBe(1);
    expect(result.output).toContain("src/page.ts references prototype archive @prototype/bridge.js");
  });

  it("rejects production imports from test fixture builders", async () => {
    const result = await check(await fixture({
      "src/graph/seed.ts": 'import { buildFixture } from "../../tests/fixtures/member-builder"; export const seed = buildFixture();',
      "tests/fixtures/member-builder.ts": "export const buildFixture = () => ({ synthetic: true });",
    }));

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "src/graph/seed.ts references test fixture builder ../../tests/fixtures/member-builder",
    );
  });

  it("rejects operational script imports from test fixture builders", async () => {
    const result = await check(await fixture({
      "scripts/seed-member.ts": 'import { buildFixture } from "../tests/fixtures/member-builder"; buildFixture();',
      "tests/fixtures/member-builder.ts": "export const buildFixture = () => ({ synthetic: true });",
    }));

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "scripts/seed-member.ts references test fixture builder ../tests/fixtures/member-builder",
    );
  });
});
