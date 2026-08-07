import { canonicalWorkoutDigest } from "../../graph/schema/workout-run-schema";
import { asWorkoutInputRevisionId, asWorkoutRunId, type WorkoutRunId } from "../../domain/contracts/workout";
import type { WorkoutRun } from "../../domain/contracts/workout-run";
import type { WorkerAuthorizationPort } from "../ports/worker-authorization";
import type { WorkoutRunRepository } from "../ports/workout-run-repository";
import { reserveWorkoutRunCreation } from "./reserve-workout-run-creation";

export type SubmitWorkoutRunInput = {
  readonly coachId: string;
  readonly memberId: string;
  readonly sessionAuthorizationId: string;
  readonly prompt: string;
  readonly durationMinutes: number;
  readonly idempotencyKey: string;
};

export type SubmitWorkoutRunResult =
  | { readonly status: "created" | "replayed"; readonly runId: WorkoutRunId }
  | { readonly status: "invalid-request" | "not-authorized" | "canonical-state-unavailable" | "idempotency-conflict" };

export type SubmitWorkoutRunDependencies = {
  readonly repository: WorkoutRunRepository;
  readonly authorization: WorkerAuthorizationPort;
  readonly pinRevisions: (input: {
    readonly coachId: string;
    readonly memberId: string;
    readonly sessionAuthorizationId: string;
  }) => Promise<
    | { readonly status: "ready"; readonly movementGraphRevisionId: string; readonly memberContextRevisionId: string }
    | { readonly status: "denied" | "unavailable" }
  >;
  readonly protectPrompt: (input: {
    readonly coachId: string;
    readonly memberId: string;
    readonly runId: WorkoutRunId;
    readonly prompt: string;
    readonly provisioningKey: string;
  }) => Promise<{ readonly status: "stored"; readonly protectedPromptSnapshotId: string } | { readonly status: "failed" }>;
  readonly createId: (kind: "workout-run" | "input-revision") => string;
  readonly now: () => string;
  readonly modelConfigurationId: string;
  readonly policyRevision: string;
  readonly waitForReservation?: () => Promise<void>;
};

function valid(input: SubmitWorkoutRunInput) {
  return input.coachId.trim().length > 0
    && input.memberId.trim().length > 0
    && input.memberId.length <= 200
    && input.sessionAuthorizationId.trim().length > 0
    && input.prompt.trim().length > 0
    && input.prompt.length <= 2_000
    && Number.isInteger(input.durationMinutes)
    && input.durationMinutes >= 30
    && input.durationMinutes <= 60
    && input.durationMinutes % 5 === 0
    && input.idempotencyKey.trim().length > 0
    && input.idempotencyKey.length <= 200;
}

