import {
  asWorkoutDecisionId,
  asWorkoutRunId,
  asWorkoutVersionId,
  type WorkoutDecisionId,
  type WorkoutRunId,
  type WorkoutVersionId,
} from "./workout";
import type { CatalogSafetyClassification } from "./catalog-safety";

export type WorkoutDecisionKind = "selected" | "not-selected" | "excluded" | "cautioned" | "downranked" | "substituted";
export type WorkoutSelectionDisposition = "selected" | "not-selected";

export type WorkoutDecision = {
  readonly decisionId: WorkoutDecisionId | string;
  /** Compatibility summary for existing trace consumers. New decisions also carry both canonical dimensions below. */
  readonly kind: WorkoutDecisionKind;
  readonly selectionDisposition?: WorkoutSelectionDisposition;
  readonly safetyClassification?: CatalogSafetyClassification;
  readonly exerciseConceptId: string;
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly sourceAssertionIds: readonly string[];
  readonly contributingPathIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly explanation: string;
  readonly substitutedFromExerciseConceptId?: string;
};

/** Reviewed substitution lineage retained alongside the selected decision. */
export type WorkoutSubstitutionProvenance = {
  readonly originalExerciseConceptId: string;
  readonly selectedExerciseConceptId: string;
  readonly substitutionAssertionIds: readonly string[];
  readonly safetyAssertionIds: readonly string[];
  readonly safetyEvidenceIds: readonly string[];
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
};

export type WorkoutProvenanceEntityKind =
  | "prompt"
  | "movement-graph-revision"
  | "member-context-revision"
  | "policy"
  | "candidate-set"
  | "model-proposal"
  | "workout-version";

export type WorkoutProvenanceEntity = {
  readonly entityId: string;
  readonly kind: WorkoutProvenanceEntityKind;
};

export type WorkoutProvenanceActivity = {
  readonly activityId: WorkoutRunId;
  readonly kind: "workout-generation";
};

export type WorkoutProvenanceRelation =
  | { readonly kind: "used"; readonly activityId: WorkoutRunId; readonly entityId: string }
  | { readonly kind: "wasGeneratedBy"; readonly entityId: WorkoutVersionId; readonly activityId: WorkoutRunId }
  | { readonly kind: "wasDerivedFrom"; readonly entityId: WorkoutVersionId; readonly sourceEntityId: string };

export type WorkoutProvenanceBundle = {
  readonly traceSchemaVersion: "workout-provenance/v1";
  readonly digest: string;
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly activity: Readonly<WorkoutProvenanceActivity>;
  readonly entities: readonly WorkoutProvenanceEntity[];
  readonly decisions: readonly WorkoutDecision[];
  readonly substitutions?: readonly WorkoutSubstitutionProvenance[];
  readonly relations: readonly WorkoutProvenanceRelation[];
};

export type CreateWorkoutProvenanceInput = {
  readonly runId: string;
  readonly workoutVersionId: string;
  readonly promptEntityId: string;
  readonly candidateSetEntityId: string;
  readonly modelProposalEntityId: string;
  readonly policyEntityId: string;
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly decisions: readonly WorkoutDecision[];
  readonly substitutions?: readonly WorkoutSubstitutionProvenance[];
  readonly traceSchemaVersion: "workout-provenance/v1";
  readonly digest: string;
};

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

export function createWorkoutProvenanceBundle(input: CreateWorkoutProvenanceInput): WorkoutProvenanceBundle {
  const activityId = asWorkoutRunId(input.runId);
  const workoutVersionId = asWorkoutVersionId(input.workoutVersionId);
  const sourceEntities: WorkoutProvenanceEntity[] = [
    { entityId: input.promptEntityId, kind: "prompt" },
    { entityId: input.movementGraphRevisionId, kind: "movement-graph-revision" },
    { entityId: input.memberContextRevisionId, kind: "member-context-revision" },
    { entityId: input.policyEntityId, kind: "policy" },
    { entityId: input.candidateSetEntityId, kind: "candidate-set" },
    { entityId: input.modelProposalEntityId, kind: "model-proposal" },
  ];
  const decisions = input.decisions.map((decision) => ({
    ...decision,
    decisionId: asWorkoutDecisionId(decision.decisionId),
    sourceAssertionIds: [...decision.sourceAssertionIds],
    contributingPathIds: [...decision.contributingPathIds],
    evidenceIds: [...decision.evidenceIds],
  }));
  return deepFreeze({
    traceSchemaVersion: input.traceSchemaVersion,
    digest: input.digest,
    movementGraphRevisionId: input.movementGraphRevisionId,
    memberContextRevisionId: input.memberContextRevisionId,
    activity: { activityId, kind: "workout-generation" },
    entities: [...sourceEntities, { entityId: workoutVersionId, kind: "workout-version" }],
    decisions,
    ...(input.substitutions ? { substitutions: input.substitutions.map((substitution) => ({
      ...substitution,
      substitutionAssertionIds: [...substitution.substitutionAssertionIds],
      safetyAssertionIds: [...substitution.safetyAssertionIds],
      safetyEvidenceIds: [...substitution.safetyEvidenceIds],
    })) } : {}),
    relations: [
      ...sourceEntities.map((entity) => ({ kind: "used" as const, activityId, entityId: entity.entityId })),
      { kind: "wasGeneratedBy", entityId: workoutVersionId, activityId },
      { kind: "wasDerivedFrom", entityId: workoutVersionId, sourceEntityId: input.candidateSetEntityId },
      { kind: "wasDerivedFrom", entityId: workoutVersionId, sourceEntityId: input.modelProposalEntityId },
    ],
  }) as WorkoutProvenanceBundle;
}

