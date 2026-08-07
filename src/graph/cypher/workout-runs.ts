/** Static, parameterized Decision and Run queries. No caller data is interpolated into query text. */
export const WORKOUT_RUN_CYPHER = Object.freeze({
  findByIdentity: `
    MATCH (run:WorkoutRun {
      coachId: $coachId, memberId: $memberId, action: $action,
      idempotencyKeyDigest: $idempotencyKeyDigest
    })
    RETURN run
    LIMIT 1
  `,
  create: `
    CREATE (run:WorkoutRun {
      runId: $runId, coachId: $coachId, memberId: $memberId,
      action: $action, authorizationReferenceId: $authorizationReferenceId,
      idempotencyKeyDigest: $idempotencyKeyDigest, requestDigest: $requestDigest,
      state: 'queued', claimGeneration: 0, lockVersion: 0, nextEventSequence: 2,
      payload: $payload
    })
    CREATE (input:WorkoutRunInputRevision {
      inputRevisionId: $inputRevisionId, runId: $runId, revision: 1,
      payload: $inputPayload
    })
    CREATE (run)-[:HAS_INPUT_REVISION]->(input)
    CREATE (event:WorkoutRunEvent {
      runId: $runId, sequence: 1, eventId: $queuedEventId,
      schemaVersion: $eventSchemaVersion, kind: 'queued', occurredAt: $queuedAt,
      safeData: '{}'
    })
    CREATE (run)-[:HAS_EVENT]->(event)
    RETURN run
  `,
  read: `
    MATCH (run:WorkoutRun {runId: $runId})
    RETURN run
    LIMIT 1
  `,
  readInputs: `
    MATCH (:WorkoutRun {runId: $runId})-[:HAS_INPUT_REVISION]->(input:WorkoutRunInputRevision)
    RETURN input.payload AS payload
    ORDER BY input.revision
  `,
  claim: `
    MATCH (run:WorkoutRun {runId: $runId})
    SET run.lockVersion = coalesce(run.lockVersion, 0) + 1
    WITH run
    WHERE run.state = 'queued'
      OR (run.state = 'running' AND run.claimExpiresAt <= $now)
    SET run.state = 'running',
      run.claimGeneration = coalesce(run.claimGeneration, 0) + 1,
      run.claimWorkerId = $workerId, run.claimedAt = $now,
      run.heartbeatAt = $now, run.claimExpiresAt = $expiresAt,
      run.startedAt = coalesce(run.startedAt, $now)
    RETURN run
  `,
  heartbeat: `
    MATCH (run:WorkoutRun {runId: $runId})
    SET run.lockVersion = coalesce(run.lockVersion, 0) + 1
    WITH run
    WHERE run.state = 'running' AND run.claimGeneration = $generation AND run.claimWorkerId = $workerId
    SET run.heartbeatAt = $now, run.claimExpiresAt = $expiresAt
    RETURN run
  `,
  saveConstraintSnapshot: `
    MATCH (run:WorkoutRun {runId: $runId})
    SET run.lockVersion = coalesce(run.lockVersion, 0) + 1
    WITH run
    WHERE run.state = 'running' AND run.claimGeneration = $generation AND run.claimWorkerId = $workerId
    SET run.constraintSnapshot = $snapshot
    RETURN run
  `,
  allocateEvent: `
    MATCH (run:WorkoutRun {runId: $runId})
    SET run.lockVersion = coalesce(run.lockVersion, 0) + 1
    WITH run, run.nextEventSequence AS sequence
    WHERE run.state = 'running' AND run.claimGeneration = $generation AND run.claimWorkerId = $workerId
    SET run.nextEventSequence = sequence + 1
    CREATE (event:WorkoutRunEvent {
      runId: $runId, sequence: sequence, eventId: $eventIdPrefix + toString(sequence),
      schemaVersion: $eventSchemaVersion, kind: $kind, occurredAt: $occurredAt,
      safeData: $safeData
    })
    CREATE (run)-[:HAS_EVENT]->(event)
    RETURN run, sequence
  `,
  appendSystemEvent: `
    MATCH (run:WorkoutRun {runId: $runId})
    SET run.lockVersion = coalesce(run.lockVersion, 0) + 1
    WITH run, run.nextEventSequence AS sequence
    SET run.nextEventSequence = sequence + 1
    CREATE (event:WorkoutRunEvent {
      runId: $runId, sequence: sequence, eventId: $eventIdPrefix + toString(sequence),
      schemaVersion: $eventSchemaVersion, kind: $kind, occurredAt: $occurredAt,
      safeData: $safeData
    })
    CREATE (run)-[:HAS_EVENT]->(event)
    RETURN run, sequence
  `,
  awaitClarification: `
    MATCH (run:WorkoutRun {runId: $runId})
    SET run.lockVersion = coalesce(run.lockVersion, 0) + 1
    WITH run
    WHERE run.state = 'running' AND run.claimGeneration = $generation AND run.claimWorkerId = $workerId
    SET run.state = 'awaiting-clarification', run.claimWorkerId = null,
      run.claimedAt = null, run.heartbeatAt = null, run.claimExpiresAt = null,
      run.clarificationCandidateIds = $candidateConceptIds
    RETURN run
  `,
  answerClarification: `
    MATCH (run:WorkoutRun {runId: $runId})
    SET run.lockVersion = coalesce(run.lockVersion, 0) + 1
    WITH run
    WHERE run.coachId = $coachId AND run.memberId = $memberId AND run.state = 'awaiting-clarification'
      AND NOT EXISTS {
      MATCH (run)-[:HAS_INPUT_REVISION]->(existing:WorkoutRunInputRevision)
      WHERE existing.inputRevisionId = $inputRevisionId OR existing.revision >= $revision
    }
    CREATE (input:WorkoutRunInputRevision {
      inputRevisionId: $inputRevisionId, runId: $runId,
      revision: $revision, payload: $inputPayload
    })
    CREATE (run)-[:HAS_INPUT_REVISION]->(input)
    SET run.state = 'queued', run.activeInputRevisionId = $inputRevisionId,
      run.clarificationCandidateIds = null, run.failure = null
    RETURN run
  `,
  fail: `
    MATCH (run:WorkoutRun {runId: $runId})
    SET run.lockVersion = coalesce(run.lockVersion, 0) + 1
    WITH run
    WHERE run.state = 'running' AND run.claimGeneration = $generation AND run.claimWorkerId = $workerId
    SET run.state = 'failed', run.failure = $failure, run.endedAt = $endedAt,
      run.claimWorkerId = null, run.claimedAt = null,
      run.heartbeatAt = null, run.claimExpiresAt = null
    RETURN run
  `,
  cancel: `
    MATCH (run:WorkoutRun {runId: $runId})
    SET run.lockVersion = coalesce(run.lockVersion, 0) + 1
    WITH run
    WHERE run.coachId = $coachId AND run.memberId = $memberId
      AND NOT run.state IN ['failed', 'canceled', 'completed']
    SET run.state = 'canceled', run.endedAt = $endedAt,
      run.claimWorkerId = null, run.claimedAt = null,
      run.heartbeatAt = null, run.claimExpiresAt = null
    RETURN run
  `,
  complete: `
    MATCH (run:WorkoutRun {runId: $runId})
    SET run.lockVersion = coalesce(run.lockVersion, 0) + 1
    WITH run
    WHERE run.state = 'running' AND run.claimGeneration = $generation
      AND run.claimWorkerId = $workerId
      AND run.authorizationReferenceId = $authorizationReferenceId
      AND run.requestDigest = $requestDigest
    CREATE (workout:WorkoutVersion {
      workoutVersionId: $workoutVersionId, runId: $runId,
      version: $workoutVersion, createdAt: $endedAt, payload: $workoutPayload
    })
    CREATE (validation:WorkoutValidationReceipt {runId: $runId, payload: $validationReceipt})
    CREATE (run)-[:HAS_VALIDATION_RECEIPT]->(validation)
    CREATE (run)-[:GENERATED]->(workout)
    CREATE (workout)-[:WAS_GENERATED_BY]->(run)
    WITH run, workout
    UNWIND $sourceEntities AS entityRow
    CREATE (entity:WorkoutProvenanceEntity {
      runId: $runId, entityId: entityRow.entityId, kind: entityRow.kind
    })
    FOREACH (_ IN CASE WHEN entityRow.kind = 'model-proposal' THEN [1] ELSE [] END |
      SET entity:WorkoutModelProposal
    )
    CREATE (run)-[:USED]->(entity)
    FOREACH (_ IN CASE WHEN entityRow.kind IN ['candidate-set', 'model-proposal'] THEN [1] ELSE [] END |
      CREATE (workout)-[:WAS_DERIVED_FROM]->(entity)
    )
    WITH DISTINCT run, workout, $decisions AS decisions
    UNWIND decisions AS decisionRow
    CREATE (decision:WorkoutExerciseDecision {
      decisionId: decisionRow.decisionId, runId: $runId,
      kind: decisionRow.kind, exerciseConceptId: decisionRow.exerciseConceptId,
      payload: decisionRow.payload
    })
    CREATE (run)-[:RECORDED_DECISION]->(decision)
    WITH DISTINCT run, workout
    SET run.state = 'completed', run.endedAt = $endedAt,
      run.workoutVersionId = $workoutVersionId,
      run.provenance = $provenance, run.validationReceipt = $validationReceipt,
      run.claimWorkerId = null, run.claimedAt = null,
      run.heartbeatAt = null, run.claimExpiresAt = null
    RETURN run, workout
  `,
  readWorkout: `
    MATCH (:WorkoutRun {runId: $runId, coachId: $coachId, memberId: $memberId})-[:GENERATED]->(workout:WorkoutVersion)
    RETURN workout.payload AS payload
    LIMIT 1
  `,
  readProvenance: `
    MATCH (run:WorkoutRun {runId: $runId, coachId: $coachId, memberId: $memberId})
    WHERE run.state = 'completed'
    RETURN run.provenance AS payload
    LIMIT 1
  `,
  readEvents: `
    MATCH (:WorkoutRun {runId: $runId, coachId: $coachId, memberId: $memberId})-[:HAS_EVENT]->(event:WorkoutRunEvent)
    WHERE event.sequence >= $nextSequence
    RETURN event
    ORDER BY event.sequence
    LIMIT $limit
  `,
  eventBounds: `
    MATCH (run:WorkoutRun {runId: $runId, coachId: $coachId, memberId: $memberId})
    OPTIONAL MATCH (run)-[:HAS_EVENT]->(event:WorkoutRunEvent)
    RETURN min(event.sequence) AS minimumSequence,
      max(event.sequence) AS highWaterSequence,
      run.nextEventSequence AS nextEventSequence
  `,
});
