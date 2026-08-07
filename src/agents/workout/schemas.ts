import type { WorkoutComposerProposal } from "../../application/ports/workout-composer";

type JsonSchema = Readonly<Record<string, unknown>>;

const doseSchema: JsonSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "sets", "workSecondsPerSet"],
      properties: {
        kind: { const: "timed" },
        sets: { type: "integer", minimum: 1 },
        workSecondsPerSet: { type: "integer", minimum: 1 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "sets", "repetitionsPerSet", "secondsPerRepetition"],
      properties: {
        kind: { const: "repetitions" },
        sets: { type: "integer", minimum: 1 },
        repetitionsPerSet: { type: "integer", minimum: 1 },
        secondsPerRepetition: { type: "number", exclusiveMinimum: 0 },
      },
    },
  ],
};

export const WORKOUT_PROPOSAL_JSON_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "sections"],
  properties: {
    schemaVersion: { const: "workout-proposal/v1" },
    sections: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "items"],
        properties: {
          kind: { enum: ["warm-up", "main", "cool-down"] },
          items: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["exerciseConceptId", "dose", "restSeconds", "rationale", "citationIds"],
              properties: {
                exerciseConceptId: { type: "string", minLength: 1 },
                dose: doseSchema,
                restSeconds: { type: "integer", minimum: 0 },
                rationale: { type: "string", minLength: 1, maxLength: 280 },
                citationIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
              },
            },
          },
        },
      },
    },
  },
});

type InvalidProposal = { readonly status: "invalid"; readonly reason: "invalid-structured-output" };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parseDose(value: unknown) {
  const candidate = record(value);
  if (!candidate || typeof candidate.kind !== "string" || !positiveInteger(candidate.sets)) return undefined;
  if (candidate.kind === "timed" && exactKeys(candidate, ["kind", "sets", "workSecondsPerSet"])
    && positiveInteger(candidate.workSecondsPerSet)) {
    return { kind: "timed" as const, sets: candidate.sets as number, workSecondsPerSet: candidate.workSecondsPerSet as number };
  }
  if (candidate.kind === "repetitions" && exactKeys(candidate, ["kind", "sets", "repetitionsPerSet", "secondsPerRepetition"])
    && positiveInteger(candidate.repetitionsPerSet)
    && typeof candidate.secondsPerRepetition === "number" && candidate.secondsPerRepetition > 0) {
    return {
      kind: "repetitions" as const,
      sets: candidate.sets as number,
      repetitionsPerSet: candidate.repetitionsPerSet as number,
      secondsPerRepetition: candidate.secondsPerRepetition,
    };
  }
  return undefined;
}

export function parseWorkoutProposal(value: unknown): { readonly status: "valid"; readonly proposal: WorkoutComposerProposal } | InvalidProposal {
  const proposal = record(value);
  if (!proposal || !exactKeys(proposal, ["schemaVersion", "sections"])
    || proposal.schemaVersion !== "workout-proposal/v1" || !Array.isArray(proposal.sections)
    || proposal.sections.length !== 3) return { status: "invalid", reason: "invalid-structured-output" };
  const sections: WorkoutComposerProposal["sections"][number][] = [];
  for (const sectionValue of proposal.sections) {
    const section = record(sectionValue);
    if (!section || !exactKeys(section, ["kind", "items"])
      || !["warm-up", "main", "cool-down"].includes(String(section.kind))
      || !Array.isArray(section.items) || section.items.length === 0 || section.items.length > 100) {
      return { status: "invalid", reason: "invalid-structured-output" };
    }
    const items: WorkoutComposerProposal["sections"][number]["items"][number][] = [];
    for (const itemValue of section.items) {
      const item = record(itemValue);
      const dose = item && parseDose(item.dose);
      if (!item || !exactKeys(item, ["exerciseConceptId", "dose", "restSeconds", "rationale", "citationIds"])
        || typeof item.exerciseConceptId !== "string" || !item.exerciseConceptId
        || !dose || typeof item.restSeconds !== "number" || !Number.isInteger(item.restSeconds) || item.restSeconds < 0
        || typeof item.rationale !== "string" || !item.rationale.trim() || item.rationale.length > 280
        || !Array.isArray(item.citationIds) || item.citationIds.length === 0
        || item.citationIds.some((id) => typeof id !== "string" || !id)
        || new Set(item.citationIds).size !== item.citationIds.length) {
        return { status: "invalid", reason: "invalid-structured-output" };
      }
      items.push({
        exerciseConceptId: item.exerciseConceptId,
        dose,
        restSeconds: item.restSeconds,
        rationale: item.rationale,
        citationIds: [...item.citationIds] as string[],
      });
    }
    sections.push({ kind: section.kind as "warm-up" | "main" | "cool-down", items });
  }
  return { status: "valid", proposal: { schemaVersion: "workout-proposal/v1", sections } };
}
