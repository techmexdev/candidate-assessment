import { asWorkoutInputRevisionId, type WorkoutRunId } from "../../domain/contracts/workout";
import { canonicalJson, sha256 } from "../../graph/revisions/movement-graph";
import type { WorkoutRunRepository } from "../ports/workout-run-repository";
import type { WorkerAuthorizationPort } from "../ports/worker-authorization";

export type AnswerWorkoutClarificationResult =
  | { readonly status: "requeued"; readonly revision: number }
  | { readonly status: "invalid-request" | "invalid-state" | "not-found" | "unavailable" };

const digest = (value: unknown) => `sha256:${sha256(canonicalJson(value))}`;

export function createAnswerWorkoutClarification(dependencies: {
  readonly repository: WorkoutRunRepository;
  readonly authorization: WorkerAuthorizationPort;
  readonly protectPrompt: (input: {
    readonly coachId: string;
    readonly memberId: string;
    readonly runId: WorkoutRunId;
    readonly prompt: string;
  }) => Promise<{ readonly status: "stored"; readonly protectedPromptSnapshotId: string } | { readonly status: "failed" }>;
  readonly createId: (kind: "input-revision") => string;
  readonly now: () => string;
}) {
  return async (input: {
    readonly runId: WorkoutRunId;
    readonly coachId: string;
    readonly memberId: string;
    readonly sessionAuthorizationId: string;
    readonly answer: string;
  }): Promise<AnswerWorkoutClarificationResult> => {
    const answer = input.answer.trim();
    if (!answer || answer.length > 1_000 || !input.sessionAuthorizationId.trim()) return { status: "invalid-request" };
    const run = await dependencies.repository.getRun(input.runId, input.coachId, input.memberId);
    if (!run) return { status: "not-found" };
    if (run.state !== "awaiting-clarification") return { status: "invalid-state" };
    const authorization = await dependencies.authorization.authorize({
      authorizationReferenceId: run.authorizationReferenceId,
      runId: run.runId,
      coachId: run.coachId,
      memberId: run.memberId,
      stage: "clarification",
    });
    if (authorization.status !== "authorized") return { status: "not-found" };
    const protectedInput = await dependencies.protectPrompt({
      coachId: run.coachId,
      memberId: run.memberId,
      runId: run.runId,
      prompt: answer,
    });
    if (protectedInput.status !== "stored") return { status: "unavailable" };
    const previous = run.inputRevisions.at(-1);
    if (!previous) return { status: "invalid-state" };
    const revision = previous.revision + 1;
    const promptDigest = digest(answer);
    const mutation = await dependencies.repository.answerClarification(run.runId, run.coachId, run.memberId, {
      inputRevisionId: asWorkoutInputRevisionId(dependencies.createId("input-revision")),
      revision,
      protectedPromptSnapshotId: protectedInput.protectedPromptSnapshotId,
      promptDigest,
      effectiveInputDigest: digest({ prior: previous.effectiveInputDigest, promptDigest, revision }),
      createdAt: dependencies.now(),
    });
    if (mutation.status === "updated") return { status: "requeued", revision };
    return { status: mutation.status === "missing" ? "not-found" : "invalid-state" };
  };
}
