import type { WorkoutProvenanceBundle } from "../../domain/contracts/workout-provenance";
import type { ImmutableWorkoutVersion, WorkoutRunId } from "../../domain/contracts/workout";
import type { WorkoutRunEvent, WorkoutRunRepository } from "../ports/workout-run-repository";
import type { WorkerAuthorizationPort } from "../ports/worker-authorization";
import { validateWorkoutProvenance } from "../../domain/contracts/workout-provenance";
import { canonicalWorkoutProvenanceDigest, WORKOUT_RUN_LIMITS } from "../../graph/schema/workout-run-schema";

export type WorkoutRunResource = {
  readonly runId: WorkoutRunId;
  readonly state: "queued" | "running" | "awaiting-clarification" | "failed" | "canceled" | "completed";
  readonly requestedDurationMinutes: number;
  readonly movementGraphRevisionId: string;
  readonly memberContextRevisionId: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly failure?: { readonly kind: string; readonly stage: string };
  readonly workout?: ImmutableWorkoutVersion;
  readonly provenance?: WorkoutProvenanceBundle;
};

export type RetrieveWorkoutRunResult =
  | { readonly status: "ready"; readonly resource: WorkoutRunResource }
  | { readonly status: "not-found" | "integrity-failure" };

type AccessInput = { readonly runId: WorkoutRunId; readonly coachId: string; readonly memberId: string };

async function authorizeRun(
  repository: WorkoutRunRepository,
  authorization: WorkerAuthorizationPort,
  input: AccessInput,
  stage: "read" | "replay",
) {
  const run = await repository.getRun(input.runId, input.coachId, input.memberId);
  if (!run) return undefined;
  const access = await authorization.authorize({
    authorizationReferenceId: run.authorizationReferenceId,
    runId: run.runId,
    coachId: run.coachId,
    memberId: run.memberId,
    stage,
  });
  return access.status === "authorized" ? run : undefined;
}

export function createRetrieveWorkoutRun(dependencies: {
  readonly repository: WorkoutRunRepository;
  readonly authorization: WorkerAuthorizationPort;
  readonly verifyHistoricalTrace?: (input: {
    readonly workout: ImmutableWorkoutVersion;
    readonly provenance: WorkoutProvenanceBundle;
  }) => boolean | Promise<boolean>;
}) {
  return async (input: AccessInput): Promise<RetrieveWorkoutRunResult> => {
    const run = await authorizeRun(dependencies.repository, dependencies.authorization, input, "read");
    if (!run) return { status: "not-found" };
    const [workout, provenance] = run.state === "completed"
      ? await Promise.all([
        dependencies.repository.getWorkout(run.runId, run.coachId, run.memberId),
        dependencies.repository.getProvenance(run.runId, run.coachId, run.memberId),
      ])
      : [undefined, undefined];
    if (run.state === "completed") {
      const valid = workout && provenance
        && workout.workout.runId === run.runId
        && workout.workout.movementGraphRevisionId === run.movementGraphRevisionId
        && workout.workout.memberContextRevisionId === run.memberContextRevisionId
        && provenance.movementGraphRevisionId === run.movementGraphRevisionId
        && provenance.memberContextRevisionId === run.memberContextRevisionId
        && validateWorkoutProvenance(provenance).status === "valid"
        && canonicalWorkoutProvenanceDigest(provenance) === provenance.digest
        && (dependencies.verifyHistoricalTrace ? await dependencies.verifyHistoricalTrace({ workout, provenance }) : true);
      if (!valid) return { status: "integrity-failure" };
    }
    return {
      status: "ready",
      resource: {
        runId: run.runId,
        state: run.state,
        requestedDurationMinutes: run.requestedDurationMinutes,
        movementGraphRevisionId: run.movementGraphRevisionId,
        memberContextRevisionId: run.memberContextRevisionId,
        ...(run.startedAt ? { startedAt: run.startedAt } : {}),
        ...(run.endedAt ? { endedAt: run.endedAt } : {}),
        ...(run.failure ? { failure: { kind: run.failure.kind, stage: run.failure.stage } } : {}),
        ...(workout ? { workout } : {}),
        ...(provenance ? { provenance } : {}),
      },
    };
  };
}

const allowedDataKeys: Readonly<Record<WorkoutRunEvent["kind"], readonly string[]>> = {
  queued: [],
  claimed: ["generation"],
  heartbeat: ["generation"],
  stage: ["stage", "digest", "generation", "candidateCount"],
  "awaiting-clarification": ["candidateCount"],
  "clarification-answered": ["revision"],
  failed: ["kind", "stage"],
  canceled: [],
  completed: ["workoutVersionId"],
};

function projectEvent(event: WorkoutRunEvent): WorkoutRunEvent {
  const allowed = new Set(allowedDataKeys[event.kind]);
  return {
    eventId: event.eventId,
    schemaVersion: event.schemaVersion,
    runId: event.runId,
    sequence: event.sequence,
    kind: event.kind,
    occurredAt: event.occurredAt,
    safeData: Object.fromEntries(Object.entries(event.safeData).filter(([key]) => allowed.has(key))),
  };
}

export type ReplayWorkoutRunEventsResult =
  | {
      readonly status: "ready";
      readonly events: readonly { readonly event: WorkoutRunEvent; readonly cursor: string }[];
      readonly nextCursor: string;
      readonly highWaterSequence: number;
    }
  | { readonly status: "resync_required"; readonly snapshotUrl: string }
  | { readonly status: "not-found" };

export function createReplayWorkoutRunEvents(dependencies: {
  readonly repository: WorkoutRunRepository;
  readonly authorization: WorkerAuthorizationPort;
}) {
  return async (input: AccessInput & { readonly cursor?: string; readonly limit?: number }): Promise<ReplayWorkoutRunEventsResult> => {
    const run = await authorizeRun(dependencies.repository, dependencies.authorization, input, "replay");
    if (!run) return { status: "not-found" };
    const limit = input.limit ?? WORKOUT_RUN_LIMITS.maximumEventPageSize;
    if (!Number.isInteger(limit) || limit < 1 || limit > WORKOUT_RUN_LIMITS.maximumEventPageSize) return { status: "not-found" };
    const events: { event: WorkoutRunEvent; cursor: string }[] = [];
    let cursor = input.cursor;
    let highWaterSequence = 0;
    for (let index = 0; index < limit; index += 1) {
      const page = await dependencies.repository.readEvents(run.runId, run.coachId, run.memberId, { ...(cursor ? { cursor } : {}), limit: 1 });
      if (page.status !== "ready") return page;
      highWaterSequence = page.highWaterSequence;
      cursor = page.nextCursor;
      const event = page.events[0];
      if (!event) break;
      events.push({ event: projectEvent(event), cursor });
    }
    return { status: "ready", events, nextCursor: cursor ?? "", highWaterSequence };
  };
}
