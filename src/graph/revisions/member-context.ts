import { createHash } from "node:crypto";
import type {
  MemberContextDocumentInput,
  MemberContextGraphSnapshot,
} from "../../domain/contracts/member-context";

export const MEMBER_CONTEXT_SCHEMA_VERSION = "1.0.0";
export const MEMBER_CONTEXT_COMPILER_VERSION = "1.0.0";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalMemberContextSource(document: MemberContextDocumentInput): MemberContextDocumentInput {
  return {
    ...structuredClone(document),
    equipment_available: [...document.equipment_available].sort((left, right) => left.localeCompare(right)),
  };
}

export function sourceArtifactDigest(document: MemberContextDocumentInput): `sha256:${string}` {
  return sha256(canonicalJson(canonicalMemberContextSource(document)));
}

export function contextRevisionId(
  sourceDigest: string,
  mappingDigest: string,
  schemaVersion = MEMBER_CONTEXT_SCHEMA_VERSION,
  compilerVersion = MEMBER_CONTEXT_COMPILER_VERSION,
): `member-context:sha256:${string}` {
  const digest = sha256(canonicalJson({ compilerVersion, mappingDigest, schemaVersion, sourceDigest }));
  return `member-context:${digest}`;
}

export function canonicalMemberContextDigest(snapshot: MemberContextGraphSnapshot): `sha256:${string}` {
  return sha256(canonicalJson(snapshot));
}

export function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
