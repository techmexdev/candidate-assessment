export type CatalogSafetySecurityAuditEvent = {
  readonly kind: "catalog-safety-security";
  readonly statusCode:
    | "authorization-denied"
    | "evaluation-fail-closed"
    | "token-rejected"
    | "session-superseded"
    | "session-invalidated";
  readonly coachId: string;
  readonly memberId: string;
  readonly evaluationSessionId?: string;
  readonly movementGraphRevisionId?: string;
  readonly memberContextRevisionId?: string;
  readonly reasonCode?: string;
  readonly assertionIds: readonly string[];
  readonly evidenceIds: readonly string[];
};

export type CatalogSafetySecurityAudit = {
  readonly record: (event: CatalogSafetySecurityAuditEvent) => void | Promise<void>;
};

export async function recordCatalogSafetyAudit(
  audit: CatalogSafetySecurityAudit,
  event: CatalogSafetySecurityAuditEvent,
) {
  try {
    await audit.record(event);
  } catch {
    // Auditing must not leak a backend error or turn a denial into access.
  }
}
