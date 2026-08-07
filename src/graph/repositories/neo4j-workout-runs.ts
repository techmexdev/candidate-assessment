import { createHmac, timingSafeEqual } from "node:crypto";
import neo4j from "neo4j-driver";
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
  WorkoutClarificationDescriptor,
  WorkoutRevisionSealArtifact,
  WorkoutRun,
  WorkoutRunFailure,
} from "../../domain/contracts/workout-run";
import type { ImmutableWorkoutVersion, WorkoutRunId } from "../../domain/contracts/workout";
import type { WorkoutProvenanceBundle } from "../../domain/contracts/workout-provenance";
import type { CatalogSafetyReadyResult } from "../../domain/contracts/catalog-safety";
import type { WorkoutCompositionProposal } from "../../domain/policies/workout-composition";
import { validateWorkoutProvenance } from "../../domain/contracts/workout-provenance";
import { WORKOUT_RUN_CYPHER } from "../cypher/workout-runs";
import type { Neo4jClient, Neo4jRecord, Neo4jTransaction } from "../neo4j/client";
import { deepFreeze } from "../revisions/movement-graph";
import {
  WORKOUT_RUN_CURSOR_SCHEMA_VERSION,
  WORKOUT_RUN_EVENT_SCHEMA_VERSION,
  WORKOUT_RUN_LIMITS,
  WORKOUT_RUN_TERMINAL_STATES,
} from "../schema/workout-run-schema";
import { validateCompletionBindings, validClarificationDescriptor, type CompletionArtifactStore } from "./workout-runs";

type Neo4jNode = { readonly properties: Readonly<Record<string, unknown>> };
type CursorPayload = {
  readonly schemaVersion: typeof WORKOUT_RUN_CURSOR_SCHEMA_VERSION;
  readonly runId: string;
  readonly nextSequence: number;
};

const json = (value: unknown) => JSON.stringify(value);
const parse = <Value>(value: unknown): Value | undefined => {
  if (typeof value !== "string") return undefined;
  try { return JSON.parse(value) as Value; } catch { return undefined; }
};
const node = (record: Neo4jRecord | undefined, key = "run") => record?.get(key) as Neo4jNode | undefined;
const number = (value: unknown): number => typeof value === "number" ? value : Number(value ?? 0);
const frozen = <Value>(value: Value): Readonly<Value> => deepFreeze(structuredClone(value));
const safeProgressEvent = (event: AppendWorkoutRunEvent) => {
  const entries = Object.entries(event.safeData);
  return event.kind === "stage"
    && Number.isFinite(Date.parse(event.occurredAt))
    && entries.length <= 16
    && entries.every(([key, value]) => {
      const primitive = value === null || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value))
        || (typeof value === "string" && value.length <= 256);
      return primitive && !/(prompt|evidence|rationale|provider|authorization|grant|token|cookie|payload)/i.test(key);
    });
};

async function readInputRevisions(transaction: Neo4jTransaction, runId: string) {
  const result = await transaction.run(WORKOUT_RUN_CYPHER.readInputs, { runId });
  return result.records.flatMap((record) => {
    const revision = parse<WorkoutRunInputRevision>(record.get("payload"));
    return revision ? [revision] : [];
  });
}

async function hydrateRun(transaction: Neo4jTransaction, value: Neo4jNode): Promise<WorkoutRun | undefined> {
  const base = parse<WorkoutRun>(value.properties.payload);
  if (!base) return undefined;
  const inputRevisions = await readInputRevisions(transaction, base.runId);
  const claimGeneration = number(value.properties.claimGeneration);
  const claimWorkerId = value.properties.claimWorkerId;
  const claim = typeof claimWorkerId === "string" ? {
    generation: claimGeneration,
    workerId: claimWorkerId,
    claimedAt: String(value.properties.claimedAt),
    heartbeatAt: String(value.properties.heartbeatAt),
    expiresAt: String(value.properties.claimExpiresAt),
  } : undefined;
  const constraintSnapshot = parse<ResolvedConstraintSnapshot>(value.properties.constraintSnapshot);
  const clarification = parse<WorkoutClarificationDescriptor>(value.properties.clarificationDescriptor);
  const failure = parse<WorkoutRunFailure>(value.properties.failure);
  return frozen({
    ...base,
    state: String(value.properties.state) as WorkoutRun["state"],
    inputRevisions: inputRevisions.length > 0 ? inputRevisions : base.inputRevisions,
    activeInputRevisionId: (value.properties.activeInputRevisionId as WorkoutRun["activeInputRevisionId"] | undefined) ?? base.activeInputRevisionId,
    ...(claim ? { claim } : { claim: undefined }),
    ...(constraintSnapshot ? { constraintSnapshot } : {}),
    ...(clarification ? { clarification } : { clarification: undefined }),
    ...(failure ? { failure } : { failure: undefined }),
    ...(typeof value.properties.startedAt === "string" ? { startedAt: value.properties.startedAt } : {}),
    ...(typeof value.properties.endedAt === "string" ? { endedAt: value.properties.endedAt } : {}),
  }) as WorkoutRun;
}

