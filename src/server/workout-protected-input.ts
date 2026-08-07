import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { WorkoutRunId } from "../domain/contracts/workout";

const PREFIX = "protected-prompt:v1";
const MAX_ENTRIES = 8;

type ProtectedWorkoutInputPayload = {
  readonly version: 1;
  readonly coachId: string;
  readonly memberId: string;
  readonly runId: string;
  readonly entries: readonly string[];
};

export type ProtectedWorkoutInputScope = {
  readonly coachId: string;
  readonly memberId: string;
  readonly runId: WorkoutRunId | string;
};

function key(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function associatedData(scope: ProtectedWorkoutInputScope): Buffer {
  return Buffer.from(JSON.stringify([PREFIX, scope.coachId, scope.memberId, scope.runId]), "utf8");
}

function validPayload(value: unknown, scope: ProtectedWorkoutInputScope): value is ProtectedWorkoutInputPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Partial<ProtectedWorkoutInputPayload>;
  return payload.version === 1
    && payload.coachId === scope.coachId
    && payload.memberId === scope.memberId
    && payload.runId === scope.runId
    && Array.isArray(payload.entries)
    && payload.entries.length > 0
    && payload.entries.length <= MAX_ENTRIES
    && payload.entries.every((entry) => typeof entry === "string" && entry.trim().length > 0 && entry.length <= 2_000);
}

/**
 * Server-only authenticated encryption for prompt input revisions. The sealed
 * value is durable in the run record, while plaintext is available only after
 * an exact coach/member/run scope check.
 */
export function createProtectedWorkoutInputVault(secret: string) {
  const encryptionKey = key(secret);

  const read = (snapshotId: string, scope: ProtectedWorkoutInputScope):
    | { readonly status: "ready"; readonly entries: readonly string[] }
    | { readonly status: "invalid" } => {
    const [prefix, version, encodedIv, encodedCiphertext, encodedTag, extra] = snapshotId.split(":");
    if (`${prefix}:${version}` !== PREFIX || !encodedIv || !encodedCiphertext || !encodedTag || extra) return { status: "invalid" };
    try {
      const iv = Buffer.from(encodedIv, "base64url");
      const ciphertext = Buffer.from(encodedCiphertext, "base64url");
      const tag = Buffer.from(encodedTag, "base64url");
      if (iv.byteLength !== 12 || tag.byteLength !== 16 || ciphertext.byteLength === 0 || ciphertext.byteLength > 20_000) {
        return { status: "invalid" };
      }
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
      decipher.setAAD(associatedData(scope));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      const payload: unknown = JSON.parse(plaintext);
      return validPayload(payload, scope) ? { status: "ready", entries: [...payload.entries] } : { status: "invalid" };
    } catch {
      return { status: "invalid" };
    }
  };

  const protect = (input: ProtectedWorkoutInputScope & {
    readonly prompt: string;
    readonly previousProtectedPromptSnapshotId?: string;
  }): { readonly status: "stored"; readonly protectedPromptSnapshotId: string } | { readonly status: "failed" } => {
    const prompt = input.prompt.trim();
    if (!prompt || prompt.length > 2_000) return { status: "failed" };
    const previous = input.previousProtectedPromptSnapshotId
      ? read(input.previousProtectedPromptSnapshotId, input)
      : undefined;
    if (previous?.status === "invalid") return { status: "failed" };
    const entries = [...(previous?.entries ?? []), prompt];
    if (entries.length > MAX_ENTRIES) return { status: "failed" };
    const payload: ProtectedWorkoutInputPayload = {
      version: 1,
      coachId: input.coachId,
      memberId: input.memberId,
      runId: input.runId,
      entries,
    };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    cipher.setAAD(associatedData(input));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      status: "stored",
      protectedPromptSnapshotId: `${PREFIX}:${iv.toString("base64url")}:${ciphertext.toString("base64url")}:${tag.toString("base64url")}`,
    };
  };

  return Object.freeze({ protect, read });
}
