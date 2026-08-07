import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  AppendWorkoutRunEvent,
  ClaimWorkoutRunResult,
  ClarificationMutationResult,
  CompleteWorkoutRunInput,
  CreateWorkoutRunResult,
  FinalizeWorkoutRunCreationResult,
  FencedMutationResult,
  ReserveWorkoutRunCreationResult,
  RetryWorkoutRunResult,
  WorkoutCompletionArtifact,
  WorkoutCompletionProjection,
  WorkoutRunEvent,
  WorkoutRunEventReadResult,
  WorkoutRunFence,
  WorkoutRunInputRevision,
  WorkoutRunCreationReservation,
  WorkoutRunRepository,
} from "../../application/ports/workout-run-repository";
import type {
  CompletedWorkoutRun,
  ResolvedConstraintSnapshot,
  WorkoutRun,
  WorkoutRunFailure,
  WorkoutValidationReceipt,
  WorkoutRevisionSealArtifact,
} from "../../domain/contracts/workout-run";
import type { CatalogSafetyReadyResult } from "../../domain/contracts/catalog-safety";
import type { WorkoutCompositionProposal } from "../../domain/policies/workout-composition";
import type { ImmutableWorkoutVersion, WorkoutRunId } from "../../domain/contracts/workout";
import type { WorkoutProvenanceBundle } from "../../domain/contracts/workout-provenance";
import { validateWorkoutProvenance, workoutDecisionWasSelected } from "../../domain/contracts/workout-provenance";
import { deepFreeze } from "../revisions/movement-graph";
import {
  WORKOUT_RUN_CURSOR_SCHEMA_VERSION,
  WORKOUT_RUN_EVENT_SCHEMA_VERSION,
  WORKOUT_RUN_LIMITS,
  WORKOUT_RUN_TERMINAL_STATES,
  canonicalWorkoutDecisionSetDigest,
  canonicalWorkoutDigest,
  canonicalWorkoutPayloadDigest,
  canonicalWorkoutProvenanceDigest,
  canonicalWorkoutRevisionSealDigest,
  isWorkoutRunTransitionAllowed,
} from "../schema/workout-run-schema";

type StoredRun = {
  run: WorkoutRun;
  events: WorkoutRunEvent[];
  nextEventSequence: number;
  workout?: ImmutableWorkoutVersion;
  provenance?: WorkoutProvenanceBundle;
  validationReceipt?: WorkoutValidationReceipt;
  completionArtifacts: CompletionArtifactStore;
};

export type CompletionArtifactStore = {
  revisionSeals?: Readonly<WorkoutRevisionSealArtifact>;
  safetyEnvelope?: Readonly<CatalogSafetyReadyResult>;
  modelProposal?: Readonly<WorkoutCompositionProposal>;
};

type CursorPayload = {
  readonly schemaVersion: typeof WORKOUT_RUN_CURSOR_SCHEMA_VERSION;
  readonly runId: string;
  readonly nextSequence: number;
};

export type InMemoryWorkoutRunRepositoryOptions = {
  readonly cursorSecret?: string | Uint8Array;
  readonly maxEventsPerRun?: number;
  readonly now?: () => string;
};

const clone = <Value>(value: Value): Value => structuredClone(value);
const frozenClone = <Value>(value: Value): Readonly<Value> => deepFreeze(clone(value));
const identityKey = (input: Pick<WorkoutRunCreationReservation, "coachId" | "memberId" | "action" | "idempotencyKeyDigest">) =>
  [input.coachId, input.memberId, input.action, input.idempotencyKeyDigest].join("\u0000");
const sameAuthorization = (run: WorkoutRun, coachId: string, memberId: string) => run.coachId === coachId && run.memberId === memberId;
const validDate = (value: string) => Number.isFinite(Date.parse(value));

function sameFence(run: WorkoutRun, fence: WorkoutRunFence): boolean {
  return run.runId === fence.runId
    && run.state === "running"
    && run.claim?.generation === fence.generation
    && run.claim.workerId === fence.workerId;
}

function selectedExerciseIds(workout: ImmutableWorkoutVersion): readonly string[] {
  return workout.workout.sections.flatMap((section) => section.items.map((item) => item.exerciseConceptId));
}

