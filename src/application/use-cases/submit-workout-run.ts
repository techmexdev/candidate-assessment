import { canonicalWorkoutDigest } from "../../graph/schema/workout-run-schema";
import { asWorkoutInputRevisionId, asWorkoutRunId, type WorkoutRunId } from "../../domain/contracts/workout";
import type { WorkoutRun } from "../../domain/contracts/workout-run";
import type { WorkerAuthorizationPort } from "../ports/worker-authorization";
import type { WorkoutRunRepository } from "../ports/workout-run-repository";

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
  }) => Promise<{ readonly status: "stored"; readonly protectedPromptSnapshotId: string } | { readonly status: "failed" }>;
  readonly createId: (kind: "workout-run" | "input-revision") => string;
  readonly now: () => string;
  readonly modelConfigurationId: string;
  readonly policyRevision: string;
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

    const runId = asWorkoutRunId(dependencies.createId("workout-run"));
    const grant = await dependencies.authorization.createReference({
      coachId: input.coachId,
      memberId: input.memberId,
      runId,
      sessionAuthorizationId: input.sessionAuthorizationId,
    });
    if (grant.status !== "authorized") return { status: "not-authorized" };
    const protectedPrompt = await dependencies.protectPrompt({
      coachId: input.coachId,
      memberId: input.memberId,
      runId,
      prompt: input.prompt,
    });
    if (protectedPrompt.status !== "stored") return { status: "canonical-state-unavailable" };

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
    const result = await dependencies.repository.createOrFind(run);
    return result.status === "idempotency-conflict"
      ? { status: "idempotency-conflict" }
      : { status: result.status, runId: result.run.runId };
  };
}
