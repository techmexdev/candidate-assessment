import type { ConceptCandidateFact } from "../contracts/movement-clinical-queries";
import type {
  CandidateSummary,
  ConceptMention,
  ConceptResolution,
  ConceptResolutionPolicy,
} from "../contracts/concept-resolution";
import type { GraphAuthority } from "../contracts/movement-graph";
import { normalizeConceptText } from "./text-normalization";

export const DEFAULT_RESOLUTION_POLICY: ConceptResolutionPolicy = {
  revision: "resolver-v3",
  exactThreshold: 1,
  fuzzyThreshold: 0.9,
  vectorThreshold: 0.75,
  safetyCriticalThreshold: 0.95,
  clarificationFloor: 0.7,
  minimumMargin: 0.1,
};

type ResolutionGraphContext = {
  readonly graphRevisionId: string;
  readonly authority: GraphAuthority;
};

type SupportedConceptCandidate = ConceptCandidateFact & {
  readonly groundingStatus: "active-mapping" | "local-only";
};

type ScoredPass = "fuzzy" | "vector";

function passScore(candidate: ConceptCandidateFact, pass: ScoredPass): number {
  return pass === "fuzzy" ? candidate.fuzzyScore : candidate.vectorScore;
}

function passAlias(candidate: ConceptCandidateFact, pass: "exact" | ScoredPass): string {
  if (pass === "exact") return candidate.exactMatchedAlias ?? candidate.label;
  return pass === "fuzzy" ? candidate.fuzzyMatchedAlias : candidate.vectorMatchedAlias;
}

function thresholdForPass(
  mention: ConceptMention,
  policy: ConceptResolutionPolicy,
  pass: "exact" | ScoredPass,
): number {
  if (pass === "exact") return policy.exactThreshold;
  if (mention.safetyCritical) return policy.safetyCriticalThreshold;
  return pass === "fuzzy" ? policy.fuzzyThreshold : policy.vectorThreshold;
}

function candidatesForPass<T extends ConceptCandidateFact>(candidates: readonly T[], pass: ScoredPass): T[] {
  return [...candidates]
    .filter((candidate) => passScore(candidate, pass) > 0)
    .sort((left, right) => passScore(right, pass) - passScore(left, pass)
      || left.conceptId.localeCompare(right.conceptId));
}

function candidateSummary(candidate: ConceptCandidateFact, pass: "exact" | ScoredPass): CandidateSummary {
  return {
    conceptId: candidate.conceptId,
    assertionId: candidate.assertionId,
    label: candidate.label,
    kind: candidate.kind,
    matchedAlias: passAlias(candidate, pass),
    confidence: pass === "exact" ? 1 : passScore(candidate, pass),
    ...(candidate.exactMatchedAlias ? { exactMatchedAlias: candidate.exactMatchedAlias } : {}),
    fuzzyMatchedAlias: candidate.fuzzyMatchedAlias,
    fuzzyScore: candidate.fuzzyScore,
    vectorMatchedAlias: candidate.vectorMatchedAlias,
    vectorScore: candidate.vectorScore,
    groundingStatus: candidate.groundingStatus,
    mappingAssertionIds: candidate.mappingAssertionIds,
  };
}

function strongestScoredPass(candidate: ConceptCandidateFact): ScoredPass {
  return candidate.vectorScore > candidate.fuzzyScore ? "vector" : "fuzzy";
}

function unresolved(
  mention: ConceptMention,
  context: ResolutionGraphContext,
  policy: ConceptResolutionPolicy,
  reason: Extract<ConceptResolution, { status: "clarify" | "unresolved" }>["reason"],
  candidates: readonly ConceptCandidateFact[],
  status: "clarify" | "unresolved" = "unresolved",
  pass: "exact" | ScoredPass = "vector",
): ConceptResolution {
  return {
    status,
    mention,
    reason,
    candidates: candidates.slice(0, 5).map((candidate) => candidateSummary(candidate, pass)),
    requiredConfidence: thresholdForPass(mention, policy, pass),
    graphRevisionId: context.graphRevisionId,
    authority: context.authority,
    policyRevision: policy.revision,
  };
}