export function createSubmitWorkoutRun(dependencies: SubmitWorkoutRunDependencies) {
  return async (input: SubmitWorkoutRunInput): Promise<SubmitWorkoutRunResult> => {
    if (!valid(input)) return { status: "invalid-request" };
    const pinned = await dependencies.pinRevisions({
      coachId: input.coachId,
      memberId: input.memberId,
      sessionAuthorizationId: input.sessionAuthorizationId,
    });
    if (pinned.status === "denied") return { status: "not-authorized" };
    if (pinned.status !== "ready" || !pinned.movementGraphRevisionId || !pinned.memberContextRevisionId) {
      return { status: "canonical-state-unavailable" };
    }

    const promptDigest = canonicalWorkoutDigest(input.prompt);
    const idempotencyKeyDigest = canonicalWorkoutDigest(input.idempotencyKey);
    const requestDigest = canonicalWorkoutDigest({
      action: "generate-workout",
      coachId: input.coachId,
      memberId: input.memberId,
      promptDigest,
      requestedDurationMinutes: input.durationMinutes,
      modelConfigurationId: dependencies.modelConfigurationId,
      policyRevision: dependencies.policyRevision,
      movementGraphRevisionId: pinned.movementGraphRevisionId,
      memberContextRevisionId: pinned.memberContextRevisionId,
    });
    const proposedRunId = asWorkoutRunId(dependencies.createId("workout-run"));
    const ownerId = proposedRunId;
    const reserved = await reserveWorkoutRunCreation({
      repository: dependencies.repository,
      identity: {
        coachId: input.coachId,
        memberId: input.memberId,
        action: "generate-workout",
        idempotencyKeyDigest,
        requestDigest,
      },
      proposedRunId,
      ownerId,
      now: dependencies.now,
      ...(dependencies.waitForReservation ? { wait: dependencies.waitForReservation } : {}),
    });
    if (reserved.status === "replayed") return { status: "replayed", runId: reserved.run.runId };
    if (reserved.status === "idempotency-conflict") return { status: "idempotency-conflict" };
    if (reserved.status !== "reserved") return { status: "canonical-state-unavailable" };
    const { reservation } = reserved;
    const runId = reservation.runId;
    const provisioningKey = `workout-run-creation:${runId}`;
    let grant;
    let protectedPrompt;
    try {
      grant = await dependencies.authorization.createReference({
        coachId: input.coachId,
        memberId: input.memberId,
        runId,
        sessionAuthorizationId: input.sessionAuthorizationId,
        provisioningKey,
        provisionedAt: reservation.createdAt,
      });
      if (grant.status !== "authorized") {
        await dependencies.repository.releaseCreation(reservation);
        return { status: "not-authorized" };
      }
      protectedPrompt = await dependencies.protectPrompt({
        coachId: input.coachId,
        memberId: input.memberId,
        runId,
        prompt: input.prompt,
        provisioningKey,
      });
      if (protectedPrompt.status !== "stored") {
        await dependencies.repository.releaseCreation(reservation);
        return { status: "canonical-state-unavailable" };
      }
    } catch (error) {
      await dependencies.repository.releaseCreation(reservation);
      throw error;
    }
    const createdAt = dependencies.now();
    const inputRevisionId = asWorkoutInputRevisionId(dependencies.createId("input-revision"));
    const run: WorkoutRun = {
      runId,
      coachId: input.coachId,
      memberId: input.memberId,
      authorizationReferenceId: grant.authorizationReferenceId,
      idempotencyKeyDigest,
      requestDigest,
      requestedDurationMinutes: input.durationMinutes,
      modelConfigurationId: dependencies.modelConfigurationId,
      policyRevision: dependencies.policyRevision,
      movementGraphRevisionId: pinned.movementGraphRevisionId,
      memberContextRevisionId: pinned.memberContextRevisionId,
      state: "queued",
      inputRevisions: [{
        inputRevisionId,
        revision: 1,
        protectedPromptSnapshotId: protectedPrompt.protectedPromptSnapshotId,
        promptDigest,
        effectiveInputDigest: canonicalWorkoutDigest({ requestDigest, promptDigest, revision: 1 }),
        createdAt,
      }],
      activeInputRevisionId: inputRevisionId,
    };
    const result = await dependencies.repository.finalizeCreation(reservation, run);
    if (result.status === "created" || result.status === "replayed") return { status: result.status, runId: result.run.runId };
    if (result.status === "idempotency-conflict") return { status: "idempotency-conflict" };
    const recovered = await reserveWorkoutRunCreation({
      repository: dependencies.repository,
      identity: { coachId: input.coachId, memberId: input.memberId, action: "generate-workout", idempotencyKeyDigest, requestDigest },
      proposedRunId,
      ownerId,
      now: dependencies.now,
      ...(dependencies.waitForReservation ? { wait: dependencies.waitForReservation } : {}),
    });
    if (recovered.status === "replayed") return { status: "replayed", runId: recovered.run.runId };
    if (recovered.status === "reserved" && recovered.reservation.runId === run.runId) {
      const finalized = await dependencies.repository.finalizeCreation(recovered.reservation, run);
      if (finalized.status === "created" || finalized.status === "replayed") return { status: finalized.status, runId: finalized.run.runId };
    }
    return recovered.status === "idempotency-conflict" ? { status: "idempotency-conflict" } : { status: "canonical-state-unavailable" };
  };
}
