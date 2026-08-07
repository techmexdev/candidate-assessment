import { asWorkoutInputRevisionId, type WorkoutRunId } from "../../domain/contracts/workout";
import type { WorkoutClarificationDescriptor } from "../../domain/contracts/workout-run";
import { canonicalWorkoutDigest } from "../../graph/schema/workout-run-schema";
import type { WorkoutRunRepository } from "../ports/workout-run-repository";
import type { WorkerAuthorizationPort } from "../ports/worker-authorization";
import { authorizeWorkoutRunAccess } from "./authorize-workout-run-access";

export type AnswerWorkoutClarificationResult =
  | { readonly status: "requeued"; readonly revision: number }
  | { readonly status: "invalid-request" | "invalid-state" | "not-found" | "unavailable" };

type ClarificationAnswers = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function typedClarificationPrompt(descriptor: WorkoutClarificationDescriptor, answers: ClarificationAnswers): string | undefined {
  const fields = descriptor.fields;
  const fieldIds = new Set(fields.map((field) => field.id));
  const answerIds = Object.keys(answers);
  if (answerIds.length !== fields.length || answerIds.some((id) => !fieldIds.has(id))) return undefined;
  const byEvidence = new Map<string, Record<string, string>>();
  for (const field of fields) {
    const value = answers[field.id];
    if (typeof value !== "string" || !value.trim() || value.length > 100
      || !field.allowedValues.some((option) => option.value === value)) return undefined;
    const existing = byEvidence.get(field.evidenceReference) ?? {};
    existing[field.key] = value;
    byEvidence.set(field.evidenceReference, existing);
  }
  return JSON.stringify({ clarification: Object.fromEntries(byEvidence) });
}

export function createAnswerWorkoutClarification(dependencies: {
  readonly repository: WorkoutRunRepository;
  readonly authorization: WorkerAuthorizationPort;
  readonly protectPrompt: (input: {
    readonly coachId: string;
    readonly memberId: string;
    readonly runId: WorkoutRunId;
    readonly prompt: string;
    readonly previousProtectedPromptSnapshotId: string;
  }) => Promise<{ readonly status: "stored"; readonly protectedPromptSnapshotId: string } | { readonly status: "failed" }>;
  readonly createId: (kind: "input-revision") => string;
  readonly now: () => string;
}) {
  return async (input: {
    readonly runId: WorkoutRunId;
    readonly coachId: string;
    readonly memberId: string;
    readonly sessionAuthorizationId: string;
    readonly answers?: ClarificationAnswers;
    /** Legacy compatibility for runs created before typed descriptors were persisted. */
    readonly answer?: string;
  }): Promise<AnswerWorkoutClarificationResult> => {
    if (!input.sessionAuthorizationId.trim()) return { status: "invalid-request" };
    const run = await authorizeWorkoutRunAccess(dependencies, input, "clarification");
    if (!run) return { status: "not-found" };
    if (run.state !== "awaiting-clarification") return { status: "invalid-state" };
    const previous = run.inputRevisions.find((revision) => revision.inputRevisionId === run.activeInputRevisionId);
    if (!previous) return { status: "invalid-state" };
    const prompt = run.clarification
      ? (input.answers && isObject(input.answers) ? typedClarificationPrompt(run.clarification, input.answers) : undefined)
      : (typeof input.answer === "string" && input.answer.trim().length > 0 && input.answer.trim().length <= 1_000 ? input.answer.trim() : undefined);
    if (!prompt) return { status: "invalid-request" };
    const protectedInput = await dependencies.protectPrompt({
      coachId: run.coachId,
      memberId: run.memberId,
      runId: run.runId,
      prompt,
      previousProtectedPromptSnapshotId: previous.protectedPromptSnapshotId,
    });
    if (protectedInput.status !== "stored") return { status: "unavailable" };
    const revision = previous.revision + 1;
    const promptDigest = canonicalWorkoutDigest(prompt);
    const mutation = await dependencies.repository.answerClarification(run.runId, run.coachId, run.memberId, {
      inputRevisionId: asWorkoutInputRevisionId(dependencies.createId("input-revision")),
      revision,
      protectedPromptSnapshotId: protectedInput.protectedPromptSnapshotId,
      promptDigest,
      effectiveInputDigest: canonicalWorkoutDigest({ prior: previous.effectiveInputDigest, promptDigest, revision }),
      createdAt: dependencies.now(),
    });
    if (mutation.status === "updated") return { status: "requeued", revision };
    return { status: mutation.status === "missing" ? "not-found" : "invalid-state" };
  };
}