export function validateCompletionBindings(run: WorkoutRun, input: CompleteWorkoutRunInput, artifacts: Readonly<CompletionArtifactStore>): boolean {
  const { validationReceipt: receipt, workoutVersion, provenance } = input;
  if (!artifacts.revisionSeals || !artifacts.safetyEnvelope || !artifacts.modelProposal
    || artifacts.revisionSeals.schemaVersion !== "workout-revision-seals/v1"
    || !artifacts.revisionSeals.movementGraphSealId
    || !artifacts.revisionSeals.movementGraphSealDigest
    || !artifacts.revisionSeals.memberContextSealId
    || !artifacts.revisionSeals.memberContextSealDigest
    || artifacts.revisionSeals.movementGraphRevisionId !== run.movementGraphRevisionId
    || artifacts.revisionSeals.memberContextRevisionId !== run.memberContextRevisionId
    || artifacts.safetyEnvelope.status !== "ready"
    || artifacts.safetyEnvelope.authority !== "canonical"
    || artifacts.safetyEnvelope.movementGraphRevisionId !== run.movementGraphRevisionId
    || artifacts.safetyEnvelope.memberContextRevisionId !== run.memberContextRevisionId
    || receipt.revisionSealDigest !== canonicalWorkoutRevisionSealDigest(artifacts.revisionSeals)
    || receipt.safetyEnvelopeDigest !== canonicalWorkoutDigest(artifacts.safetyEnvelope)
    || receipt.modelProposalDigest !== canonicalWorkoutDigest(artifacts.modelProposal)
    || !sameFence(run, input.fence)
    || input.authorizationReferenceId !== run.authorizationReferenceId
    || receipt.schemaVersion !== "workout-validation-receipt/v1"
    || receipt.policyVersion !== "workout-composition/v1"
    || receipt.runId !== run.runId
    || receipt.claimGeneration !== input.fence.generation
    || receipt.requestDigest !== run.requestDigest
    || receipt.movementGraphRevisionId !== run.movementGraphRevisionId
    || receipt.memberContextRevisionId !== run.memberContextRevisionId
    || receipt.resolvedConstraintDigest !== run.constraintSnapshot?.digest
    || receipt.provenanceDigest !== provenance.digest
    || receipt.provenanceDigest !== canonicalWorkoutProvenanceDigest(provenance)
    || receipt.completeDecisionSetDigest !== canonicalWorkoutDecisionSetDigest(provenance.decisions)
    || receipt.workoutPayloadDigest !== canonicalWorkoutPayloadDigest(workoutVersion)
    || receipt.durationPolicyVersion !== workoutVersion.workout.durationPolicyVersion
    || workoutVersion.workout.runId !== run.runId
    || workoutVersion.version !== 1
    || workoutVersion.workout.schemaVersion !== "reviewable-workout/v1"
    || workoutVersion.workout.movementGraphRevisionId !== run.movementGraphRevisionId
    || workoutVersion.workout.memberContextRevisionId !== run.memberContextRevisionId
    || provenance.activity.activityId !== run.runId
    || provenance.movementGraphRevisionId !== run.movementGraphRevisionId
    || provenance.memberContextRevisionId !== run.memberContextRevisionId
    || validateWorkoutProvenance(provenance).status !== "valid") return false;

  const workoutEntity = provenance.entities.find((entity) => entity.kind === "workout-version");
  const candidateSetEntity = provenance.entities.find((entity) => entity.kind === "candidate-set");
  const modelProposalEntity = provenance.entities.find((entity) => entity.kind === "model-proposal");
  if (workoutEntity?.entityId !== workoutVersion.workoutVersionId
    || candidateSetEntity?.entityId !== `candidate-set:${receipt.safetyEnvelopeDigest}`
    || modelProposalEntity?.entityId !== `model-proposal:${receipt.modelProposalDigest}`) return false;
  const selected = new Set(provenance.decisions.filter(workoutDecisionWasSelected).map((decision) => decision.exerciseConceptId));
  return selectedExerciseIds(workoutVersion).every((exerciseId) => selected.has(exerciseId));
}