export type Neo4jWorkoutRunRepositoryOptions = { readonly cursorSecret: string | Uint8Array };

export class Neo4jWorkoutRunRepository implements WorkoutRunRepository {
  private readonly cursorSecret: Buffer;
  constructor(private readonly client: Neo4jClient, options: Neo4jWorkoutRunRepositoryOptions) {
    this.cursorSecret = Buffer.from(options.cursorSecret);
    if (this.cursorSecret.length < 16) throw new Error("Workout run cursor secret must contain at least 16 bytes");
  }

  private async readStore(transaction: Neo4jTransaction, runId: WorkoutRunId): Promise<WorkoutRun | undefined> {
    const result = await transaction.run(WORKOUT_RUN_CYPHER.read, { runId });
    const stored = node(result.records[0]);
    return stored ? hydrateRun(transaction, stored) : undefined;
  }

  private async systemEvent(transaction: Neo4jTransaction, runId: WorkoutRunId, event: AppendWorkoutRunEvent) {
    await transaction.run(WORKOUT_RUN_CYPHER.appendSystemEvent, {
      runId,
      eventIdPrefix: `${runId}:event:`,
      eventSchemaVersion: WORKOUT_RUN_EVENT_SCHEMA_VERSION,
      kind: event.kind,
      occurredAt: event.occurredAt,
      safeData: json(event.safeData),
    });
  }

  async reserveCreation(input: WorkoutRunCreationReservation): Promise<ReserveWorkoutRunCreationResult> {
    return this.client.executeWrite(async (transaction) => {
      const result = await transaction.run(WORKOUT_RUN_CYPHER.reserveCreation, input);
      const record = result.records[0];
      const status = record?.get("status");
      if (status === "replayed") {
        const existing = node(record, "existing");
        const run = existing ? await hydrateRun(transaction, existing) : undefined;
        return run ? { status: "replayed", run } : { status: "pending" };
      }
      if (status === "idempotency-conflict") return { status: "idempotency-conflict" };
      if (status !== "reserved") return { status: "pending" };
      return {
        status: "reserved",
        reservation: {
          ...input,
          runId: String(record?.get("runId")) as WorkoutRunId,
          requestDigest: String(record?.get("requestDigest")),
          createdAt: String(record?.get("createdAt")),
          expiresAt: String(record?.get("expiresAt")),
        },
      };
    });
  }

  async finalizeCreation(
    reservation: WorkoutRunCreationReservation,
    run: WorkoutRun,
  ): Promise<FinalizeWorkoutRunCreationResult> {
    const parameters = {
      ...reservation,
      retryOfRunId: run.retryOfRunId ?? null,
      predecessorRunId: run.predecessorRunId ?? null,
      predecessorWorkoutVersionId: run.predecessorWorkoutVersionId ?? null,
      authorizationReferenceId: run.authorizationReferenceId,
      payload: json(run),
      inputRevisionId: run.inputRevisions[0]?.inputRevisionId,
      inputPayload: json(run.inputRevisions[0]),
      queuedEventId: `${run.runId}:event:1`,
      eventSchemaVersion: WORKOUT_RUN_EVENT_SCHEMA_VERSION,
      queuedAt: run.inputRevisions[0]?.createdAt ?? new Date(0).toISOString(),
    };
    return this.client.executeWrite(async (transaction) => {
      const result = await transaction.run(WORKOUT_RUN_CYPHER.finalizeCreation, parameters);
      const createdNode = node(result.records[0]);
      if (createdNode) {
        const created = await hydrateRun(transaction, createdNode);
        if (created) return { status: "created", run: created };
      }
      const found = await transaction.run(WORKOUT_RUN_CYPHER.findByIdentity, parameters);
      const existingNode = node(found.records[0]);
      const existing = existingNode ? await hydrateRun(transaction, existingNode) : undefined;
      if (!existing) return { status: "stale-reservation" };
      return existing.requestDigest === run.requestDigest
        ? { status: "replayed", run: existing }
        : { status: "idempotency-conflict" };
    });
  }