export type WorkoutProvenanceViolation = {
  readonly decisionId?: WorkoutDecisionId | string;
  readonly code:
    | "missing-assertion"
    | "missing-path"
    | "missing-evidence"
    | "missing-explanation"
    | "mixed-revision"
    | "missing-entity"
    | "missing-relation"
    | "incomplete-decision-dimensions"
    | "inconsistent-decision-dimensions"
    | "invalid-substitution-lineage";
};

export type WorkoutProvenanceValidation =
  | { readonly status: "valid" }
  | { readonly status: "invalid"; readonly violations: readonly WorkoutProvenanceViolation[] };

export function validateWorkoutProvenance(bundle: WorkoutProvenanceBundle): WorkoutProvenanceValidation {
  const violations: WorkoutProvenanceViolation[] = [];
  for (const decision of bundle.decisions) {
    if (decision.sourceAssertionIds.length === 0) violations.push({ decisionId: decision.decisionId, code: "missing-assertion" });
    if (decision.contributingPathIds.length === 0) violations.push({ decisionId: decision.decisionId, code: "missing-path" });
    if (decision.evidenceIds.length === 0) violations.push({ decisionId: decision.decisionId, code: "missing-evidence" });
    if (!decision.explanation.trim()) violations.push({ decisionId: decision.decisionId, code: "missing-explanation" });
    const hasSelectionDisposition = decision.selectionDisposition !== undefined;
    const hasSafetyClassification = decision.safetyClassification !== undefined;
    if (hasSelectionDisposition !== hasSafetyClassification) {
      violations.push({ decisionId: decision.decisionId, code: "incomplete-decision-dimensions" });
    } else if (hasSelectionDisposition && hasSafetyClassification) {
      const inconsistent = (decision.selectionDisposition === "selected" && decision.safetyClassification === "excluded")
        || (decision.kind === "excluded" && (decision.selectionDisposition !== "not-selected" || decision.safetyClassification !== "excluded"))
        || (decision.kind === "selected" && (decision.selectionDisposition !== "selected" || decision.safetyClassification !== "allowed"))
        || (decision.kind === "not-selected" && decision.selectionDisposition !== "not-selected")
        || (decision.kind === "cautioned" && decision.safetyClassification !== "caution")
        || (decision.kind === "downranked" && decision.safetyClassification !== "downranked")
        || (decision.kind === "substituted" && decision.selectionDisposition !== "selected");
      if (inconsistent) violations.push({ decisionId: decision.decisionId, code: "inconsistent-decision-dimensions" });
    }
    if (decision.movementGraphRevisionId !== bundle.movementGraphRevisionId
      || decision.memberContextRevisionId !== bundle.memberContextRevisionId) {
      violations.push({ decisionId: decision.decisionId, code: "mixed-revision" });
    }
  }
  const requiredEntityKinds: readonly WorkoutProvenanceEntityKind[] = [
    "prompt", "movement-graph-revision", "member-context-revision", "policy", "candidate-set", "model-proposal", "workout-version",
  ];
  for (const kind of requiredEntityKinds) {
    if (!bundle.entities.some((entity) => entity.kind === kind)) violations.push({ code: "missing-entity" });
  }
  const sourceEntityIds = bundle.entities.filter((entity) => entity.kind !== "workout-version").map((entity) => entity.entityId);
  for (const entityId of sourceEntityIds) {
    if (!bundle.relations.some((relation) => relation.kind === "used"
      && relation.activityId === bundle.activity.activityId
      && relation.entityId === entityId)) violations.push({ code: "missing-relation" });
  }
  const workoutEntity = bundle.entities.find((entity) => entity.kind === "workout-version");
  if (!workoutEntity || !bundle.relations.some((relation) => relation.kind === "wasGeneratedBy"
    && relation.entityId === workoutEntity.entityId
    && relation.activityId === bundle.activity.activityId)) violations.push({ code: "missing-relation" });
  for (const kind of ["candidate-set", "model-proposal"] as const) {
    const source = bundle.entities.find((entity) => entity.kind === kind);
    if (!source || !workoutEntity || !bundle.relations.some((relation) => relation.kind === "wasDerivedFrom"
      && relation.entityId === workoutEntity.entityId
      && relation.sourceEntityId === source.entityId)) violations.push({ code: "missing-relation" });
  }
  for (const substitution of bundle.substitutions ?? []) {
    if (!substitution.originalExerciseConceptId
      || !substitution.selectedExerciseConceptId
      || substitution.originalExerciseConceptId === substitution.selectedExerciseConceptId
      || substitution.substitutionAssertionIds.length === 0
      || substitution.safetyAssertionIds.length === 0
      || substitution.safetyEvidenceIds.length === 0
      || substitution.movementGraphRevisionId !== bundle.movementGraphRevisionId
      || substitution.memberContextRevisionId !== bundle.memberContextRevisionId) {
      violations.push({ code: "invalid-substitution-lineage" });
    }
    const selected = bundle.decisions.find((decision) => decision.exerciseConceptId === substitution.selectedExerciseConceptId
      && decision.substitutedFromExerciseConceptId === substitution.originalExerciseConceptId);
    if (!selected) violations.push({ code: "invalid-substitution-lineage" });
  }
  return violations.length === 0 ? { status: "valid" } : { status: "invalid", violations };
}

/** New traces use the explicit disposition; legacy v1 traces retain their historical kind semantics. */
export function workoutDecisionWasSelected(decision: WorkoutDecision): boolean {
  if (decision.selectionDisposition) return decision.selectionDisposition === "selected";
  return decision.kind !== "excluded" && decision.kind !== "not-selected";
}
