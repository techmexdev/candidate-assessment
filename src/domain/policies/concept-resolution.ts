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
  revision: "resolver-v2",
  exactThreshold: 1,
  fuzzyThreshold: 0.9,
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

function candidateSummary(candidate: ConceptCandidateFact): CandidateSummary {
  return {
    conceptId: candidate.conceptId,
    assertionId: candidate.assertionId,
    label: candidate.label,
    kind: candidate.kind,
    matchedAlias: candidate.matchedAlias,
    confidence: candidate.score,
    groundingStatus: candidate.groundingStatus,
    mappingAssertionIds: candidate.mappingAssertionIds,
  };
}

function unresolved(
  mention: ConceptMention,
  context: ResolutionGraphContext,
  policy: ConceptResolutionPolicy,
  reason: Extract<ConceptResolution, { status: "clarify" | "unresolved" }>["reason"],
  candidates: readonly ConceptCandidateFact[],
  status: "clarify" | "unresolved" = "unresolved",
): ConceptResolution {
  return {
    status,
    mention,
    reason,
    candidates: candidates.slice(0, 5).map(candidateSummary),
    requiredConfidence: mention.safetyCritical ? policy.safetyCriticalThreshold : policy.fuzzyThreshold,
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
  const exactCandidates = supported.filter((candidate) => candidate.exact);
  if (exactCandidates.length > 1) return unresolved(mention, context, policy, "ambiguous", exactCandidates, "clarify");

  const requiredThreshold = mention.safetyCritical ? policy.safetyCriticalThreshold : policy.fuzzyThreshold;
  const top = exactCandidates[0] ?? supported[0];
  if (!top) return unresolved(mention, context, policy, "no-candidate", []);
  if (top.exact) {
    return {
      status: "resolved",
      mention,
      conceptId: top.conceptId,
      assertionId: top.assertionId,
      method: "exact",
      confidence: policy.exactThreshold,
      threshold: policy.exactThreshold,
      matchedAlias: top.matchedAlias,
      groundingStatus: top.groundingStatus,
      mappingAssertionIds: top.mappingAssertionIds,
      alternatives: supported.filter((candidate) => candidate.conceptId !== top.conceptId).slice(0, 5).map(candidateSummary),
      graphRevisionId: context.graphRevisionId,
      authority: context.authority,
      policyRevision: policy.revision,
    };
  }

  const second = supported[1];
  const margin = top.score - (second?.score ?? 0);
  const summaries = supported.slice(0, 5).map(candidateSummary);
  if (top.score >= requiredThreshold && margin >= policy.minimumMargin) {
    return {
      status: "resolved",
      mention,
      conceptId: top.conceptId,
      assertionId: top.assertionId,
      method: top.score >= 0.85 ? "fuzzy" : "semantic",
      confidence: top.score,
      threshold: requiredThreshold,
      matchedAlias: top.matchedAlias,
      groundingStatus: top.groundingStatus,
      mappingAssertionIds: top.mappingAssertionIds,
      alternatives: summaries.slice(1),
      graphRevisionId: context.graphRevisionId,
      authority: context.authority,
      policyRevision: policy.revision,
    };
  }
  const clarify = top.score >= policy.clarificationFloor;
  return unresolved(
    mention,
    context,
    policy,
    clarify && margin < policy.minimumMargin ? "ambiguous" : "below-threshold",
    supported,
    clarify ? "clarify" : "unresolved",
  );
}
