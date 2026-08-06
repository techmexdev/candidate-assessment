import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function deriveRevisionId(schemaVersion: string, compilerVersion: string, sourceDigests: readonly [string, string][]) {
  return `graph:sha256:${sha256(canonicalJson({ schemaVersion, compilerVersion, sourceDigests }))}`;
}

export function deriveAssertionId(graphRevisionId: string, identity: unknown) {
  return `assertion:sha256:${sha256(canonicalJson({ graphRevisionId, identity }))}`;
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