function isSafeProgressEvent(event: AppendWorkoutRunEvent): boolean {
  if (event.kind !== "stage" || !validDate(event.occurredAt)) return false;
  const entries = Object.entries(event.safeData);
  return entries.length <= 16 && entries.every(([key, value]) => {
    const primitive = value === null || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value))
      || (typeof value === "string" && value.length <= 256);
    return primitive && !/(prompt|evidence|rationale|provider|authorization|grant|token|cookie|payload)/i.test(key);
  });
}

export class InMemoryWorkoutRunRepository implements WorkoutRunRepository {
  private readonly runs = new Map<string, StoredRun>();
  private readonly runIdByIdentity = new Map<string, string>();
  private readonly creationReservations = new Map<string, {
    coachId: string;
    memberId: string;
    action: "generate-workout";
    idempotencyKeyDigest: string;
    requestDigest: string;
    runId: WorkoutRunId;
    ownerId?: string;
    createdAt: string;
    expiresAt?: string;
  }>();
  private readonly cursorSecret: Buffer;
  private readonly maxEventsPerRun: number;
  private readonly now: () => string;

  constructor(options: InMemoryWorkoutRunRepositoryOptions = {}) {
    this.cursorSecret = Buffer.from(options.cursorSecret ?? randomBytes(32));
    this.maxEventsPerRun = options.maxEventsPerRun ?? WORKOUT_RUN_LIMITS.defaultEventsRetainedPerRun;
    this.now = options.now ?? (() => new Date().toISOString());
    if (!Number.isInteger(this.maxEventsPerRun) || this.maxEventsPerRun < 1) throw new Error("maxEventsPerRun must be a positive integer");
  }

  private event(store: StoredRun, event: AppendWorkoutRunEvent): void {
    const sequence = store.nextEventSequence++;
    store.events.push(frozenClone({
      eventId: `${store.run.runId}:event:${sequence}`,
      schemaVersion: WORKOUT_RUN_EVENT_SCHEMA_VERSION,
      runId: store.run.runId,
      sequence,
      kind: event.kind,
      occurredAt: event.occurredAt,
      safeData: { ...event.safeData },
    }) as WorkoutRunEvent);
    if (store.events.length > this.maxEventsPerRun) store.events.splice(0, store.events.length - this.maxEventsPerRun);
  }

  private find(runId: WorkoutRunId): StoredRun | undefined { return this.runs.get(runId); }
  private publicRun(store: StoredRun): WorkoutRun { return frozenClone(store.run) as WorkoutRun; }
  private hasActiveFence(run: WorkoutRun, fence: WorkoutRunFence): boolean {
    const now = this.now();
    return sameFence(run, fence)
      && validDate(now)
      && Date.parse(run.claim!.expiresAt) > Date.parse(now);
  }

  async reserveCreation(input: WorkoutRunCreationReservation): Promise<ReserveWorkoutRunCreationResult> {
    const key = identityKey(input);
    const existingId = this.runIdByIdentity.get(key);
    if (existingId) {
      const existing = this.runs.get(existingId)!;
      return existing.run.requestDigest === input.requestDigest
        ? { status: "replayed", run: this.publicRun(existing) }
        : { status: "idempotency-conflict" };
    }
    const reservation = this.creationReservations.get(key);
    if (!reservation) {
      this.creationReservations.set(key, { ...input });
      return { status: "reserved", reservation: frozenClone(input) as WorkoutRunCreationReservation };
    }
    if (reservation.requestDigest !== input.requestDigest) return { status: "idempotency-conflict" };
    const current = this.now();
    const available = !reservation.ownerId
      || reservation.ownerId === input.ownerId
      || !reservation.expiresAt
      || (validDate(current) && validDate(reservation.expiresAt) && Date.parse(reservation.expiresAt) <= Date.parse(current));
    if (!available) return { status: "pending" };
    reservation.ownerId = input.ownerId;
    reservation.expiresAt = input.expiresAt;
    return {
      status: "reserved",
      reservation: frozenClone({ ...reservation, ownerId: input.ownerId, expiresAt: input.expiresAt }) as WorkoutRunCreationReservation,
    };
  }

