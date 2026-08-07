export function normalizeConceptText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizedBigrams(normalized: string): readonly string[] {
  if (normalized.length < 2) return normalized ? [normalized] : [];
  return Array.from({ length: normalized.length - 1 }, (_, index) => normalized.slice(index, index + 2));
}

const LOCAL_VECTOR_STOP_WORDS = new Set([
  "a", "an", "area", "bad", "hurting", "of", "painful", "region", "sore", "the",
]);

function localTextVector(normalized: string): ReadonlyMap<string, number> {
  const vector = new Map<string, number>();
  for (const token of normalized.split(" ")) {
    if (!token || LOCAL_VECTOR_STOP_WORDS.has(token)) continue;
    vector.set(token, (vector.get(token) ?? 0) + 1);
  }
  return vector;
}

export type ConceptTextProfile = {
  readonly normalized: string;
  readonly bigrams: readonly string[];
  readonly vector: ReadonlyMap<string, number>;
  readonly vectorMagnitudeSquared: number;
};

export function createConceptTextProfile(value: string): ConceptTextProfile {
  const normalized = normalizeConceptText(value);
  const vector = localTextVector(normalized);
  let vectorMagnitudeSquared = 0;
  for (const count of vector.values()) vectorMagnitudeSquared += count * count;
  return {
    normalized,
    bigrams: normalizedBigrams(normalized),
    vector,
    vectorMagnitudeSquared,
  };
}

/** Deterministic character-bigram Dice similarity for misspellings and small edits. */
export function fuzzyConceptProfileScore(left: ConceptTextProfile, right: ConceptTextProfile): number {
  if (left.bigrams.length === 0 || right.bigrams.length === 0) return 0;
  const remaining = new Map<string, number>();
  for (const bigram of right.bigrams) remaining.set(bigram, (remaining.get(bigram) ?? 0) + 1);
  let intersection = 0;
  for (const bigram of left.bigrams) {
    const count = remaining.get(bigram) ?? 0;
    if (count === 0) continue;
    intersection += 1;
    remaining.set(bigram, count - 1);
  }
  return (2 * intersection) / (left.bigrams.length + right.bigrams.length);
}

/** Cosine similarity over deterministic local text vectors; no runtime model is involved. */
export function localVectorProfileScore(left: ConceptTextProfile, right: ConceptTextProfile): number {
  if (left.vectorMagnitudeSquared === 0 || right.vectorMagnitudeSquared === 0) return 0;
  let dot = 0;
  for (const [token, value] of left.vector) dot += value * (right.vector.get(token) ?? 0);
  return dot / Math.sqrt(left.vectorMagnitudeSquared * right.vectorMagnitudeSquared);
}
