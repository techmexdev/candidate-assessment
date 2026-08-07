import { asWorkoutInputRevisionId, asWorkoutRunId, type WorkoutRunId } from "../../domain/contracts/workout";
import {
  type WorkoutRun,
  type WorkoutAdjustment,
  validateWorkoutAdjustment,
} from "../../domain/contracts/workout-run";
import { canonicalWorkoutDigest } from "../../graph/schema/workout-run-schema";
import type { WorkerAuthorizationPort } from "../ports/worker-authorization";
import type { CreateWorkoutAdjustmentResult, WorkoutRunRepository } from "../ports/workout-run-repository";
import { authorizeWorkoutRunAccess } from "./authorize-workout-run-access";
import { reserveWorkoutRunCreation } from "./reserve-workout-run-creation";

export type SubmitWorkoutAdjustmentInput = {
  readonly coachId: string;
  readonly memberId: string;
  readonly sessionAuthorizationId: string;
  readonly predecessorRunId: WorkoutRunId;
  readonly predecessorWorkoutVersionId: string;
  readonly adjustment: unknown;
  readonly idempotencyKey: string;
};

export type SubmitWorkoutAdjustmentResult =
  | { readonly status: "created" | "replayed"; readonly runId: WorkoutRunId }
  | { readonly status: "invalid-request" | "not-authorized" | "canonical-state-unavailable" | "idempotency-conflict" | "stale-predecessor" };

export type SubmitWorkoutAdjustmentDependencies = {
  readonly repository: WorkoutRunRepository;
  readonly authorization: WorkerAuthorizationPort;
  readonly protectPrompt: (input: {
    readonly coachId: string;
    readonly memberId: string;
    readonly runId: WorkoutRunId;
    readonly prompt: string;
  }) => Promise<{ readonly status: "stored"; readonly protectedPromptSnapshotId: string } | { readonly status: "failed" }>;
  readonly createId: (kind: "workout-run" | "input-revision") => string;
  readonly now: () => string;
  readonly modelConfigurationId: string;
  readonly policyRevision: string;
  readonly waitForReservation?: () => Promise<void>;
};

function validIdentity(input: SubmitWorkoutAdjustmentInput) {
  return input.coachId.trim().length > 0
    && input.memberId.trim().length > 0 && input.memberId.length <= 200
    && input.sessionAuthorizationId.trim().length > 0
    && input.predecessorRunId.trim().length > 0
    && input.predecessorWorkoutVersionId.trim().length > 0 && input.predecessorWorkoutVersionId.length <= 300
    && input.idempotencyKey.trim().length > 0 && input.idempotencyKey.length <= 200;
}