  async releaseCreation(reservation: WorkoutRunCreationReservation): Promise<void> {
    await this.client.executeWrite(async (transaction) => {
      await transaction.run(WORKOUT_RUN_CYPHER.releaseCreation, reservation);
    });
  }

  async createOrFind(run: WorkoutRun): Promise<CreateWorkoutRunResult> {
    const parameters = {
      runId: run.runId,
      coachId: run.coachId,
      memberId: run.memberId,
      action: "generate-workout",
      authorizationReferenceId: run.authorizationReferenceId,
      idempotencyKeyDigest: run.idempotencyKeyDigest,
      requestDigest: run.requestDigest,
      payload: json(run),
      inputRevisionId: run.inputRevisions[0]?.inputRevisionId,
      inputPayload: json(run.inputRevisions[0]),
      queuedEventId: `${run.runId}:event:1`,
      eventSchemaVersion: WORKOUT_RUN_EVENT_SCHEMA_VERSION,
      queuedAt: run.inputRevisions[0]?.createdAt ?? new Date(0).toISOString(),
      predecessorRunId: run.predecessorRunId ?? null,
      predecessorWorkoutVersionId: run.predecessorWorkoutVersionId ?? null,
    };
    const execute = () => this.client.executeWrite(async (transaction) => {
      const found = await transaction.run(WORKOUT_RUN_CYPHER.findByIdentity, parameters);
      const existingNode = node(found.records[0]);
      if (existingNode) {
        const existing = await hydrateRun(transaction, existingNode);
        return existing?.requestDigest === run.requestDigest && existing
          ? { status: "replayed" as const, run: existing }
          : { status: "idempotency-conflict" as const };
      }
      const created = await transaction.run(WORKOUT_RUN_CYPHER.create, parameters);
      const createdNode = node(created.records[0]);
      const hydrated = createdNode ? await hydrateRun(transaction, createdNode) : undefined;
      return hydrated ? { status: "created" as const, run: hydrated } : { status: "idempotency-conflict" as const };
    });
    try { return await execute(); } catch {
      return this.client.executeRead(async (transaction) => {
        const found = await transaction.run(WORKOUT_RUN_CYPHER.findByIdentity, parameters);
        const existingNode = node(found.records[0]);
        const existing = existingNode ? await hydrateRun(transaction, existingNode) : undefined;
        return existing?.requestDigest === run.requestDigest && existing
          ? { status: "replayed", run: existing }
          : { status: "idempotency-conflict" };
      });
    }
  }

