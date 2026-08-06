import {
  RESOLVABLE_CONCEPT_KINDS,
  conceptKindsForQuery,
  type ConceptMention,
  type ConceptResolution,
  type ConceptResolutionBatch,
  type ConceptResolutionPolicy,
} from "../../domain/contracts/concept-resolution";
import type { MovementGraphReadProvider } from "../../domain/contracts/movement-clinical-queries";
import { decideConceptResolution, DEFAULT_RESOLUTION_POLICY } from "../../domain/policies/concept-resolution";

export const CONCEPT_RESOLUTION_LIMITS = Object.freeze({ maxMentions: 16, maxTextLength: 200, maxCandidates: 20 });

export type ResolveMovementConceptsRequest = {
  readonly mentions: readonly ConceptMention[];
  readonly graphRevisionId?: string;
  readonly policy?: ConceptResolutionPolicy;
};

const validKinds = new Set<string>([...RESOLVABLE_CONCEPT_KINDS, "anatomy"]);

function failedResolution(
  mention: ConceptMention,
  reason: Extract<ConceptResolution, { status: "unresolved" | "clarify" }>["reason"],
  graphRevisionId: string,
  policy: ConceptResolutionPolicy,
): ConceptResolution {
  return {
    status: "unresolved",
    mention,
    reason,
    candidates: [],
    requiredConfidence: mention.safetyCritical ? policy.safetyCriticalThreshold : policy.fuzzyThreshold,
    graphRevisionId,
    authority: "canonical",
    policyRevision: policy.revision,
  };
}

export async function resolveMovementConcepts(
  provider: MovementGraphReadProvider,
  request: ResolveMovementConceptsRequest,
): Promise<ConceptResolutionBatch> {
  const policy = request.policy ?? DEFAULT_RESOLUTION_POLICY;
  const unavailableRevision = request.graphRevisionId ?? "graph:unavailable";
  if (request.mentions.length === 0 || request.mentions.length > CONCEPT_RESOLUTION_LIMITS.maxMentions) {
    return {
      status: "failed_closed",
      resolutions: request.mentions.slice(0, CONCEPT_RESOLUTION_LIMITS.maxMentions).map((mention) => failedResolution(mention, "invalid-input", unavailableRevision, policy)),
    };
  }

  const opened = request.graphRevisionId
    ? await provider.openRevision(request.graphRevisionId)
    : await provider.openActive();
  if (opened.status !== "ready") {
    return { status: "failed_closed", resolutions: request.mentions.map((mention) => failedResolution(mention, "graph-unavailable", unavailableRevision, policy)) };
  }

  const context = { graphRevisionId: opened.handle.graphRevisionId, authority: opened.handle.authority };
  const resolutions: ConceptResolution[] = [];
  for (const mention of request.mentions) {
    if (mention.text.length > CONCEPT_RESOLUTION_LIMITS.maxTextLength || (mention.kind !== undefined && !validKinds.has(mention.kind))) {
      resolutions.push(failedResolution(mention, "invalid-input", opened.handle.graphRevisionId, policy));
      continue;
    }
    const kinds = mention.kind ? conceptKindsForQuery(mention.kind) : RESOLVABLE_CONCEPT_KINDS;
    const result = await opened.handle.resolveConceptCandidates({ text: mention.text, kinds, maxResults: CONCEPT_RESOLUTION_LIMITS.maxCandidates });
    resolutions.push(result.status === "ok"
      ? decideConceptResolution(mention, result.data, context, policy)
      : failedResolution(mention, result.failure.code === "invalid_query" ? "invalid-input" : "graph-unavailable", opened.handle.graphRevisionId, policy));
  }

  if (resolutions.every((resolution) => resolution.status === "resolved")) {
    return { status: "resolved", resolutions: resolutions as Extract<ConceptResolution, { status: "resolved" }>[] };
  }
  const failedClosed = resolutions.some((resolution) => resolution.status !== "resolved"
    && ["invalid-input", "graph-unavailable", "non-authoritative", "deprecated-mapping"].includes(resolution.reason));
  return { status: failedClosed ? "failed_closed" : "needs_clarification", resolutions };
}
