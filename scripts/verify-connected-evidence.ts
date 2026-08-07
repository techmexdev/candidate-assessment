import { readFile } from "node:fs/promises";
import { assertConnectedAcceptanceCapture } from "../src/domain/contracts/connected-acceptance";

const capturePath = process.env.CONNECTED_ACCEPTANCE_CAPTURE?.trim() || "docs/evidence/connected-acceptance-capture.json";

async function main() {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(capturePath, "utf8"));
  } catch (error) {
    throw new Error(`[ASSERTION] Unable to read connected evidence at ${capturePath}: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  assertConnectedAcceptanceCapture(parsed);
  process.stdout.write(`[PASS] connected evidence contract (${capturePath})\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "[ASSERTION] Connected evidence validation failed."}\n`);
  process.exitCode = 1;
});
