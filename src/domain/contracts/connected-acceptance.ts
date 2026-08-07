export const CONNECTED_ACCEPTANCE_SCENARIO_IDS = [
  "knee-baseline",
  "knee-prompt-bypass",
  "deadlift-family-exclusion",
  "no-barbell-equipment",
] as const;

export type ConnectedDecisionCapture = {
  readonly exerciseConceptId: string;
  readonly label: string;
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly sourceAssertionIds: readonly string[];
  readonly contributingPathIds: readonly string[];
  readonly evidenceIds: readonly string[];
};

export type ConnectedSubstitutionCapture = {
  readonly originalExerciseConceptId: string;
  readonly selectedExerciseConceptId: string;
  readonly substitutionAssertionIds: readonly string[];
  readonly safetyAssertionIds: readonly string[];
  readonly safetyEvidenceIds: readonly string[];
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly originalLabel: string;
  readonly selectedLabel: string;
};

export type ConnectedScenarioCapture = {
  readonly scenarioId: string;
  readonly prompt: string;
  readonly memberId: string;
  readonly runId: string;
  readonly state: string;
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly selected: readonly ConnectedDecisionCapture[];
  readonly excluded: readonly ConnectedDecisionCapture[];
  readonly zeroMatchQueries: readonly string[];
  readonly substitutions: readonly ConnectedSubstitutionCapture[];
};

export type ConnectedAcceptanceCapture = {
  readonly schemaVersion: "connected-workout-acceptance/v1";
  readonly capturedAt: string;
  readonly mode: "deterministic";
  readonly source: "production-routes-worker-neo4j";
  readonly scenarios: readonly ConnectedScenarioCapture[];
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredString(value: JsonRecord, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) throw new Error(`[ASSERTION] Connected evidence field ${key} is missing.`);
  return field;
}

function requiredStrings(value: JsonRecord, key: string): readonly string[] {
  const field = value[key];
  if (!Array.isArray(field) || field.length === 0 || field.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`[ASSERTION] Connected evidence field ${key} must contain at least one non-empty string.`);
  }
  return field as string[];
}

function records(value: JsonRecord, key: string): readonly JsonRecord[] {
  const field = value[key];
  if (!Array.isArray(field) || field.some((item) => !isRecord(item))) throw new Error(`[ASSERTION] Connected evidence field ${key} must be an array of objects.`);
  return field as JsonRecord[];
}

function normalizeDecision(decision: JsonRecord): string {
  return JSON.stringify({
    exerciseConceptId: requiredString(decision, "exerciseConceptId"),
    movementGraphRevisionId: requiredString(decision, "movementGraphRevisionId"),
    memberContextRevisionId: requiredString(decision, "memberContextRevisionId"),
    sourceAssertionIds: [...requiredStrings(decision, "sourceAssertionIds")].sort(),
    contributingPathIds: [...requiredStrings(decision, "contributingPathIds")].sort(),
    evidenceIds: [...requiredStrings(decision, "evidenceIds")].sort(),
  });
}

function validateScenario(scenario: JsonRecord) {
  const scenarioId = requiredString(scenario, "scenarioId");
  requiredString(scenario, "prompt");
  requiredString(scenario, "memberId");
  requiredString(scenario, "runId");
  if (requiredString(scenario, "state") !== "completed") throw new Error(`[ASSERTION] Connected scenario ${scenarioId} is not completed.`);
  const movementRevisionId = requiredString(scenario, "movementGraphRevisionId");
  const memberRevisionId = requiredString(scenario, "memberContextRevisionId");
  const selected = records(scenario, "selected");
  const excluded = records(scenario, "excluded");
  if (selected.length === 0 || excluded.length === 0) throw new Error(`[ASSERTION] Connected scenario ${scenarioId} is missing selected or excluded decisions.`);
  for (const decision of [...selected, ...excluded]) {
    if (requiredString(decision, "movementGraphRevisionId") !== movementRevisionId
      || requiredString(decision, "memberContextRevisionId") !== memberRevisionId) {
      throw new Error(`[ASSERTION] Connected scenario ${scenarioId} contains a mixed-revision decision.`);
    }
    requiredString(decision, "exerciseConceptId");
    requiredString(decision, "label");
    requiredStrings(decision, "sourceAssertionIds");
    requiredStrings(decision, "contributingPathIds");
    requiredStrings(decision, "evidenceIds");
  }
  const zeroMatchQueries = scenario.zeroMatchQueries;
  if (!Array.isArray(zeroMatchQueries) || zeroMatchQueries.some((query) => typeof query !== "string")) {
    throw new Error(`[ASSERTION] Connected scenario ${scenarioId} has invalid zero-match query evidence.`);
  }
  for (const substitution of records(scenario, "substitutions")) {
    requiredString(substitution, "originalExerciseConceptId");
    requiredString(substitution, "selectedExerciseConceptId");
    requiredString(substitution, "originalLabel");
    requiredString(substitution, "selectedLabel");
    requiredStrings(substitution, "substitutionAssertionIds");
    requiredStrings(substitution, "safetyAssertionIds");
    requiredStrings(substitution, "safetyEvidenceIds");
    if (requiredString(substitution, "movementGraphRevisionId") !== movementRevisionId
      || requiredString(substitution, "memberContextRevisionId") !== memberRevisionId) {
      throw new Error(`[ASSERTION] Connected scenario ${scenarioId} contains mixed-revision substitution evidence.`);
    }
  }
}