  async createAdjustment(run: WorkoutRun): Promise<import("../../application/ports/workout-run-repository").CreateWorkoutAdjustmentResult> {
    if (!run.predecessorRunId || !run.predecessorWorkoutVersionId) return { status: "invalid-predecessor" };
    const predecessor = await this.getRun(run.predecessorRunId, run.coachId, run.memberId);
    if (!predecessor) return { status: "missing" };
    if (predecessor.state !== "completed") return { status: "invalid-predecessor" };
    const workout = await this.getWorkout(run.predecessorRunId, run.coachId, run.memberId);
    if (!workout || workout.workoutVersionId !== run.predecessorWorkoutVersionId) return { status: "invalid-predecessor" };
    const parameters = {
      runId: run.runId,
      coachId: run.coachId,
      memberId: run.memberId,
      action: "adjust-workout",
      authorizationReferenceId: run.authorizationReferenceId,
      idempotencyKeyDigest: run.idempotencyKeyDigest,
      requestDigest: run.requestDigest,
      payload: json(run),
      inputRevisionId: run.inputRevisions[0]?.inputRevisionId,
      inputPayload: json(run.inputRevisions[0]),
      queuedEventId: `${run.runId}:event:1`,
      eventSchemaVersion: WORKOUT_RUN_EVENT_SCHEMA_VERSION,
      queuedAt: run.inputRevisions[0]?.createdAt ?? new Date(0).toISOString(),
      predecessorRunId: run.predecessorRunId,
      predecessorWorkoutVersionId: run.predecessorWorkoutVersionId,
    };
    return this.client.executeWrite(async (transaction) => {
      const found = await transaction.run(WORKOUT_RUN_CYPHER.findByIdentity, parameters);
      const existingNode = node(found.records[0]);
      if (existingNode) {
        const existing = await hydrateRun(transaction, existingNode);
        return existing?.requestDigest === run.requestDigest && existing
          ? { status: "replayed" as const, run: existing }
          : { status: "idempotency-conflict" as const };
      }
      const stale = await transaction.run(`
        MATCH (source:WorkoutRun {runId: $predecessorRunId, coachId: $coachId, memberId: $memberId, state: 'completed'})
        OPTIONAL MATCH (successor:WorkoutRun)-[:ADJUSTS_FROM]->(source)
        RETURN source, count(successor) AS successors
      `, parameters);
      const staleRecord = stale.records[0];
      if (!staleRecord || Number(staleRecord.get("successors") ?? 0) > 0) return { status: "stale-predecessor" };
      const created = await transaction.run(WORKOUT_RUN_CYPHER.create, parameters);
      const createdNode = node(created.records[0]);
      const hydrated = createdNode ? await hydrateRun(transaction, createdNode) : undefined;
      return hydrated ? { status: "created" as const, run: hydrated } : { status: "idempotency-conflict" as const };
    });
  }

  async claim(runId: WorkoutRunId, workerId: string, now: string, expiresAt: string): Promise<ClaimWorkoutRunResult> {
    if (!workerId.trim() || !Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(now)) return { status: "not-claimable" };
    return this.client.executeWrite(async (transaction) => {
      const result = await transaction.run(WORKOUT_RUN_CYPHER.claim, { runId, workerId, now, expiresAt });
      const claimedNode = node(result.records[0]);
      if (!claimedNode) return (await this.readStore(transaction, runId)) ? { status: "not-claimable" } : { status: "missing" };
      const run = await hydrateRun(transaction, claimedNode);
      if (!run?.claim) return { status: "not-claimable" };
      await this.systemEvent(transaction, runId, { kind: "claimed", occurredAt: now, safeData: { generation: run.claim.generation, workerId } });
      return { status: "claimed", run, fence: { runId, generation: run.claim.generation, workerId } };
    });
  }

  async heartbeat(fence: WorkoutRunFence, now: string, expiresAt: string): Promise<FencedMutationResult> {
    if (!Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(now)) return { status: "stale-fence" };
    return this.fencedUpdate(fence, WORKOUT_RUN_CYPHER.heartbeat, { now, expiresAt }, { kind: "heartbeat", occurredAt: now, safeData: { generation: fence.generation } });
  }

  async saveConstraintSnapshot(fence: WorkoutRunFence, snapshot: ResolvedConstraintSnapshot): Promise<FencedMutationResult> {
    const current = await this.getRunInternal(fence.runId);
    if (current && (snapshot.movementGraphRevisionId !== current.movementGraphRevisionId || snapshot.memberContextRevisionId !== current.memberContextRevisionId)) return { status: "stale-fence" };
    return this.fencedUpdate(fence, WORKOUT_RUN_CYPHER.saveConstraintSnapshot, { snapshot: json(snapshot) });
  }

  async saveCompletionArtifact(fence: WorkoutRunFence, artifact: WorkoutCompletionArtifact): Promise<FencedMutationResult> {
    const query = artifact.kind === "revision-seals" ? WORKOUT_RUN_CYPHER.saveRevisionSeals
      : artifact.kind === "safety-envelope" ? WORKOUT_RUN_CYPHER.saveSafetyEnvelope
        : WORKOUT_RUN_CYPHER.saveModelProposal;
    return this.fencedUpdate(fence, query, { artifact: json(artifact.payload) });
  }

  private async readCompletionArtifacts(transaction: Neo4jTransaction, runId: WorkoutRunId): Promise<CompletionArtifactStore> {
    const result = await transaction.run(WORKOUT_RUN_CYPHER.readCompletionArtifacts, { runId });
    const record = result.records[0];
    return {
      revisionSeals: parse<WorkoutRevisionSealArtifact>(record?.get("revisionSeals")),
      safetyEnvelope: parse<CatalogSafetyReadyResult>(record?.get("safetyEnvelope")),
      modelProposal: parse<WorkoutCompositionProposal>(record?.get("modelProposal")),
    };
  }