/** Creates an immutable successor run after re-authorizing the predecessor. */
export function createSubmitWorkoutAdjustment(dependencies: SubmitWorkoutAdjustmentDependencies) {
  return async (input: SubmitWorkoutAdjustmentInput): Promise<SubmitWorkoutAdjustmentResult> => {
    if (!validIdentity(input)) return { status: "invalid-request" };
    const validated = validateWorkoutAdjustment(input.adjustment);
    if (validated.status !== "valid") return { status: "invalid-request" };
    const predecessor = await authorizeWorkoutRunAccess({ repository: dependencies.repository, authorization: dependencies.authorization }, {
      runId: input.predecessorRunId,
      coachId: input.coachId,
      memberId: input.memberId,
      sessionAuthorizationId: input.sessionAuthorizationId,
    }, "adjustment");
    if (!predecessor) return { status: "not-authorized" };
    if (predecessor.state !== "completed") return { status: "stale-predecessor" };
    const predecessorWorkout = await dependencies.repository.getWorkout(predecessor.runId, predecessor.coachId, predecessor.memberId);
    if (!predecessorWorkout || predecessorWorkout.workoutVersionId !== input.predecessorWorkoutVersionId) return { status: "stale-predecessor" };

    const idempotencyKeyDigest = canonicalWorkoutDigest(input.idempotencyKey);
    const requestDigest = canonicalWorkoutDigest({
      action: "adjust-workout",
      predecessorRunId: predecessor.runId,
      predecessorWorkoutVersionId: predecessorWorkout.workoutVersionId,
      predecessorRequestDigest: predecessor.requestDigest,
      adjustment: validated.value,
      movementGraphRevisionId: predecessor.movementGraphRevisionId,
      memberContextRevisionId: predecessor.memberContextRevisionId,
      modelConfigurationId: dependencies.modelConfigurationId,
      policyRevision: dependencies.policyRevision,
    });
    const proposedRunId = asWorkoutRunId(dependencies.createId("workout-run"));
    const reserved = await reserveWorkoutRunCreation({
      repository: dependencies.repository,
      identity: {
        coachId: predecessor.coachId,
        memberId: predecessor.memberId,
        action: "adjust-workout",
        idempotencyKeyDigest,
        requestDigest,
      },
      proposedRunId,
      ownerId: proposedRunId,
      now: dependencies.now,
      ...(dependencies.waitForReservation ? { wait: dependencies.waitForReservation } : {}),
    });
    if (reserved.status === "replayed") return { status: "replayed", runId: reserved.run.runId };
    if (reserved.status === "idempotency-conflict") return { status: "idempotency-conflict" };
    if (reserved.status !== "reserved") return { status: "canonical-state-unavailable" };
    const reservation = reserved.reservation;
    const runId = reservation.runId;
    let grant;
    try {
      grant = await dependencies.authorization.createReference({
        coachId: predecessor.coachId,
        memberId: predecessor.memberId,
        runId,
        sessionAuthorizationId: input.sessionAuthorizationId,
        provisioningKey: `workout-adjustment:${runId}`,
        provisionedAt: reservation.createdAt,
      });
      if (grant.status !== "authorized") {
        await dependencies.repository.releaseCreation(reservation);
        return { status: "not-authorized" };
      }
      const protectedPrompt = await dependencies.protectPrompt({
        coachId: predecessor.coachId,
        memberId: predecessor.memberId,
        runId,
        prompt: JSON.stringify({ adjustment: validated.value }),
      });
      if (protectedPrompt.status !== "stored") {
        await dependencies.repository.releaseCreation(reservation);
        return { status: "canonical-state-unavailable" };
      }
      const createdAt = dependencies.now();
      const inputRevisionId = asWorkoutInputRevisionId(dependencies.createId("input-revision"));
      const run: WorkoutRun = {
        runId,
        coachId: predecessor.coachId,
        memberId: predecessor.memberId,
        authorizationReferenceId: grant.authorizationReferenceId,
        idempotencyKeyDigest,
        requestDigest,
        requestedDurationMinutes: validated.value.durationMinutes ?? predecessor.requestedDurationMinutes,
        modelConfigurationId: dependencies.modelConfigurationId,
        policyRevision: dependencies.policyRevision,
        movementGraphRevisionId: predecessor.movementGraphRevisionId,
        memberContextRevisionId: predecessor.memberContextRevisionId,
        state: "queued",
        inputRevisions: [{
          inputRevisionId,
          revision: 1,
          protectedPromptSnapshotId: protectedPrompt.protectedPromptSnapshotId,
          promptDigest: canonicalWorkoutDigest(validated.value.prompt ?? JSON.stringify(validated.value)),
          effectiveInputDigest: canonicalWorkoutDigest({ requestDigest, adjustment: validated.value }),
          createdAt,
        }],
        activeInputRevisionId: inputRevisionId,
        predecessorRunId: predecessor.runId,
        predecessorWorkoutVersionId: predecessorWorkout.workoutVersionId,
      };
      const result = await dependencies.repository.finalizeCreation(reservation, run);
      if (result.status === "created" || result.status === "replayed") return { status: result.status, runId: result.run.runId };
      if (result.status === "idempotency-conflict") return { status: "idempotency-conflict" };
      if (result.status === "stale-predecessor" || result.status === "invalid-predecessor") return { status: "stale-predecessor" };
      return { status: "canonical-state-unavailable" };
    } catch (error) {
      await dependencies.repository.releaseCreation(reservation);
      throw error;
    }
  };
}

