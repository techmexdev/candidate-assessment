import type {
  CopilotActionId,
  CopilotCanonicalIntentId,
  CopilotSectionId,
} from "../../domain/contracts/copilot";

export type CopilotModelSelection = {
  readonly sectionId: CopilotSectionId;
  readonly evidenceIds: readonly string[];
  readonly actionIds: readonly CopilotActionId[];
};

/** The model selects stable IDs only; it never authors facts, scope, charts, citations, or risk. */
export type CopilotModelCandidate = {
  readonly schemaVersion: "copilot-model-candidate/v1";
  readonly intentId: CopilotCanonicalIntentId;
  readonly selections: readonly CopilotModelSelection[];
};

export type CopilotModelCandidateBounds = {
  readonly intentIds: readonly CopilotCanonicalIntentId[];
  readonly sectionIds: readonly CopilotSectionId[];
  readonly evidenceIds: readonly string[];
  readonly actionIds: readonly CopilotActionId[];
};

export type CopilotModelCandidateDecodeResult =
  | { readonly status: "accepted"; readonly candidate: CopilotModelCandidate }
  | {
      readonly status: "rejected";
      readonly code: "malformed-selection" | "unknown-selection-id";
    };

export type CopilotModelInput = {
  readonly schemaVersion: "copilot-model-input/v1";
  readonly question: string;
  readonly intentIds: readonly CopilotCanonicalIntentId[];
  readonly sections: readonly {
    readonly sectionId: CopilotSectionId;
    readonly evidenceIds: readonly string[];
    readonly actionIds: readonly CopilotActionId[];
  }[];
};

export type CopilotModelResult =
  | { readonly status: "selected"; readonly candidate: CopilotModelCandidate }
  | { readonly status: "failed"; readonly reason: "unavailable" | "timeout" | "invalid-structured-output" };

export interface CopilotModel {
  select(input: Readonly<CopilotModelInput>, options?: { readonly signal?: AbortSignal }): Promise<CopilotModelResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isUniqueStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === "string" && entry.length > 0)
    && new Set(value).size === value.length;
}

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

export function decodeCopilotModelCandidate(
  value: unknown,
  bounds: Readonly<CopilotModelCandidateBounds>,
): CopilotModelCandidateDecodeResult {
  if (!isRecord(value)
    || !hasExactKeys(value, ["schemaVersion", "intentId", "selections"])
    || value.schemaVersion !== "copilot-model-candidate/v1"
    || typeof value.intentId !== "string"
    || !Array.isArray(value.selections)) {
    return { status: "rejected", code: "malformed-selection" };
  }
  if (!bounds.intentIds.includes(value.intentId as CopilotCanonicalIntentId)) {
    return { status: "rejected", code: "unknown-selection-id" };
  }

  const selections: CopilotModelSelection[] = [];
  for (const rawSelection of value.selections) {
    if (!isRecord(rawSelection)
      || !hasExactKeys(rawSelection, ["sectionId", "evidenceIds", "actionIds"])
      || typeof rawSelection.sectionId !== "string"
      || !isUniqueStringArray(rawSelection.evidenceIds)
      || !isUniqueStringArray(rawSelection.actionIds)) {
      return { status: "rejected", code: "malformed-selection" };
    }
    if (!bounds.sectionIds.includes(rawSelection.sectionId as CopilotSectionId)
      || rawSelection.evidenceIds.some((id) => !bounds.evidenceIds.includes(id))
      || rawSelection.actionIds.some((id) => !bounds.actionIds.includes(id as CopilotActionId))) {
      return { status: "rejected", code: "unknown-selection-id" };
    }
    selections.push({
      sectionId: rawSelection.sectionId as CopilotSectionId,
      evidenceIds: [...rawSelection.evidenceIds],
      actionIds: rawSelection.actionIds as CopilotActionId[],
    });
  }

  return {
    status: "accepted",
    candidate: deepFreeze({
      schemaVersion: "copilot-model-candidate/v1",
      intentId: value.intentId as CopilotCanonicalIntentId,
      selections,
    }) as CopilotModelCandidate,
  };
}
