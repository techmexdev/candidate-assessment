import { asWorkoutInputRevisionId, asWorkoutRunId, type WorkoutRunId } from "../../domain/contracts/workout";
import type { WorkoutRun } from "../../domain/contracts/workout-run";
import { canonicalWorkoutDigest } from "../../graph/schema/workout-run-schema";
import type { WorkoutRunRepository } from "../ports/workout-run-repository";
import type { WorkerAuthorizationPort } from "../ports/worker-authorization";

export type RetryWorkoutRunResult =
  | { readonly status: "created" | "replayed"; readonly runId: WorkoutRunId }
  | { readonly status: "invalid-request" | "not-retryable" | "not-found" | "idempotency-conflict" };

export function createRetryWorkoutRun(dependencies: {
  readonly repository: WorkoutRunRepository;
  readonly authorization: WorkerAuthorizationPort;
  readonly createId: (kind: "workout-run" | "input-revision") => string;
  readonly now: () => string;
  readonly modelConfigurationId: string;
  readonly policyRevision: string;
}) {
  return async (input: {
    readonly runId: WorkoutRunId;
    readonly coachId: string;
    readonly memberId: string;
    readonly sessionAuthorizationId: string;
    readonly idempotencyKey: string;
  }): Promise<RetryWorkoutRunResult> => {
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200 || !input.sessionAuthorizationId.trim()) return { status: "invalid-request" };
    const source = await dependencies.repository.getRun(input.runId, input.coachId, input.memberId);
    if (!source) return { status: "not-found" };
    if (source.state !== "failed") return { status: "not-retryable" };
    const access = await dependencies.authorization.authorize({
      authorizationReferenceId: source.authorizationReferenceId,
      runId: source.runId,
      coachId: source.coachId,
      memberId: source.memberId,
      stage: "retry",
    });
    if (access.status !== "authorized") return { status: "not-found" };

    const runId = asWorkoutRunId(dependencies.createId("workout-run"));
    const grant = await dependencies.authorization.createReference({
      coachId: source.coachId,
      memberId: source.memberId,
      runId,
      sessionAuthorizationId: input.sessionAuthorizationId,
    });
    if (grant.status !== "authorized") return { status: "not-found" };
    const sourceInput = source.inputRevisions.find((revision) => revision.inputRevisionId === source.activeInputRevisionId);
    if (!sourceInput) return { status: "not-retryable" };
    const createdAt = dependencies.now();
    const inputRevisionId = asWorkoutInputRevisionId(dependencies.createId("input-revision"));
    const idempotencyKeyDigest = canonicalWorkoutDigest(input.idempotencyKey);
    const requestDigest = canonicalWorkoutDigest({
      retryOfRunId: source.runId,
      sourceRequestDigest: source.requestDigest,
      sourceEffectiveInputDigest: sourceInput.effectiveInputDigest,
      movementGraphRevisionId: source.movementGraphRevisionId,
      memberContextRevisionId: source.memberContextRevisionId,
      modelConfigurationId: dependencies.modelConfigurationId,
      policyRevision: dependencies.policyRevision,
    });
    const retry: WorkoutRun = {
      runId,
      coachId: source.coachId,
      memberId: source.memberId,
      authorizationReferenceId: grant.authorizationReferenceId,
      idempotencyKeyDigest,
      requestDigest,
      requestedDurationMinutes: source.requestedDurationMinutes,
      modelConfigurationId: dependencies.modelConfigurationId,
      policyRevision: dependencies.policyRevision,
      movementGraphRevisionId: source.movementGraphRevisionId,
      memberContextRevisionId: source.memberContextRevisionId,
      state: "queued",
      inputRevisions: [{
        inputRevisionId,
        revision: 1,
        protectedPromptSnapshotId: sourceInput.protectedPromptSnapshotId,
        promptDigest: sourceInput.promptDigest,
        effectiveInputDigest: sourceInput.effectiveInputDigest,
        createdAt,
      }],
      activeInputRevisionId: inputRevisionId,
      retryOfRunId: source.runId,
    };
    const result = await dependencies.repository.createRetry(source.runId, source.coachId, source.memberId, retry);
    if (result.status === "created" || result.status === "replayed") return { status: result.status, runId: result.run.runId };
    return { status: result.status === "missing" ? "not-found" : result.status };
  };
}