  async finalizeCreation(
    reservation: WorkoutRunCreationReservation,
    run: WorkoutRun,
  ): Promise<FinalizeWorkoutRunCreationResult> {
    const key = identityKey(reservation);
    const stored = this.creationReservations.get(key);
    if (!stored || stored.ownerId !== reservation.ownerId || stored.runId !== reservation.runId
      || stored.requestDigest !== reservation.requestDigest || run.runId !== stored.runId
      || run.coachId !== stored.coachId || run.memberId !== stored.memberId
      || run.idempotencyKeyDigest !== stored.idempotencyKeyDigest || run.requestDigest !== stored.requestDigest) {
      const existingId = this.runIdByIdentity.get(key);
      const existing = existingId ? this.runs.get(existingId) : undefined;
      if (existing) return existing.run.requestDigest === run.requestDigest
        ? { status: "replayed", run: this.publicRun(existing) }
        : { status: "idempotency-conflict" };
      return { status: "stale-reservation" };
    }
    if (run.retryOfRunId) {
      const source = this.runs.get(run.retryOfRunId);
      if (!source || source.run.state !== "failed"
        || source.run.coachId !== run.coachId || source.run.memberId !== run.memberId) return { status: "stale-reservation" };
    }
    const result = await this.createOrFind(run);
    stored.ownerId = undefined;
    stored.expiresAt = undefined;
    return result;
  }

  async releaseCreation(reservation: WorkoutRunCreationReservation): Promise<void> {
    const stored = this.creationReservations.get(identityKey(reservation));
    if (stored?.ownerId !== reservation.ownerId || stored.runId !== reservation.runId) return;
    stored.ownerId = undefined;
    stored.expiresAt = undefined;
  }

  async createOrFind(run: WorkoutRun): Promise<CreateWorkoutRunResult> {
    const key = identityKey({ ...run, action: "generate-workout" });
    const existingId = this.runIdByIdentity.get(key);
    if (existingId) {
      const existing = this.runs.get(existingId)!;
      return existing.run.requestDigest === run.requestDigest
        ? { status: "replayed", run: this.publicRun(existing) }
        : { status: "idempotency-conflict" };
    }
    if (this.runs.has(run.runId)) return { status: "idempotency-conflict" };
    const stored: StoredRun = { run: frozenClone(run) as WorkoutRun, events: [], nextEventSequence: 1, completionArtifacts: {} };
    this.runs.set(run.runId, stored);
    this.runIdByIdentity.set(key, run.runId);
    const reservation = this.creationReservations.get(key);
    if (reservation) {
      reservation.ownerId = undefined;
      reservation.expiresAt = undefined;
    } else {
      this.creationReservations.set(key, {
        coachId: run.coachId,
        memberId: run.memberId,
        action: "generate-workout",
        idempotencyKeyDigest: run.idempotencyKeyDigest,
        requestDigest: run.requestDigest,
        runId: run.runId,
        createdAt: run.inputRevisions[0]?.createdAt ?? new Date(0).toISOString(),
      });
    }
    this.event(stored, { kind: "queued", occurredAt: run.inputRevisions[0]?.createdAt ?? new Date(0).toISOString(), safeData: {} });
    return { status: "created", run: this.publicRun(stored) };
  }

  async claim(runId: WorkoutRunId, workerId: string, now: string, expiresAt: string): Promise<ClaimWorkoutRunResult> {
    const store = this.find(runId);
    if (!store) return { status: "missing" };
    if (!workerId.trim() || !validDate(now) || !validDate(expiresAt) || Date.parse(expiresAt) <= Date.parse(now)) return { status: "not-claimable" };
    const previous = store.run.claim;
    const isQueued = store.run.state === "queued";
    const isExpired = store.run.state === "running" && previous && Date.parse(previous.expiresAt) <= Date.parse(now);
    if (!isQueued && !isExpired) return { status: "not-claimable" };
    const generation = (previous?.generation ?? 0) + 1;
    const claim = { generation, workerId, claimedAt: now, heartbeatAt: now, expiresAt };
    store.completionArtifacts = {};
    store.run = frozenClone({ ...store.run, state: "running", claim, startedAt: store.run.startedAt ?? now }) as WorkoutRun;
    this.event(store, { kind: "claimed", occurredAt: now, safeData: { generation, workerId } });
    return { status: "claimed", run: this.publicRun(store), fence: { runId, generation, workerId } };
  }

