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
  private readonly tokensByScope = new Map<string, Set<string>>();

  private remove(token: string) {
    const record = this.records.get(token);
    if (!record) return undefined;
    this.records.delete(token);
    const scope = scopeKey(record);
    const scopeTokens = this.tokensByScope.get(scope);
    scopeTokens?.delete(token);
    if (scopeTokens?.size === 0) this.tokensByScope.delete(scope);
    return record;
  }

  private isExpired(record: CatalogSafetySessionRecord, nowTimestamp: number) {
    const expiresTimestamp = Date.parse(record.expiresAt);
    return !Number.isFinite(nowTimestamp)
      || !Number.isFinite(expiresTimestamp)
      || expiresTimestamp <= nowTimestamp;
  }

  private removeExpired(scope: string, now: string) {
    const timestamp = Date.parse(now);
    const scopeTokens = this.tokensByScope.get(scope);
    if (!scopeTokens) return;
    for (const token of scopeTokens) {
      const record = this.records.get(token);
      if (!record) scopeTokens.delete(token);
      else if (this.isExpired(record, timestamp)) this.remove(token);
    }
    if (scopeTokens.size === 0) this.tokensByScope.delete(scope);
  }

  retain(record: CatalogSafetySessionRecord, now: string): CatalogSafetySessionRetainResult {
    const scope = scopeKey(record);
    this.removeExpired(scope, now);
    const nowTimestamp = Date.parse(now);
    const collision = this.records.get(record.token);
    if (collision) {
      if (!this.isExpired(collision, nowTimestamp)) return { status: "collision" };
      this.remove(collision.token);
    }
    const superseded: CatalogSafetySessionRecord[] = [];
    let activeOutsideRun = 0;
    for (const token of this.tokensByScope.get(scope) ?? []) {
      const candidate = this.records.get(token);
      if (!candidate) continue;
      if (candidate.runId === record.runId) superseded.push(candidate);
      else activeOutsideRun += 1;
    }
    if (activeOutsideRun >= CATALOG_SAFETY_MAX_ACTIVE_SESSIONS_PER_SCOPE) return { status: "capacity" };
    for (const candidate of superseded) this.remove(candidate.token);
    this.records.set(record.token, record);
    const scopeTokens = this.tokensByScope.get(scope) ?? new Set<string>();
    scopeTokens.add(record.token);
    this.tokensByScope.set(scope, scopeTokens);
    return { status: "stored", superseded };
  }

  lookup(token: string, now: string): CatalogSafetySessionLookup {
    const record = this.records.get(token);
    if (!record) return { status: "absent" };
    if (this.isExpired(record, Date.parse(now))) {
      this.remove(token);
      return { status: "expired" };
    }
    return { status: "found", record };
  }

  invalidate(token: string) {
    return this.remove(token);
  }
}

export type CatalogSafetyTokenSource = {
  /** Implementations must use a cryptographically secure random source. */
  readonly randomBytes: (length: number) => Uint8Array;
};