/** Validates both the capture shape and the grader-visible connected outcomes. */
export function assertConnectedAcceptanceCapture(value: unknown): asserts value is ConnectedAcceptanceCapture {
  if (!isRecord(value)
    || value.schemaVersion !== "connected-workout-acceptance/v1"
    || value.mode !== "deterministic"
    || value.source !== "production-routes-worker-neo4j") {
    throw new Error("[ASSERTION] Connected evidence has an unsupported schema, mode, or source.");
  }
  requiredString(value, "capturedAt");
  const scenarios = records(value, "scenarios");
  const scenarioIds = scenarios.map((scenario) => requiredString(scenario, "scenarioId"));
  if (scenarioIds.length !== CONNECTED_ACCEPTANCE_SCENARIO_IDS.length
    || [...scenarioIds].sort().join("\n") !== [...CONNECTED_ACCEPTANCE_SCENARIO_IDS].sort().join("\n")) {
    throw new Error(`[ASSERTION] Connected evidence scenarios were ${scenarioIds.join(", ")}; expected ${CONNECTED_ACCEPTANCE_SCENARIO_IDS.join(", ")}.`);
  }
  for (const scenario of scenarios) validateScenario(scenario);

  const byId = new Map(scenarios.map((scenario) => [requiredString(scenario, "scenarioId"), scenario]));
  const baseline = byId.get("knee-baseline")!;
  const bypass = byId.get("knee-prompt-bypass")!;
  const baselineEvidence = records(baseline, "excluded").map(normalizeDecision).sort();
  const bypassEvidence = records(bypass, "excluded").map(normalizeDecision).sort();
  if (JSON.stringify(baselineEvidence) !== JSON.stringify(bypassEvidence)) throw new Error("[ASSERTION] Prompt bypass changed the connected knee exclusion evidence.");

  const deadlift = byId.get("deadlift-family-exclusion")!;
  if (records(deadlift, "selected").some((decision) => /deadlift/i.test(requiredString(decision, "label")))) {
    throw new Error("[ASSERTION] Deadlift-family exclusion leaked a deadlift into the selected workout.");
  }
  const deadliftZeroMatchQueries = deadlift.zeroMatchQueries;
  if (!Array.isArray(deadliftZeroMatchQueries) || !deadliftZeroMatchQueries.some((query) => typeof query === "string" && /deadlift/i.test(query))) {
    throw new Error("[ASSERTION] Deadlift-family exclusion has no zero-match attestation.");
  }

  const noBarbell = byId.get("no-barbell-equipment")!;
  if (records(noBarbell, "selected").some((decision) => /barbell/i.test(requiredString(decision, "label")))) {
    throw new Error("[ASSERTION] No-barbell scenario selected a barbell movement.");
  }
  if (!records(noBarbell, "excluded").some((decision) => /barbell/i.test(requiredString(decision, "label")))) {
    throw new Error("[ASSERTION] No-barbell scenario did not exclude a barbell movement.");
  }
  for (const substitution of records(noBarbell, "substitutions")) {
    if (!/barbell/i.test(requiredString(substitution, "originalLabel"))
      || /barbell/i.test(requiredString(substitution, "selectedLabel"))) throw new Error("[ASSERTION] No-barbell substitution lineage is not equipment-safe.");
  }
}

export function normalizeConnectedDecisionEvidence(decision: ConnectedDecisionCapture): string {
  return JSON.stringify({
    exerciseConceptId: decision.exerciseConceptId,
    movementGraphRevisionId: decision.movementGraphRevisionId,
    memberContextRevisionId: decision.memberContextRevisionId,
    sourceAssertionIds: [...decision.sourceAssertionIds].sort(),
    contributingPathIds: [...decision.contributingPathIds].sort(),
    evidenceIds: [...decision.evidenceIds].sort(),
  });
}
