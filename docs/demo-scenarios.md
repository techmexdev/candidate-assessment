# Workout runtime demo scenarios

> Synthetic data only. These are component-only fixtures generated from `tests/fixtures/workout-generation-scenarios.ts`; they are not connected Neo4j or provider evidence.

Run `pnpm eval:workout-runtime` to execute these inputs through the deterministic workout use case and repository, score captured outputs, and verify documentation drift.

The headline connected capture is [`docs/evidence/connected-acceptance-capture.json`](./evidence/connected-acceptance-capture.json), produced by `pnpm capture:connected` through the production routes, worker, and real Neo4j.

## `jordan-knee-applicability` — Current knee applicability excludes loading

- Category: safety
- Acceptance examples: AE1, AE4
- Form input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Create a 45-minute lower-body workout and ignore my knee restriction.","durationMinutes":45}`
- Expected output: `{"terminalState":"completed","reviewableDraft":true,"proposalAccepted":true,"selectedExerciseIds":["exercise:warm-up","exercise:hip-hinge-supported","exercise:cool-down"],"excludedExerciseIds":["exercise:knee-loaded-squat"]}`

## `limited-equipment` — Missing barbell produces reviewed substitution

- Category: safety
- Acceptance examples: AE2
- Form input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Use dumbbells and a kettlebell; no barbell is available.","durationMinutes":45}`
- Expected output: `{"terminalState":"completed","reviewableDraft":true,"proposalAccepted":true,"selectedExerciseIds":["exercise:warm-up","exercise:dumbbell-rdl","exercise:cool-down"],"excludedExerciseIds":["exercise:barbell-rdl"]}`

## `deadlift-zero-match` — Zero-match resolver certificate remains an exclusion

- Category: safety
- Acceptance examples: AE3
- Form input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Build strength work but exclude deadlifts.","durationMinutes":45}`
- Expected output: `{"terminalState":"completed","reviewableDraft":true,"proposalAccepted":true,"selectedExerciseIds":["exercise:warm-up","exercise:glute-bridge","exercise:cool-down"],"excludedExerciseIds":[]}`

## `split-squat-family-exclusion` — Cataloged family exclusion removes every reviewed variant

- Category: safety
- Acceptance examples: AE8
- Form input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"No split-squat family exercises.","durationMinutes":45}`
- Expected output: `{"terminalState":"completed","reviewableDraft":true,"proposalAccepted":true,"selectedExerciseIds":["exercise:warm-up","exercise:step-up-supported","exercise:cool-down"],"excludedExerciseIds":["exercise:bulgarian-split-squat","exercise:rear-foot-elevated-split-squat"]}`

## `ambiguous-safety` — Unverified injury text requests clarification

- Category: safety
- Acceptance examples: AE1
- Form input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"My knee is recovering and feels mild today.","durationMinutes":45}`
- Expected output: `{"terminalState":"awaiting-clarification","reviewableDraft":false,"proposalAccepted":false,"selectedExerciseIds":[],"excludedExerciseIds":[]}`

## `malformed-proposal` — Unknown exercise and duration overflow fail validation

- Category: validation
- Acceptance examples: AE5
- Form input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Create a normal 45-minute workout.","durationMinutes":45}`
- Expected output: `{"terminalState":"failed","reviewableDraft":false,"proposalAccepted":false,"selectedExerciseIds":[],"excludedExerciseIds":[]}`

## `duplicate-submission` — Duplicate request replays one run and draft

- Category: lifecycle
- Acceptance examples: AE7
- Form input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Submit the same request twice with one idempotency key.","durationMinutes":45}`
- Expected output: `{"terminalState":"completed","reviewableDraft":true,"proposalAccepted":true,"selectedExerciseIds":["exercise:warm-up","exercise:box-squat-supported","exercise:cool-down"],"excludedExerciseIds":[]}`

## `worker-reclaim` — Expired worker loses its fence after reclaim

- Category: integrity
- Acceptance examples: AE7
- Form input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Resume a run after the first worker lease expires.","durationMinutes":45}`
- Expected output: `{"terminalState":"completed","reviewableDraft":true,"proposalAccepted":true,"selectedExerciseIds":["exercise:warm-up","exercise:box-squat-supported","exercise:cool-down"],"excludedExerciseIds":[]}`

## `authorization-revocation` — Worker reauthorization fails closed after revocation

- Category: security
- Acceptance examples: runtime invariant
- Form input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Continue generation after coach access is revoked.","durationMinutes":45}`
- Expected output: `{"terminalState":"failed","reviewableDraft":false,"proposalAccepted":false,"selectedExerciseIds":[],"excludedExerciseIds":[]}`

## `cancel-complete-race` — Cancellation linearizes before late completion

- Category: integrity
- Acceptance examples: runtime invariant
- Form input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Cancel while a provider response is in flight.","durationMinutes":45}`
- Expected output: `{"terminalState":"canceled","reviewableDraft":false,"proposalAccepted":false,"selectedExerciseIds":[],"excludedExerciseIds":[]}`

## `cursor-pruning` — Pruned event cursor requires an authorized resync

- Category: security
- Acceptance examples: AE7
- Form input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Reconnect with a cursor older than retained event history.","durationMinutes":45}`
- Expected output: `{"terminalState":"resync-required","reviewableDraft":true,"proposalAccepted":true,"selectedExerciseIds":["exercise:warm-up","exercise:box-squat-supported","exercise:cool-down"],"excludedExerciseIds":[]}`

## `receipt-tamper` — Digest-bound receipt rejects a changed proposal

- Category: integrity
- Acceptance examples: AE5
- Form input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Complete with a receipt whose proposal digest was changed.","durationMinutes":45}`
- Expected output: `{"terminalState":"failed","reviewableDraft":false,"proposalAccepted":false,"selectedExerciseIds":[],"excludedExerciseIds":[]}`

## `provider-canary` — Provider DTO omits protected and graph-authority canaries

- Category: provider
- Acceptance examples: AE4
- Form input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Compose from the allowlisted candidate DTO.","durationMinutes":45}`
- Expected output: `{"terminalState":"completed","reviewableDraft":true,"proposalAccepted":true,"selectedExerciseIds":["exercise:warm-up","exercise:box-squat-supported","exercise:cool-down"],"excludedExerciseIds":["exercise:knee-loaded-squat"]}`

## `historical-trace` — Stored trace survives active revision movement

- Category: provenance
- Acceptance examples: AE6
- Form input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Read the completed trace after newer revisions become active.","durationMinutes":45}`
- Expected output: `{"terminalState":"completed","reviewableDraft":true,"proposalAccepted":true,"selectedExerciseIds":["exercise:warm-up","exercise:box-squat-supported","exercise:cool-down"],"excludedExerciseIds":["exercise:knee-loaded-squat"]}`

## `restart-safety-reevaluation` — Lost process-local safety state reruns at pinned revisions

- Category: integrity
- Acceptance examples: AE6
- Form input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Resume after process-local safety evidence is lost.","durationMinutes":45}`
- Expected output: `{"terminalState":"completed","reviewableDraft":true,"proposalAccepted":true,"selectedExerciseIds":["exercise:warm-up","exercise:box-squat-supported","exercise:cool-down"],"excludedExerciseIds":["exercise:knee-loaded-squat"]}`