  private async fencedUpdate(
    fence: WorkoutRunFence,
    query: string,
    extra: Readonly<Record<string, unknown>>,
    event?: AppendWorkoutRunEvent,
  ): Promise<FencedMutationResult> {
    return this.client.executeWrite(async (transaction) => {
      const result = await transaction.run(query, { runId: fence.runId, generation: fence.generation, workerId: fence.workerId, ...extra });
      const updatedNode = node(result.records[0]);
      if (!updatedNode) {
        const current = await this.readStore(transaction, fence.runId);
        return !current ? { status: "missing" } : WORKOUT_RUN_TERMINAL_STATES.has(current.state) ? { status: "terminal" } : { status: "stale-fence" };
      }
      if (event) await this.systemEvent(transaction, fence.runId, event);
      const run = await hydrateRun(transaction, updatedNode);
      return run ? { status: "updated", run } : { status: "missing" };
    });
  }

  async appendEvent(fence: WorkoutRunFence, event: AppendWorkoutRunEvent): Promise<FencedMutationResult> {
    if (!safeProgressEvent(event)) return { status: "stale-fence" };
    return this.client.executeWrite(async (transaction) => {
      const result = await transaction.run(WORKOUT_RUN_CYPHER.allocateEvent, {
        runId: fence.runId,
        generation: fence.generation,
        workerId: fence.workerId,
        eventIdPrefix: `${fence.runId}:event:`,
        eventSchemaVersion: WORKOUT_RUN_EVENT_SCHEMA_VERSION,
        kind: event.kind,
        occurredAt: event.occurredAt,
        safeData: json(event.safeData),
      });
      const updatedNode = node(result.records[0]);
      if (!updatedNode) {
        const current = await this.readStore(transaction, fence.runId);
        return !current ? { status: "missing" } : WORKOUT_RUN_TERMINAL_STATES.has(current.state) ? { status: "terminal" } : { status: "stale-fence" };
      }
      const run = await hydrateRun(transaction, updatedNode);
      return run ? { status: "updated", run } : { status: "missing" };
    });
  }

  async awaitClarification(fence: WorkoutRunFence, at: string, clarification: WorkoutClarificationDescriptor | readonly string[]): Promise<ClarificationMutationResult> {
    const descriptor = Array.isArray(clarification) ? undefined : clarification as WorkoutClarificationDescriptor;
    const candidateConceptIds = descriptor ? [] : clarification as readonly string[];
    const candidateCount = descriptor ? descriptor.fields.length : candidateConceptIds.length;
    if (candidateCount === 0 || candidateCount > WORKOUT_RUN_LIMITS.maximumClarificationCandidates
      || (descriptor && !validClarificationDescriptor(descriptor))) return { status: "invalid-state" };
    return this.client.executeWrite(async (transaction) => {
      const result = await transaction.run(WORKOUT_RUN_CYPHER.awaitClarification, {
        runId: fence.runId,
        generation: fence.generation,
        workerId: fence.workerId,
        candidateConceptIds,
        clarificationDescriptor: descriptor ? json(descriptor) : null,
      });
      const updatedNode = node(result.records[0]);
      if (!updatedNode) return (await this.readStore(transaction, fence.runId)) ? { status: "stale-fence" } : { status: "missing" };
      await this.systemEvent(transaction, fence.runId, { kind: "awaiting-clarification", occurredAt: at, safeData: { candidateCount } });
      const run = await hydrateRun(transaction, updatedNode);
      return run ? { status: "updated", run } : { status: "missing" };
    });
  }

  async answerClarification(runId: WorkoutRunId, coachId: string, memberId: string, revision: WorkoutRunInputRevision): Promise<ClarificationMutationResult> {
    return this.client.executeWrite(async (transaction) => {
      const current = await this.readStore(transaction, runId);
      if (!current || current.coachId !== coachId || current.memberId !== memberId) return { status: "missing" };
      if (current.state !== "awaiting-clarification") return { status: "invalid-state" };
      const last = current.inputRevisions.at(-1);
      if (!last || revision.revision !== last.revision + 1 || current.inputRevisions.some((item) => item.inputRevisionId === revision.inputRevisionId)) return { status: "invalid-revision" };
      const result = await transaction.run(WORKOUT_RUN_CYPHER.answerClarification, { runId, coachId, memberId, inputRevisionId: revision.inputRevisionId, revision: revision.revision, inputPayload: json(revision) });
      const updatedNode = node(result.records[0]);
      if (!updatedNode) return { status: "invalid-revision" };
      await this.systemEvent(transaction, runId, { kind: "clarification-answered", occurredAt: revision.createdAt, safeData: { revision: revision.revision } });
      const run = await hydrateRun(transaction, updatedNode);
      return run ? { status: "updated", run } : { status: "missing" };
    });
  }

