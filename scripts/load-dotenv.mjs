import process from "node:process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const configuredPath = process.env.AXON_ENV_FILE?.trim() || ".env";
const envPath = resolve(process.cwd(), configuredPath);

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
