import type { WorkoutRunId } from "../../domain/contracts/workout";
import type {
  ReserveWorkoutRunCreationResult,
  WorkoutRunCreationReservation,
  WorkoutRunRepository,
} from "../ports/workout-run-repository";

const DEFAULT_RESERVATION_LEASE_MS = 30_000;
const DEFAULT_MAXIMUM_WAIT_ATTEMPTS = 400;

export type WorkoutRunCreationIdentity = Pick<
  WorkoutRunCreationReservation,
  "coachId" | "memberId" | "action" | "idempotencyKeyDigest" | "requestDigest"
>;

export async function reserveWorkoutRunCreation(input: {
  readonly repository: WorkoutRunRepository;
  readonly identity: WorkoutRunCreationIdentity;
  readonly proposedRunId: WorkoutRunId;
  readonly ownerId: string;
  readonly now: () => string;
  readonly wait?: () => Promise<void>;
  readonly maximumWaitAttempts?: number;
}): Promise<ReserveWorkoutRunCreationResult> {
  const wait = input.wait ?? (() => new Promise((resolve) => setTimeout(resolve, 5)));
  const maximumWaitAttempts = input.maximumWaitAttempts ?? DEFAULT_MAXIMUM_WAIT_ATTEMPTS;
  for (let attempt = 0; attempt <= maximumWaitAttempts; attempt += 1) {
    const createdAt = input.now();
    const expiresAt = new Date(Date.parse(createdAt) + DEFAULT_RESERVATION_LEASE_MS).toISOString();
    const result = await input.repository.reserveCreation({
      ...input.identity,
      runId: input.proposedRunId,
      ownerId: input.ownerId,
      createdAt,
      expiresAt,
    });
    if (result.status !== "pending") return result;
    if (attempt < maximumWaitAttempts) await wait();
  }
  return { status: "pending" };
}
