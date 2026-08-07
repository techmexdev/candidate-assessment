/** Static, parameterized Decision and Run queries. No caller data is interpolated into query text. */
export const WORKOUT_RUN_CYPHER = Object.freeze({
  reserveCreation: `
    MERGE (reservation:WorkoutRunReservation {
      coachId: $coachId, memberId: $memberId, action: $action,
      idempotencyKeyDigest: $idempotencyKeyDigest
    })
    ON CREATE SET reservation.runId = $runId,
      reservation.requestDigest = $requestDigest,
      reservation.reservationOwnerId = $ownerId,
      reservation.reservationCreatedAt = $createdAt,
      reservation.reservationExpiresAt = $expiresAt
    WITH reservation
    OPTIONAL MATCH (existing:WorkoutRun {
      coachId: $coachId, memberId: $memberId, action: $action,
      idempotencyKeyDigest: $idempotencyKeyDigest
    })
    WITH reservation, existing,
      existing IS NULL
        AND reservation.requestDigest = $requestDigest
        AND (reservation.reservationOwnerId IS NULL
          OR reservation.reservationOwnerId = $ownerId
          OR reservation.reservationExpiresAt IS NULL
          OR datetime(reservation.reservationExpiresAt) <= datetime()) AS canReserve
    FOREACH (_ IN CASE WHEN canReserve THEN [1] ELSE [] END |
      SET reservation.reservationOwnerId = $ownerId,
        reservation.reservationExpiresAt = $expiresAt
    )
    RETURN CASE
      WHEN existing IS NOT NULL AND existing.requestDigest = $requestDigest THEN 'replayed'
      WHEN existing IS NOT NULL OR reservation.requestDigest <> $requestDigest THEN 'idempotency-conflict'
      WHEN canReserve THEN 'reserved'
      ELSE 'pending'
    END AS status,
      reservation.runId AS runId,
      reservation.requestDigest AS requestDigest,
      reservation.reservationCreatedAt AS createdAt,
      reservation.reservationExpiresAt AS expiresAt,
      existing
  `,
  finalizeCreation: `
    MATCH (reservation:WorkoutRunReservation {
      coachId: $coachId, memberId: $memberId, action: $action,
      idempotencyKeyDigest: $idempotencyKeyDigest
    })
    WHERE NOT reservation:WorkoutRun
      AND reservation.runId = $runId
      AND reservation.requestDigest = $requestDigest
      AND reservation.reservationOwnerId = $ownerId
      AND ($retryOfRunId IS NULL OR EXISTS {
        MATCH (source:WorkoutRun {runId: $retryOfRunId, coachId: $coachId, memberId: $memberId, state: 'failed'})
      })
    SET reservation:WorkoutRun,
      reservation.authorizationReferenceId = $authorizationReferenceId,
      reservation.state = 'queued', reservation.claimGeneration = 0,
      reservation.lockVersion = 0, reservation.nextEventSequence = 2,
      reservation.payload = $payload,
      reservation.reservationOwnerId = null,
      reservation.reservationExpiresAt = null
    CREATE (input:WorkoutRunInputRevision {
      inputRevisionId: $inputRevisionId, runId: $runId, revision: 1,
      payload: $inputPayload
    })
    CREATE (reservation)-[:HAS_INPUT_REVISION]->(input)
    CREATE (event:WorkoutRunEvent {
      runId: $runId, sequence: 1, eventId: $queuedEventId,
      schemaVersion: $eventSchemaVersion, kind: 'queued', occurredAt: $queuedAt,
      safeData: '{}'
    })
    CREATE (reservation)-[:HAS_EVENT]->(event)
    RETURN reservation AS run
  `,
  releaseCreation: `
    MATCH (reservation:WorkoutRunReservation {
      coachId: $coachId, memberId: $memberId, action: $action,
      idempotencyKeyDigest: $idempotencyKeyDigest, runId: $runId,
      requestDigest: $requestDigest, reservationOwnerId: $ownerId
    })
    WHERE NOT reservation:WorkoutRun
    SET reservation.reservationOwnerId = null,
      reservation.reservationExpiresAt = null
    RETURN reservation
  `,
  findByIdentity: `
    MATCH (run:WorkoutRun {
      coachId: $coachId, memberId: $memberId, action: $action,
      idempotencyKeyDigest: $idempotencyKeyDigest
    })
    RETURN run
    LIMIT 1
  `,
  create: `
    CREATE (run:WorkoutRun:WorkoutRunReservation {
      runId: $runId, coachId: $coachId, memberId: $memberId,
      action: $action, authorizationReferenceId: $authorizationReferenceId,
      idempotencyKeyDigest: $idempotencyKeyDigest, requestDigest: $requestDigest,
      state: 'queued', claimGeneration: 0, lockVersion: 0, nextEventSequence: 2,
      payload: $payload, reservationCreatedAt: $queuedAt
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
      run.revisionSeals = null, run.safetyEnvelope = null, run.modelProposal = null,
      run.startedAt = coalesce(run.startedAt, $now)
    RETURN run
  `,
  heartbeat: `
    MATCH (run:WorkoutRun {runId: $runId})
    SET run.lockVersion = coalesce(run.lockVersion, 0) + 1
    WITH run
    WHERE run.state = 'running' AND run.claimGeneration = $generation AND run.claimWorkerId = $workerId
      AND datetime(run.claimExpiresAt) > datetime()
    SET run.heartbeatAt = $now, run.claimExpiresAt = $expiresAt
    RETURN run
  `,
  saveConstraintSnapshot: `
    MATCH (run:WorkoutRun {runId: $runId})
    SET run.lockVersion = coalesce(run.lockVersion, 0) + 1
    WITH run
    WHERE run.state = 'running' AND run.claimGeneration = $generation AND run.claimWorkerId = $workerId
      AND datetime(run.claimExpiresAt) > datetime()
    SET run.constraintSnapshot = $snapshot
    RETURN run
  `,
  saveRevisionSeals: `
    MATCH (run:WorkoutRun {runId: $runId})
    SET run.lockVersion = coalesce(run.lockVersion, 0) + 1
    WITH run
    WHERE run.state = 'running' AND run.claimGeneration = $generation AND run.claimWorkerId = $workerId
      AND datetime(run.claimExpiresAt) > datetime()
      AND (run.revisionSeals IS NULL OR run.revisionSeals = $artifact)
    SET run.revisionSeals = $artifact
    RETURN run
  `,
  saveSafetyEnvelope: `
    MATCH (run:WorkoutRun {runId: $runId})
    SET run.lockVersion = coalesce(run.lockVersion, 0) + 1
    WITH run
    WHERE run.state = 'running' AND run.claimGeneration = $generation AND run.claimWorkerId = $workerId
      AND datetime(run.claimExpiresAt) > datetime()
      AND (run.safetyEnvelope IS NULL OR run.safetyEnvelope = $artifact)
    SET run.safetyEnvelope = $artifact
    RETURN run
  `,
  saveModelProposal: `
    MATCH (run:WorkoutRun {runId: $runId})
    SET run.lockVersion = coalesce(run.lockVersion, 0) + 1
    WITH run
    WHERE run.state = 'running' AND run.claimGeneration = $generation AND run.claimWorkerId = $workerId
      AND datetime(run.claimExpiresAt) > datetime()
      AND (run.modelProposal IS NULL OR run.modelProposal = $artifact)
    SET run.modelProposal = $artifact
    RETURN run
  `,
  readCompletionArtifacts: `
    MATCH (run:WorkoutRun {runId: $runId})
    RETURN run.revisionSeals AS revisionSeals,
      run.safetyEnvelope AS safetyEnvelope,
      run.modelProposal AS modelProposal
    LIMIT 1
  `,
  readAuthorizedCompletionProjection: `
    MATCH (run:WorkoutRun {runId: $runId, coachId: $coachId, memberId: $memberId, state: 'completed'})
    RETURN run.revisionSeals AS revisionSeals,
      run.safetyEnvelope AS safetyEnvelope,
      run.modelProposal AS modelProposal,
      run.validationReceipt AS validationReceipt
    LIMIT 1
  `,
  allocateEvent: `
    MATCH (run:WorkoutRun {runId: $runId})
    SET run.lockVersion = coalesce(run.lockVersion, 0) + 1
    WITH run, run.nextEventSequence AS sequence
    WHERE run.state = 'running' AND run.claimGeneration = $generation AND run.claimWorkerId = $workerId
      AND datetime(run.claimExpiresAt) > datetime()
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
      AND datetime(run.claimExpiresAt) > datetime()
    SET run.state = 'awaiting-clarification', run.claimWorkerId = null,
      run.claimedAt = null, run.heartbeatAt = null, run.claimExpiresAt = null,
      run.clarificationCandidateIds = $candidateConceptIds,
      run.clarificationDescriptor = $clarificationDescriptor
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
      run.clarificationCandidateIds = null, run.failure = null,
      run.clarificationDescriptor = null,
      run.constraintSnapshot = null, run.revisionSeals = null,
      run.safetyEnvelope = null, run.modelProposal = null,
      run.validationReceipt = null
    RETURN run
  `,
  fail: `
    MATCH (run:WorkoutRun {runId: $runId})
    SET run.lockVersion = coalesce(run.lockVersion, 0) + 1
    WITH run
    WHERE run.state = 'running' AND run.claimGeneration = $generation AND run.claimWorkerId = $workerId
      AND datetime(run.claimExpiresAt) > datetime()
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
      AND datetime(run.claimExpiresAt) > datetime()
      AND run.authorizationReferenceId = $authorizationReferenceId
      AND run.requestDigest = $requestDigest
      AND run.revisionSeals = $revisionSeals
      AND run.safetyEnvelope = $safetyEnvelope
      AND run.modelProposal = $modelProposal
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
