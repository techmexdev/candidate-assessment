import {
  asWorkoutDecisionId,
  asWorkoutRunId,
  asWorkoutVersionId,
  type WorkoutDecisionId,
  type WorkoutRunId,
  type WorkoutVersionId,
} from "./workout";

export type WorkoutDecisionKind = "selected" | "excluded" | "cautioned" | "downranked" | "substituted";

export type WorkoutDecision = {
  readonly decisionId: WorkoutDecisionId | string;
  readonly kind: WorkoutDecisionKind;
  readonly exerciseConceptId: string;
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly sourceAssertionIds: readonly string[];
  readonly contributingPathIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly explanation: string;
  readonly substitutedFromExerciseConceptId?: string;
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
  readonly code: "missing-assertion" | "missing-path" | "missing-evidence" | "missing-explanation" | "mixed-revision" | "missing-entity" | "missing-relation";
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
  return violations.length === 0 ? { status: "valid" } : { status: "invalid", violations };
}
