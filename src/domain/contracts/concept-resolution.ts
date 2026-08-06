import type { MovementNodeKind } from "./movement-graph";

export type ConceptMention = {
  text: string;
  kind?: MovementNodeKind;
  role: "target" | "equipment" | "injury" | "exclusion" | "preference";
  safetyCritical: boolean;
};

export type ResolutionMethod = "exact" | "fuzzy" | "semantic";
export type CandidateSummary = {
  conceptId: string;
  label: string;
  kind: MovementNodeKind;
  matchedAlias: string;
  confidence: number;
};

export type ConceptResolution =
  | {
      status: "resolved";
      mention: ConceptMention;
      conceptId: string;
      method: ResolutionMethod;
      confidence: number;
      threshold: number;
      matchedAlias: string;
      alternatives: CandidateSummary[];
      policyRevision: string;
    }
  | {
      status: "clarify" | "unresolved";
      mention: ConceptMention;
      reason: "ambiguous" | "below-threshold" | "no-candidate" | "invalid-input";
      candidates: CandidateSummary[];
      requiredConfidence: number;
      policyRevision: string;
    };

export type ConceptResolutionBatch =
  | { status: "resolved"; resolutions: Extract<ConceptResolution, { status: "resolved" }>[] }
  | { status: "needs_clarification"; resolutions: ConceptResolution[] };

export type ConceptResolutionPolicy = {
  revision: string;
  exactThreshold: number;
  fuzzyThreshold: number;
  safetyCriticalThreshold: number;
  clarificationFloor: number;
  minimumMargin: number;
};
