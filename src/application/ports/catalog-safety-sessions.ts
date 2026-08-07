import type { CatalogSafetyReadyResult } from "../../domain/contracts/catalog-safety";
import type { MemberContextAccessClaims } from "./graph-repositories";

export const CATALOG_SAFETY_SESSION_TTL_MS = 10 * 60 * 1_000;
export const CATALOG_SAFETY_MAX_ACTIVE_SESSIONS_PER_SCOPE = 128;

export type CatalogSafetySessionRecord = {
  readonly token: string;
  readonly evaluationSessionId: string;
  readonly runId: string;
  readonly claims: Readonly<MemberContextAccessClaims>;
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly constraintDigest: string;
  readonly result: CatalogSafetyReadyResult;
  readonly createdAt: string;
  readonly expiresAt: string;
};

export type CatalogSafetySessionLookup =
  | { readonly status: "found"; readonly record: CatalogSafetySessionRecord }
  | { readonly status: "absent" | "expired" };

export type CatalogSafetySessionRetainResult =
  | { readonly status: "stored"; readonly superseded: readonly CatalogSafetySessionRecord[] }
  | { readonly status: "capacity" | "collision" };

export interface CatalogSafetySessionStore {
  retain(record: CatalogSafetySessionRecord, now: string): CatalogSafetySessionRetainResult;
  lookup(token: string, now: string): CatalogSafetySessionLookup;
  invalidate(token: string): CatalogSafetySessionRecord | undefined;
}

function scopeKey(record: Pick<CatalogSafetySessionRecord, "claims">) {
  return `${record.claims.coachId}\0${record.claims.memberId}`;
}

/** Process-local storage. Callers must request a fresh evaluation after restart. */
export class InMemoryCatalogSafetySessionStore implements CatalogSafetySessionStore {
  private readonly records = new Map<string, CatalogSafetySessionRecord>();

  private removeExpired(now: string) {
    const timestamp = Date.parse(now);
    for (const [token, record] of this.records) {
      if (Date.parse(record.expiresAt) <= timestamp) this.records.delete(token);
    }
  }

  retain(record: CatalogSafetySessionRecord, now: string): CatalogSafetySessionRetainResult {
    this.removeExpired(now);
    if (this.records.has(record.token)) return { status: "collision" };
    const scope = scopeKey(record);
    const superseded = [...this.records.values()].filter((candidate) => (
      scopeKey(candidate) === scope && candidate.runId === record.runId
    ));
    const activeOutsideRun = [...this.records.values()].filter((candidate) => (
      scopeKey(candidate) === scope && candidate.runId !== record.runId
    )).length;
    if (activeOutsideRun >= CATALOG_SAFETY_MAX_ACTIVE_SESSIONS_PER_SCOPE) return { status: "capacity" };
    for (const candidate of superseded) this.records.delete(candidate.token);
    this.records.set(record.token, record);
    return { status: "stored", superseded };
  }

  lookup(token: string, now: string): CatalogSafetySessionLookup {
    const record = this.records.get(token);
    if (!record) return { status: "absent" };
    if (Date.parse(record.expiresAt) <= Date.parse(now)) {
      this.records.delete(token);
      return { status: "expired" };
    }
    return { status: "found", record };
  }

  invalidate(token: string) {
    const record = this.records.get(token);
    if (record) this.records.delete(token);
    return record;
  }
}

export type CatalogSafetyTokenSource = {
  /** Implementations must use a cryptographically secure random source. */
  readonly randomBytes: (length: number) => Uint8Array;
};