  async createRetry(failedRunId: WorkoutRunId, coachId: string, memberId: string, retry: WorkoutRun): Promise<RetryWorkoutRunResult> {
    const failed = await this.getRun(failedRunId, coachId, memberId);
    if (!failed) return { status: "missing" };
    if (failed.state !== "failed" || retry.retryOfRunId !== failedRunId || retry.coachId !== coachId || retry.memberId !== memberId || retry.state !== "queued") return { status: "not-retryable" };
    return this.createOrFind(retry);
  }

  async fail(fence: WorkoutRunFence, failure: WorkoutRunFailure): Promise<FencedMutationResult> {
    return this.fencedUpdate(fence, WORKOUT_RUN_CYPHER.fail, { failure: json(failure), endedAt: failure.occurredAt }, { kind: "failed", occurredAt: failure.occurredAt, safeData: { kind: failure.kind, stage: failure.stage } });
  }

  async cancel(runId: WorkoutRunId, coachId: string, memberId: string, at: string): Promise<FencedMutationResult> {
    return this.client.executeWrite(async (transaction) => {
      const result = await transaction.run(WORKOUT_RUN_CYPHER.cancel, { runId, coachId, memberId, endedAt: at });
      const updatedNode = node(result.records[0]);
      if (!updatedNode) {
        const current = await this.readStore(transaction, runId);
        return !current || current.coachId !== coachId || current.memberId !== memberId ? { status: "missing" } : { status: "terminal" };
      }
      await this.systemEvent(transaction, runId, { kind: "canceled", occurredAt: at, safeData: {} });
      const run = await hydrateRun(transaction, updatedNode);
      return run ? { status: "updated", run } : { status: "missing" };
    });
  }

  async complete(input: CompleteWorkoutRunInput): Promise<{ readonly status: "completed"; readonly run: CompletedWorkoutRun } | { readonly status: "stale-fence" | "canceled" | "invalid-receipt" | "missing" }> {
    return this.client.executeWrite(async (transaction) => {
      const current = await this.readStore(transaction, input.fence.runId);
      if (!current) return { status: "missing" };
      if (current.state === "canceled") return { status: "canceled" };
      if (current.state === "completed") {
        const existing = await this.completed(transaction, current);
        return existing?.workoutVersion.workoutVersionId === input.workoutVersion.workoutVersionId ? { status: "completed", run: existing } : { status: "invalid-receipt" };
      }
      const artifacts = await this.readCompletionArtifacts(transaction, input.fence.runId);
      if (!validateCompletionBindings(current, input, artifacts)) return { status: current.claim?.generation === input.fence.generation ? "invalid-receipt" : "stale-fence" };
      const proposalEntityId = input.provenance.entities.find((entity) => entity.kind === "model-proposal")?.entityId;
      if (!proposalEntityId || validateWorkoutProvenance(input.provenance).status !== "valid") return { status: "invalid-receipt" };
      const result = await transaction.run(WORKOUT_RUN_CYPHER.complete, {
        runId: input.fence.runId,
        generation: input.fence.generation,
        workerId: input.fence.workerId,
        authorizationReferenceId: input.authorizationReferenceId,
        requestDigest: current.requestDigest,
        revisionSeals: json(artifacts.revisionSeals),
        safetyEnvelope: json(artifacts.safetyEnvelope),
        modelProposal: json(artifacts.modelProposal),
        workoutVersionId: input.workoutVersion.workoutVersionId,
        workoutVersion: input.workoutVersion.version,
        endedAt: input.workoutVersion.createdAt,
        workoutPayload: json(input.workoutVersion),
        proposalEntityId,
        sourceEntities: input.provenance.entities.filter((entity) => entity.kind !== "workout-version"),
        provenance: json(input.provenance),
        validationReceipt: json(input.validationReceipt),
        decisions: input.provenance.decisions.map((decision) => ({ decisionId: decision.decisionId, kind: decision.kind, exerciseConceptId: decision.exerciseConceptId, payload: json(decision) })),
      });
      const updatedNode = node(result.records[0]);
      if (!updatedNode) {
        const raced = await this.readStore(transaction, input.fence.runId);
        if (raced?.state === "canceled") return { status: "canceled" };
        if (raced?.state === "completed") {
          const existing = await this.completed(transaction, raced);
          if (existing?.workoutVersion.workoutVersionId === input.workoutVersion.workoutVersionId) return { status: "completed", run: existing };
        }
        return { status: "stale-fence" };
      }
      await this.systemEvent(transaction, input.fence.runId, { kind: "completed", occurredAt: input.workoutVersion.createdAt, safeData: { workoutVersionId: input.workoutVersion.workoutVersionId } });
      const run = await hydrateRun(transaction, updatedNode);
      const completed = run ? await this.completed(transaction, run) : undefined;
      return completed ? { status: "completed", run: completed } : { status: "invalid-receipt" };
    });
  }