  async heartbeat(fence: WorkoutRunFence, now: string, expiresAt: string): Promise<FencedMutationResult> {
    const store = this.find(fence.runId);
    if (!store) return { status: "missing" };
    if (!this.hasActiveFence(store.run, fence)) return { status: WORKOUT_RUN_TERMINAL_STATES.has(store.run.state) ? "terminal" : "stale-fence" };
    if (!validDate(now) || !validDate(expiresAt) || Date.parse(expiresAt) <= Date.parse(now)) return { status: "stale-fence" };
    store.run = frozenClone({ ...store.run, claim: { ...store.run.claim!, heartbeatAt: now, expiresAt } }) as WorkoutRun;
    this.event(store, { kind: "heartbeat", occurredAt: now, safeData: { generation: fence.generation } });
    return { status: "updated", run: this.publicRun(store) };
  }

  async saveConstraintSnapshot(fence: WorkoutRunFence, snapshot: ResolvedConstraintSnapshot): Promise<FencedMutationResult> {
    const store = this.find(fence.runId);
    if (!store) return { status: "missing" };
    if (!this.hasActiveFence(store.run, fence)) return { status: WORKOUT_RUN_TERMINAL_STATES.has(store.run.state) ? "terminal" : "stale-fence" };
    if (snapshot.movementGraphRevisionId !== store.run.movementGraphRevisionId
      || snapshot.memberContextRevisionId !== store.run.memberContextRevisionId) return { status: "stale-fence" };
    store.run = frozenClone({ ...store.run, constraintSnapshot: snapshot }) as WorkoutRun;
    return { status: "updated", run: this.publicRun(store) };
  }

  async saveCompletionArtifact(fence: WorkoutRunFence, artifact: WorkoutCompletionArtifact): Promise<FencedMutationResult> {
    const store = this.find(fence.runId);
    if (!store) return { status: "missing" };
    if (!this.hasActiveFence(store.run, fence)) return { status: WORKOUT_RUN_TERMINAL_STATES.has(store.run.state) ? "terminal" : "stale-fence" };
    const payload = frozenClone(artifact.payload);
    const key = artifact.kind === "revision-seals" ? "revisionSeals"
      : artifact.kind === "safety-envelope" ? "safetyEnvelope" : "modelProposal";
    const existing = store.completionArtifacts[key];
    if (existing && canonicalWorkoutDigest(existing) !== canonicalWorkoutDigest(payload)) return { status: "stale-fence" };
    store.completionArtifacts = { ...store.completionArtifacts, [key]: payload };
    return { status: "updated", run: this.publicRun(store) };
  }

  async appendEvent(fence: WorkoutRunFence, event: AppendWorkoutRunEvent): Promise<FencedMutationResult> {
    const store = this.find(fence.runId);
    if (!store) return { status: "missing" };
    if (!this.hasActiveFence(store.run, fence)) return { status: WORKOUT_RUN_TERMINAL_STATES.has(store.run.state) ? "terminal" : "stale-fence" };
    if (!isSafeProgressEvent(event)) return { status: "stale-fence" };
    this.event(store, event);
    return { status: "updated", run: this.publicRun(store) };
  }

  async awaitClarification(fence: WorkoutRunFence, at: string, candidateConceptIds: readonly string[]): Promise<ClarificationMutationResult> {
    const store = this.find(fence.runId);
    if (!store) return { status: "missing" };
    if (!this.hasActiveFence(store.run, fence)) return { status: "stale-fence" };
    if (candidateConceptIds.length === 0 || candidateConceptIds.length > WORKOUT_RUN_LIMITS.maximumClarificationCandidates) return { status: "invalid-state" };
    store.run = frozenClone({ ...store.run, state: "awaiting-clarification", claim: undefined }) as WorkoutRun;
    this.event(store, { kind: "awaiting-clarification", occurredAt: at, safeData: { candidateCount: candidateConceptIds.length } });
    return { status: "updated", run: this.publicRun(store) };
  }

