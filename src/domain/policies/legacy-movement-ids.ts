import legacyIds from "../../../data/movement-legacy-ids.json";

export type LegacyMovementIdTranslation =
  | { readonly status: "translated"; readonly legacyId: string; readonly conceptId: string }
  | { readonly status: "unknown"; readonly legacyId: string }
  | { readonly status: "ambiguous"; readonly legacyId: string; readonly conceptIds: readonly string[] };

const reviewedTranslations = new Map<string, readonly string[]>();
for (const record of legacyIds.records) {
  if (record.review.status !== "reviewed") continue;
  const existing = reviewedTranslations.get(record.legacy_id) ?? [];
  reviewedTranslations.set(record.legacy_id, [...new Set([...existing, record.stable_id])].sort());
}

export function translateLegacyMovementConceptId(legacyId: string): LegacyMovementIdTranslation {
  const conceptIds = reviewedTranslations.get(legacyId);
  if (!conceptIds || conceptIds.length === 0) return { status: "unknown", legacyId };
  if (conceptIds.length > 1) return { status: "ambiguous", legacyId, conceptIds };
  return { status: "translated", legacyId, conceptId: conceptIds[0]! };
}