  private async completed(transaction: Neo4jTransaction, run: WorkoutRun): Promise<CompletedWorkoutRun | undefined> {
    const workoutResult = await transaction.run(WORKOUT_RUN_CYPHER.readWorkout, { runId: run.runId, coachId: run.coachId, memberId: run.memberId });
    const provenanceResult = await transaction.run(WORKOUT_RUN_CYPHER.readProvenance, { runId: run.runId, coachId: run.coachId, memberId: run.memberId });
    const workout = parse<ImmutableWorkoutVersion>(workoutResult.records[0]?.get("payload"));
    const provenance = parse<WorkoutProvenanceBundle>(provenanceResult.records[0]?.get("payload"));
    const runNode = (await transaction.run(WORKOUT_RUN_CYPHER.read, { runId: run.runId })).records[0];
    const receipt = parse<CompletedWorkoutRun["validationReceipt"]>(node(runNode)?.properties.validationReceipt);
    if (!workout || !provenance || !receipt || run.state !== "completed" || !run.endedAt) return undefined;
    return frozen({ ...run, state: "completed", endedAt: run.endedAt, workoutVersion: workout, provenance, validationReceipt: receipt }) as CompletedWorkoutRun;
  }

  private async getRunInternal(runId: WorkoutRunId): Promise<WorkoutRun | undefined> {
    return this.client.executeRead(async (transaction) => {
      return this.readStore(transaction, runId);
    });
  }

  async getRun(runId: WorkoutRunId, coachId: string, memberId: string): Promise<WorkoutRun | undefined> {
    return this.client.executeRead(async (transaction) => {
      const run = await this.readStore(transaction, runId);
      return run && run.coachId === coachId && run.memberId === memberId ? run : undefined;
    });
  }

  async getWorkout(runId: WorkoutRunId, coachId: string, memberId: string): Promise<ImmutableWorkoutVersion | undefined> {
    return this.client.executeRead(async (transaction) => {
      const result = await transaction.run(WORKOUT_RUN_CYPHER.readWorkout, { runId, coachId, memberId });
      const workout = parse<ImmutableWorkoutVersion>(result.records[0]?.get("payload"));
      return workout ? frozen(workout) as ImmutableWorkoutVersion : undefined;
    });
  }

  async getProvenance(runId: WorkoutRunId, coachId: string, memberId: string): Promise<WorkoutProvenanceBundle | undefined> {
    return this.client.executeRead(async (transaction) => {
      const result = await transaction.run(WORKOUT_RUN_CYPHER.readProvenance, { runId, coachId, memberId });
      const provenance = parse<WorkoutProvenanceBundle>(result.records[0]?.get("payload"));
      return provenance && validateWorkoutProvenance(provenance).status === "valid" ? frozen(provenance) as WorkoutProvenanceBundle : undefined;
    });
  }