function resolved(
  mention: ConceptMention,
  candidate: SupportedConceptCandidate,
  alternatives: readonly SupportedConceptCandidate[],
  context: ResolutionGraphContext,
  policy: ConceptResolutionPolicy,
  method: "exact" | ScoredPass,
  threshold: number,
): ConceptResolution {
  return {
    status: "resolved",
    mention,
    conceptId: candidate.conceptId,
    assertionId: candidate.assertionId,
    method,
    confidence: method === "exact" ? policy.exactThreshold : passScore(candidate, method),
    threshold,
    matchedAlias: passAlias(candidate, method),
    groundingStatus: candidate.groundingStatus,
    mappingAssertionIds: candidate.mappingAssertionIds,
    alternatives: alternatives.slice(0, 5).map((alternative) => candidateSummary(
      alternative,
      method === "exact" ? strongestScoredPass(alternative) : method,
    )),
    graphRevisionId: context.graphRevisionId,
    authority: context.authority,
    policyRevision: policy.revision,
  };
}

export function decideConceptResolution(
  mention: ConceptMention,
  candidates: readonly ConceptCandidateFact[],
  context: ResolutionGraphContext,
  policy: ConceptResolutionPolicy = DEFAULT_RESOLUTION_POLICY,
): ConceptResolution {
  const normalized = normalizeConceptText(mention.text);
  if (!normalized) return unresolved(mention, context, policy, "invalid-input", []);
  if (mention.safetyCritical && context.authority !== "canonical") return unresolved(mention, context, policy, "non-authoritative", []);
  if (candidates.length === 0) return unresolved(mention, context, policy, "no-candidate", []);

  const supported = candidates.filter(
    (candidate): candidate is SupportedConceptCandidate => candidate.groundingStatus !== "deprecated-mapping",
  );
  if (supported.length === 0) return unresolved(mention, context, policy, "deprecated-mapping", candidates);
  const exactCandidates = supported
    .filter((candidate) => candidate.exactMatchedAlias !== undefined)
    .sort((left, right) => left.conceptId.localeCompare(right.conceptId));
  if (exactCandidates.length > 1) return unresolved(mention, context, policy, "ambiguous", exactCandidates, "clarify", "exact");
  if (exactCandidates[0]) return resolved(
    mention,
    exactCandidates[0],
    supported.filter((candidate) => candidate.conceptId !== exactCandidates[0]!.conceptId),
    context,
    policy,
    "exact",
    policy.exactThreshold,
  );

  const fuzzyCandidates = candidatesForPass(supported, "fuzzy");
  const fuzzyThreshold = thresholdForPass(mention, policy, "fuzzy");
  const fuzzyTop = fuzzyCandidates[0];
  const fuzzyMargin = fuzzyTop ? fuzzyTop.fuzzyScore - (fuzzyCandidates[1]?.fuzzyScore ?? 0) : 0;
  if (fuzzyTop && fuzzyTop.fuzzyScore >= fuzzyThreshold && fuzzyMargin >= policy.minimumMargin) {
    return resolved(mention, fuzzyTop, fuzzyCandidates.slice(1), context, policy, "fuzzy", fuzzyThreshold);
  }

  const vectorCandidates = candidatesForPass(supported, "vector");
  const vectorThreshold = thresholdForPass(mention, policy, "vector");
  const vectorTop = vectorCandidates[0];
  const vectorMargin = vectorTop ? vectorTop.vectorScore - (vectorCandidates[1]?.vectorScore ?? 0) : 0;
  if (vectorTop && vectorTop.vectorScore >= vectorThreshold && vectorMargin >= policy.minimumMargin) {
    return resolved(mention, vectorTop, vectorCandidates.slice(1), context, policy, "vector", vectorThreshold);
  }

  if (vectorTop && vectorTop.vectorScore >= policy.clarificationFloor && vectorMargin < policy.minimumMargin) {
    return unresolved(mention, context, policy, "ambiguous", vectorCandidates, "clarify", "vector");
  }
  if (fuzzyTop && fuzzyTop.fuzzyScore >= policy.clarificationFloor && fuzzyMargin < policy.minimumMargin) {
    return unresolved(mention, context, policy, "ambiguous", fuzzyCandidates, "clarify", "fuzzy");
  }
  const belowThreshold = vectorTop ?? fuzzyTop;
  if (belowThreshold) {
    const pass = vectorTop ? "vector" : "fuzzy";
    return unresolved(mention, context, policy, "below-threshold", pass === "vector" ? vectorCandidates : fuzzyCandidates, "unresolved", pass);
  }
  return unresolved(mention, context, policy, "no-candidate", []);
}