  async answerClarification(runId: WorkoutRunId, coachId: string, memberId: string, revision: WorkoutRunInputRevision): Promise<ClarificationMutationResult> {
    const store = this.find(runId);
    if (!store || !sameAuthorization(store.run, coachId, memberId)) return { status: "missing" };
    if (store.run.state !== "awaiting-clarification" || !isWorkoutRunTransitionAllowed(store.run.state, "queued")) return { status: "invalid-state" };
    const last = store.run.inputRevisions.at(-1);
    if (!last || revision.revision !== last.revision + 1
      || store.run.inputRevisions.some((item) => item.inputRevisionId === revision.inputRevisionId)) return { status: "invalid-revision" };
    store.run = frozenClone({
      ...store.run,
      state: "queued",
      inputRevisions: [...store.run.inputRevisions, revision],
      activeInputRevisionId: revision.inputRevisionId,
      claim: undefined,
      failure: undefined,
    }) as WorkoutRun;
    this.event(store, { kind: "clarification-answered", occurredAt: revision.createdAt, safeData: { revision: revision.revision } });
    return { status: "updated", run: this.publicRun(store) };
  }

  async createRetry(failedRunId: WorkoutRunId, coachId: string, memberId: string, retry: WorkoutRun): Promise<RetryWorkoutRunResult> {
    const failed = this.find(failedRunId);
    if (!failed || !sameAuthorization(failed.run, coachId, memberId)) return { status: "missing" };
    if (failed.run.state !== "failed" || retry.retryOfRunId !== failedRunId
      || retry.coachId !== coachId || retry.memberId !== memberId || retry.state !== "queued") return { status: "not-retryable" };
    return this.createOrFind(retry);
  }

  async fail(fence: WorkoutRunFence, failure: WorkoutRunFailure): Promise<FencedMutationResult> {
    const store = this.find(fence.runId);
    if (!store) return { status: "missing" };
    if (!this.hasActiveFence(store.run, fence)) return { status: WORKOUT_RUN_TERMINAL_STATES.has(store.run.state) ? "terminal" : "stale-fence" };
    store.run = frozenClone({ ...store.run, state: "failed", failure, endedAt: failure.occurredAt, claim: undefined }) as WorkoutRun;
    this.event(store, { kind: "failed", occurredAt: failure.occurredAt, safeData: { kind: failure.kind, stage: failure.stage } });
    return { status: "updated", run: this.publicRun(store) };
  }

  async cancel(runId: WorkoutRunId, coachId: string, memberId: string, at: string): Promise<FencedMutationResult> {
    const store = this.find(runId);
    if (!store || !sameAuthorization(store.run, coachId, memberId)) return { status: "missing" };
    if (WORKOUT_RUN_TERMINAL_STATES.has(store.run.state)) return { status: "terminal" };
    if (!isWorkoutRunTransitionAllowed(store.run.state, "canceled")) return { status: "terminal" };
    store.run = frozenClone({ ...store.run, state: "canceled", endedAt: at, claim: undefined }) as WorkoutRun;
    this.event(store, { kind: "canceled", occurredAt: at, safeData: {} });
    return { status: "updated", run: this.publicRun(store) };
  }

  async complete(input: CompleteWorkoutRunInput): Promise<{ readonly status: "completed"; readonly run: CompletedWorkoutRun } | { readonly status: "stale-fence" | "canceled" | "invalid-receipt" | "missing" }> {
    const store = this.find(input.fence.runId);
    if (!store) return { status: "missing" };
    if (store.run.state === "canceled") return { status: "canceled" };
    if (store.run.state === "completed") {
      return store.workout?.workoutVersionId === input.workoutVersion.workoutVersionId
        ? { status: "completed", run: this.completed(store) }
        : { status: "invalid-receipt" };
    }
    if (!this.hasActiveFence(store.run, input.fence)) return { status: "stale-fence" };
    if (!validateCompletionBindings(store.run, input, store.completionArtifacts)) return { status: "invalid-receipt" };
    const endedAt = input.workoutVersion.createdAt;
    store.workout = frozenClone(input.workoutVersion) as ImmutableWorkoutVersion;
    store.provenance = frozenClone(input.provenance) as WorkoutProvenanceBundle;
    store.validationReceipt = frozenClone(input.validationReceipt) as WorkoutValidationReceipt;
    store.run = frozenClone({ ...store.run, state: "completed", endedAt, claim: undefined }) as WorkoutRun;
    this.event(store, { kind: "completed", occurredAt: endedAt, safeData: { workoutVersionId: input.workoutVersion.workoutVersionId } });
    return { status: "completed", run: this.completed(store) };
  }

