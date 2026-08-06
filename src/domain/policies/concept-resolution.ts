import type {
  ConceptMention,
  ConceptResolution,
  ConceptResolutionBatch,
  ConceptResolutionPolicy,
} from "../contracts/concept-resolution";
import type { MovementGraphRepository } from "../contracts/movement-graph";
import { normalizeConceptText } from "./text-normalization";

export const DEFAULT_RESOLUTION_POLICY: ConceptResolutionPolicy = {
  revision: "resolver-v1",
  exactThreshold: 1,
  fuzzyThreshold: 0.9,
  safetyCriticalThreshold: 0.95,
  clarificationFloor: 0.7,
  minimumMargin: 0.1,
};

function candidateSummary(candidate: ReturnType<MovementGraphRepository["findConceptCandidates"]>[number]) {
  return {
    conceptId: candidate.node.id,
    label: candidate.node.label,
    kind: candidate.node.kind,
    matchedAlias: candidate.matchedAlias,
    confidence: candidate.score,
  };
}

export function resolveConcept(
  repository: MovementGraphRepository,
  mention: ConceptMention,
  policy: ConceptResolutionPolicy = DEFAULT_RESOLUTION_POLICY,
): ConceptResolution {
  const normalized = normalizeConceptText(mention.text);
  const requiredThreshold = mention.safetyCritical ? policy.safetyCriticalThreshold : policy.fuzzyThreshold;
  if (!normalized) {
    return { status: "unresolved", mention, reason: "invalid-input", candidates: [], requiredConfidence: requiredThreshold, policyRevision: policy.revision };
  }

  const candidates = repository.findConceptCandidates(mention.text, mention.kind);
  if (candidates.length === 0) {
    return { status: "unresolved", mention, reason: "no-candidate", candidates: [], requiredConfidence: requiredThreshold, policyRevision: policy.revision };
  }

  const exactCandidates = candidates.filter((candidate) => candidate.exact);
  if (exactCandidates.length === 1) {
    const exact = exactCandidates[0];
    return {
      status: "resolved",
      mention,
      conceptId: exact.node.id,
      method: "exact",
      confidence: policy.exactThreshold,
      threshold: policy.exactThreshold,
      matchedAlias: exact.matchedAlias,
      alternatives: candidates.filter((candidate) => candidate.node.id !== exact.node.id).slice(0, 5).map(candidateSummary),
      policyRevision: policy.revision,
    };
  }
  if (exactCandidates.length > 1) {
    return {
      status: "clarify",
      mention,
      reason: "ambiguous",
      candidates: exactCandidates.map(candidateSummary),
      requiredConfidence: requiredThreshold,
      policyRevision: policy.revision,
    };
  }

  const top = candidates[0];
  const second = candidates[1];
  const margin = top.score - (second?.score ?? 0);
  const method = top.score >= 0.85 ? "fuzzy" : "semantic";
  const summaries = candidates.slice(0, 5).map(candidateSummary);
  if (top.score >= requiredThreshold && margin >= policy.minimumMargin) {
    return {
      status: "resolved",
      mention,
      conceptId: top.node.id,
      method,
      confidence: top.score,
      threshold: requiredThreshold,
      matchedAlias: top.matchedAlias,
      alternatives: summaries.slice(1),
      policyRevision: policy.revision,
    };
  }

  return {
    status: top.score >= policy.clarificationFloor ? "clarify" : "unresolved",
    mention,
    reason: top.score >= policy.clarificationFloor ? (margin < policy.minimumMargin ? "ambiguous" : "below-threshold") : "below-threshold",
    candidates: summaries,
    requiredConfidence: requiredThreshold,
    policyRevision: policy.revision,
  };
}

export function resolveConcepts(
  repository: MovementGraphRepository,
  mentions: ConceptMention[],
  policy: ConceptResolutionPolicy = DEFAULT_RESOLUTION_POLICY,
): ConceptResolutionBatch {
  const resolutions = mentions.map((mention) => resolveConcept(repository, mention, policy));
  if (resolutions.some((resolution) => resolution.status !== "resolved")) return { status: "needs_clarification", resolutions };
  return { status: "resolved", resolutions: resolutions as Extract<ConceptResolution, { status: "resolved" }>[] };
}