  async getCompletionProjection(runId: WorkoutRunId, coachId: string, memberId: string): Promise<WorkoutCompletionProjection | undefined> {
    return this.client.executeRead(async (transaction) => {
      const result = await transaction.run(WORKOUT_RUN_CYPHER.readAuthorizedCompletionProjection, { runId, coachId, memberId });
      const record = result.records[0];
      const revisionSeals = parse<WorkoutCompletionProjection["revisionSeals"]>(record?.get("revisionSeals"));
      const safetyEnvelope = parse<WorkoutCompletionProjection["safetyEnvelope"]>(record?.get("safetyEnvelope"));
      const modelProposal = parse<WorkoutCompletionProjection["modelProposal"]>(record?.get("modelProposal"));
      const validationReceipt = parse<WorkoutCompletionProjection["validationReceipt"]>(record?.get("validationReceipt"));
      return revisionSeals && safetyEnvelope && modelProposal && validationReceipt
        ? frozen({ revisionSeals, safetyEnvelope, modelProposal, validationReceipt }) as WorkoutCompletionProjection
        : undefined;
    });
  }

  private cursor(payload: CursorPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${createHmac("sha256", this.cursorSecret).update(encoded).digest("base64url")}`;
  }
  private parseCursor(cursor: string): CursorPayload | undefined {
    const [encoded, supplied, extra] = cursor.split(".");
    if (!encoded || !supplied || extra) return undefined;
    const expected = createHmac("sha256", this.cursorSecret).update(encoded).digest();
    const actual = Buffer.from(supplied, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
    try {
      const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as CursorPayload;
      return value.schemaVersion === WORKOUT_RUN_CURSOR_SCHEMA_VERSION && typeof value.runId === "string" && Number.isInteger(value.nextSequence) && value.nextSequence > 0 ? value : undefined;
    } catch { return undefined; }
  }

  async readEvents(runId: WorkoutRunId, coachId: string, memberId: string, options: { readonly cursor?: string; readonly limit: number }): Promise<WorkoutRunEventReadResult> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > WORKOUT_RUN_LIMITS.maximumEventPageSize) return { status: "not-found" };
    return this.client.executeRead(async (transaction) => {
      const boundsResult = await transaction.run(WORKOUT_RUN_CYPHER.eventBounds, { runId, coachId, memberId });
      const bounds = boundsResult.records[0];
      if (!bounds) return { status: "not-found" };
      const minimumSequence = number(bounds.get("minimumSequence"));
      const highWaterSequence = number(bounds.get("highWaterSequence"));
      const allocatedNextSequence = number(bounds.get("nextEventSequence"));
      let nextSequence = minimumSequence || allocatedNextSequence;
      if (options.cursor) {
        const cursor = this.parseCursor(options.cursor);
        if (!cursor || cursor.runId !== runId || cursor.nextSequence > allocatedNextSequence) return { status: "not-found" };
        nextSequence = cursor.nextSequence;
        if (minimumSequence && nextSequence < minimumSequence) return { status: "resync_required", snapshotUrl: `/api/workout-runs/${runId}` };
      }
      const result = await transaction.run(WORKOUT_RUN_CYPHER.readEvents, { runId, coachId, memberId, nextSequence, limit: neo4j.int(options.limit) });
      const rawEvents = result.records.flatMap((record): WorkoutRunEvent[] => {
        const event = node(record, "event")?.properties;
        if (!event) return [];
        return [{
          eventId: String(event.eventId),
          schemaVersion: WORKOUT_RUN_EVENT_SCHEMA_VERSION,
          runId,
          sequence: number(event.sequence),
          kind: String(event.kind) as WorkoutRunEvent["kind"],
          occurredAt: String(event.occurredAt),
          safeData: parse<WorkoutRunEvent["safeData"]>(event.safeData) ?? {},
        }];
      });
      const events = rawEvents.map((event) => ({
        event,
        cursor: this.cursor({ schemaVersion: WORKOUT_RUN_CURSOR_SCHEMA_VERSION, runId, nextSequence: event.sequence + 1 }),
      }));
      const after = rawEvents.at(-1)?.sequence !== undefined ? rawEvents.at(-1)!.sequence + 1 : nextSequence;
      return { status: "ready", events: frozen(events), nextCursor: this.cursor({ schemaVersion: WORKOUT_RUN_CURSOR_SCHEMA_VERSION, runId, nextSequence: after }), highWaterSequence };
    });
  }
}

export function createNeo4jWorkoutRunRepository(client: Neo4jClient, options: Neo4jWorkoutRunRepositoryOptions): WorkoutRunRepository {
  return new Neo4jWorkoutRunRepository(client, options);
}