  private completed(store: StoredRun): CompletedWorkoutRun {
    return frozenClone({
      ...store.run,
      state: "completed",
      endedAt: store.run.endedAt!,
      workoutVersion: store.workout!,
      provenance: store.provenance!,
      validationReceipt: store.validationReceipt!,
    }) as CompletedWorkoutRun;
  }

  async getRun(runId: WorkoutRunId, coachId: string, memberId: string): Promise<WorkoutRun | undefined> {
    const store = this.find(runId);
    return store && sameAuthorization(store.run, coachId, memberId) ? this.publicRun(store) : undefined;
  }
  async getWorkout(runId: WorkoutRunId, coachId: string, memberId: string): Promise<ImmutableWorkoutVersion | undefined> {
    const store = this.find(runId);
    return store && sameAuthorization(store.run, coachId, memberId) && store.workout ? frozenClone(store.workout) as ImmutableWorkoutVersion : undefined;
  }
  async getProvenance(runId: WorkoutRunId, coachId: string, memberId: string): Promise<WorkoutProvenanceBundle | undefined> {
    const store = this.find(runId);
    return store && sameAuthorization(store.run, coachId, memberId) && store.provenance ? frozenClone(store.provenance) as WorkoutProvenanceBundle : undefined;
  }
  async getCompletionProjection(runId: WorkoutRunId, coachId: string, memberId: string): Promise<WorkoutCompletionProjection | undefined> {
    const store = this.find(runId);
    const { revisionSeals, safetyEnvelope, modelProposal } = store?.completionArtifacts ?? {};
    return store && sameAuthorization(store.run, coachId, memberId) && store.run.state === "completed"
      && revisionSeals && safetyEnvelope && modelProposal && store.validationReceipt
      ? frozenClone({ revisionSeals, safetyEnvelope, modelProposal, validationReceipt: store.validationReceipt }) as WorkoutCompletionProjection
      : undefined;
  }

  private cursor(payload: CursorPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", this.cursorSecret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }
  private parseCursor(cursor: string): CursorPayload | undefined {
    const [encoded, supplied, extra] = cursor.split(".");
    if (!encoded || !supplied || extra) return undefined;
    const expected = createHmac("sha256", this.cursorSecret).update(encoded).digest();
    let received: Buffer;
    try { received = Buffer.from(supplied, "base64url"); } catch { return undefined; }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return undefined;
    try {
      const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as CursorPayload;
      return value.schemaVersion === WORKOUT_RUN_CURSOR_SCHEMA_VERSION
        && typeof value.runId === "string"
        && Number.isInteger(value.nextSequence)
        && value.nextSequence > 0 ? value : undefined;
    } catch { return undefined; }
  }

  async readEvents(runId: WorkoutRunId, coachId: string, memberId: string, options: { readonly cursor?: string; readonly limit: number }): Promise<WorkoutRunEventReadResult> {
    const store = this.find(runId);
    if (!store || !sameAuthorization(store.run, coachId, memberId)) return { status: "not-found" };
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > WORKOUT_RUN_LIMITS.maximumEventPageSize) return { status: "not-found" };
    const highWaterSequence = store.nextEventSequence - 1;
    let nextSequence = store.events[0]?.sequence ?? store.nextEventSequence;
    if (options.cursor) {
      const parsed = this.parseCursor(options.cursor);
      if (!parsed || parsed.runId !== runId || parsed.nextSequence > store.nextEventSequence) return { status: "not-found" };
      nextSequence = parsed.nextSequence;
      const minimum = store.events[0]?.sequence ?? store.nextEventSequence;
      if (nextSequence < minimum) return { status: "resync_required", snapshotUrl: `/api/workout-runs/${runId}` };
    }
    const events = store.events
      .filter((event) => event.sequence >= nextSequence)
      .slice(0, options.limit)
      .map((event) => ({
        event: frozenClone(event) as WorkoutRunEvent,
        cursor: this.cursor({ schemaVersion: WORKOUT_RUN_CURSOR_SCHEMA_VERSION, runId, nextSequence: event.sequence + 1 }),
      }));
    const after = events.at(-1)?.event.sequence !== undefined ? events.at(-1)!.event.sequence + 1 : nextSequence;
    return { status: "ready", events, nextCursor: this.cursor({ schemaVersion: WORKOUT_RUN_CURSOR_SCHEMA_VERSION, runId, nextSequence: after }), highWaterSequence };
  }
}
