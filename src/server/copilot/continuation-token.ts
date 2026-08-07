import { createHmac, timingSafeEqual } from "node:crypto";
import {
  COPILOT_CANONICAL_INTENT_IDS,
  createSignedCopilotContinuation,
  type CopilotContinuationClaims,
  type SignedCopilotContinuation,
} from "../../domain/contracts/copilot";

export const COPILOT_CONTINUATION_MAX_TTL_MS = 15 * 60 * 1_000;
export const COPILOT_CONTINUATION_MAX_EVIDENCE_IDS = 100;

const LOCAL_SECRET = "axon-local-copilot-continuation-secret-v1-------";
const CLAIM_KEYS = [
  "schemaVersion",
  "coachId",
  "memberId",
  "contextRevisionId",
  "answerId",
  "intentId",
  "selectedEvidenceIds",
  "issuedAt",
  "expiresAt",
] as const;
const TOKEN_KEYS = ["schemaVersion", "algorithm", "claims", "signature"] as const;
const REVISION_ID = /^member-context:sha256:[a-f0-9]{64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function boundedId(value: unknown, maximum = 200): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseClaims(value: unknown): CopilotContinuationClaims | null {
  if (!record(value)
    || !exactKeys(value, CLAIM_KEYS)
    || value.schemaVersion !== "copilot-continuation-claims/v1"
    || !boundedId(value.coachId)
    || !boundedId(value.memberId)
    || typeof value.contextRevisionId !== "string"
    || !REVISION_ID.test(value.contextRevisionId)
    || !boundedId(value.answerId)
    || !COPILOT_CANONICAL_INTENT_IDS.includes(value.intentId as never)
    || !Array.isArray(value.selectedEvidenceIds)
    || value.selectedEvidenceIds.length > COPILOT_CONTINUATION_MAX_EVIDENCE_IDS
    || !value.selectedEvidenceIds.every((id) => boundedId(id))
    || new Set(value.selectedEvidenceIds).size !== value.selectedEvidenceIds.length
    || typeof value.issuedAt !== "string"
    || typeof value.expiresAt !== "string") return null;

  const issuedAt = Date.parse(value.issuedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || issuedAt >= expiresAt
    || expiresAt - issuedAt > COPILOT_CONTINUATION_MAX_TTL_MS) return null;
  return value as CopilotContinuationClaims;
}

function canonicalClaims(claims: Readonly<CopilotContinuationClaims>): string {
  return JSON.stringify({
    schemaVersion: claims.schemaVersion,
    coachId: claims.coachId,
    memberId: claims.memberId,
    contextRevisionId: claims.contextRevisionId,
    answerId: claims.answerId,
    intentId: claims.intentId,
    selectedEvidenceIds: [...claims.selectedEvidenceIds],
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  });
}

function signature(secret: string, claims: Readonly<CopilotContinuationClaims>): Buffer {
  return createHmac("sha256", secret).update(canonicalClaims(claims)).digest();
}

export function isSyntacticallyValidCopilotContinuation(value: unknown): value is SignedCopilotContinuation {
  return record(value)
    && exactKeys(value, TOKEN_KEYS)
    && value.schemaVersion === "signed-copilot-continuation/v1"
    && value.algorithm === "hmac-sha256"
    && parseClaims(value.claims) !== null
    && typeof value.signature === "string"
    && value.signature.length > 0
    && value.signature.length <= 100;
}

export function copilotContinuationSecret(environment: string, configured?: string): string {
  if (configured && Buffer.byteLength(configured) >= 32) return configured;
  if (["development", "test", "local"].includes(environment)) return LOCAL_SECRET;
  throw new Error("COPILOT_CONTINUATION_SECRET must contain at least 32 bytes");
}

export function createCopilotContinuationAuthority(options: {
  readonly secret: string;
  readonly now?: () => string;
}) {
  if (Buffer.byteLength(options.secret) < 32) throw new Error("Copilot continuation secret must contain at least 32 bytes");
  const now = options.now ?? (() => new Date().toISOString());
  return Object.freeze({
    async sign(input: Readonly<CopilotContinuationClaims>): Promise<SignedCopilotContinuation> {
      const claims = parseClaims(input);
      if (!claims) throw new Error("Copilot continuation claims or lifetime are invalid");
      const current = Date.parse(now());
      if (!Number.isFinite(current) || Date.parse(claims.issuedAt) > current) {
        throw new Error("Copilot continuation issue time is invalid");
      }
      return createSignedCopilotContinuation({
        claims,
        signature: signature(options.secret, claims).toString("base64url"),
      });
    },
    async verify(input: Readonly<SignedCopilotContinuation>): Promise<Readonly<CopilotContinuationClaims> | null> {
      if (!isSyntacticallyValidCopilotContinuation(input)) return null;
      let supplied: Buffer;
      try { supplied = Buffer.from(input.signature, "base64url"); } catch { return null; }
      const expected = signature(options.secret, input.claims);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
      const current = Date.parse(now());
      const issuedAt = Date.parse(input.claims.issuedAt);
      const expiresAt = Date.parse(input.claims.expiresAt);
      if (!Number.isFinite(current) || issuedAt > current || current >= expiresAt) return null;
      return Object.freeze(structuredClone(input.claims));
    },
  });
}
