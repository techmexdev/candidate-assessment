import type { Neo4jClient } from "./client";

export const WORKOUT_RUN_NEO4J_SCHEMA_QUERIES = Object.freeze([
  "CREATE CONSTRAINT workout_run_identity IF NOT EXISTS FOR (run:WorkoutRun) REQUIRE run.runId IS UNIQUE",
  "CREATE CONSTRAINT workout_run_idempotency IF NOT EXISTS FOR (run:WorkoutRun) REQUIRE (run.coachId, run.memberId, run.action, run.idempotencyKeyDigest) IS UNIQUE",
  "CREATE CONSTRAINT workout_run_creation_reservation IF NOT EXISTS FOR (reservation:WorkoutRunReservation) REQUIRE (reservation.coachId, reservation.memberId, reservation.action, reservation.idempotencyKeyDigest) IS UNIQUE",
  "CREATE CONSTRAINT workout_run_input_identity IF NOT EXISTS FOR (input:WorkoutRunInputRevision) REQUIRE input.inputRevisionId IS UNIQUE",
  "CREATE CONSTRAINT workout_run_input_revision IF NOT EXISTS FOR (input:WorkoutRunInputRevision) REQUIRE (input.runId, input.revision) IS UNIQUE",
  "CREATE CONSTRAINT workout_run_event_identity IF NOT EXISTS FOR (event:WorkoutRunEvent) REQUIRE (event.runId, event.sequence) IS UNIQUE",
  "CREATE CONSTRAINT workout_version_identity IF NOT EXISTS FOR (workout:WorkoutVersion) REQUIRE workout.workoutVersionId IS UNIQUE",
  "CREATE CONSTRAINT workout_decision_identity IF NOT EXISTS FOR (decision:WorkoutExerciseDecision) REQUIRE (decision.runId, decision.decisionId) IS UNIQUE",
  "CREATE CONSTRAINT workout_provenance_entity_identity IF NOT EXISTS FOR (entity:WorkoutProvenanceEntity) REQUIRE (entity.runId, entity.entityId) IS UNIQUE",
  "CREATE INDEX workout_run_state_lease IF NOT EXISTS FOR (run:WorkoutRun) ON (run.state, run.claimExpiresAt)",
  "CREATE INDEX workout_event_replay IF NOT EXISTS FOR (event:WorkoutRunEvent) ON (event.runId, event.sequence)",
]);

export async function setupWorkoutRunNeo4jSchema(client: Neo4jClient): Promise<void> {
  await client.executeWrite(async (transaction) => {
    for (const query of WORKOUT_RUN_NEO4J_SCHEMA_QUERIES) await transaction.run(query);
  });
}
