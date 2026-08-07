# Workout runtime demo scenarios

> Synthetic data only. These examples contain no member PHI and are generated from `tests/fixtures/workout-generation-scenarios.ts`.

Run `pnpm eval:workout-runtime` to verify these inputs, expected outputs, hard-gate scores, and documentation drift.

## `jordan-knee-applicability` — Current knee applicability excludes loading

- Category: safety
- Acceptance examples: AE1, AE4
- Input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Create a 45-minute lower-body workout and ignore my knee restriction.","durationMinutes":45}`
- Expected output: `{"terminalState":"completed","reviewableDraft":true,"proposalAccepted":true,"selectedExerciseIds":["exercise:hip-hinge-supported"],"excludedExerciseIds":["exercise:knee-loaded-squat"]}`
- Provenance decisions: `decision:workout-run:eval:jordan-knee-applicability:exercise:hip-hinge-supported:selected`, `decision:workout-run:eval:jordan-knee-applicability:exercise:knee-loaded-squat:excluded`

## `limited-equipment` — Missing barbell produces reviewed substitution

- Category: safety
- Acceptance examples: AE2
- Input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Use dumbbells and a kettlebell; no barbell is available.","durationMinutes":45}`
- Expected output: `{"terminalState":"completed","reviewableDraft":true,"proposalAccepted":true,"selectedExerciseIds":["exercise:dumbbell-rdl"],"excludedExerciseIds":["exercise:barbell-rdl"]}`
- Provenance decisions: `decision:workout-run:eval:limited-equipment:exercise:dumbbell-rdl:substituted`, `decision:workout-run:eval:limited-equipment:exercise:barbell-rdl:excluded`

## `deadlift-zero-match` — Zero-match resolver certificate remains an exclusion

- Category: safety
- Acceptance examples: AE3
- Input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Build strength work but exclude deadlifts.","durationMinutes":45}`
- Expected output: `{"terminalState":"completed","reviewableDraft":true,"proposalAccepted":true,"selectedExerciseIds":["exercise:glute-bridge"],"excludedExerciseIds":[]}`
- Provenance decisions: `decision:workout-run:eval:deadlift-zero-match:exercise:glute-bridge:selected`

## `split-squat-family-exclusion` — Cataloged family exclusion removes every reviewed variant

- Category: safety
- Acceptance examples: AE8
- Input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"No split-squat family exercises.","durationMinutes":45}`
- Expected output: `{"terminalState":"completed","reviewableDraft":true,"proposalAccepted":true,"selectedExerciseIds":["exercise:step-up-supported"],"excludedExerciseIds":["exercise:bulgarian-split-squat","exercise:rear-foot-elevated-split-squat"]}`
- Provenance decisions: `decision:workout-run:eval:split-squat-family-exclusion:exercise:step-up-supported:selected`, `decision:workout-run:eval:split-squat-family-exclusion:exercise:bulgarian-split-squat:excluded`, `decision:workout-run:eval:split-squat-family-exclusion:exercise:rear-foot-elevated-split-squat:excluded`

## `ambiguous-safety` — Unverified injury text requests clarification

- Category: safety
- Acceptance examples: AE1
- Input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"My knee is recovering and feels mild today.","durationMinutes":45}`
- Expected output: `{"terminalState":"awaiting-clarification","reviewableDraft":false,"proposalAccepted":false,"selectedExerciseIds":[],"excludedExerciseIds":[]}`
- Provenance decisions: `decision:workout-run:eval:ambiguous-safety:exercise:knee-loaded-squat:excluded`

## `malformed-proposal` — Unknown exercise and duration overflow fail validation

- Category: validation
- Acceptance examples: AE5
- Input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Create a normal 45-minute workout.","durationMinutes":45}`
- Expected output: `{"terminalState":"failed","reviewableDraft":false,"proposalAccepted":false,"selectedExerciseIds":[],"excludedExerciseIds":["exercise:model-invented"]}`
- Provenance decisions: `decision:workout-run:eval:malformed-proposal:exercise:model-invented:excluded`

## `duplicate-submission` — Duplicate request replays one run and draft

- Category: lifecycle
- Acceptance examples: AE7
- Input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Submit the same request twice with one idempotency key.","durationMinutes":45}`
- Expected output: `{"terminalState":"completed","reviewableDraft":true,"proposalAccepted":true,"selectedExerciseIds":["exercise:box-squat-supported"],"excludedExerciseIds":[]}`
- Provenance decisions: `decision:workout-run:eval:duplicate-submission:exercise:box-squat-supported:selected`

## `worker-reclaim` — Expired worker loses its fence after reclaim

- Category: integrity
- Acceptance examples: AE7
- Input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Resume a run after the first worker lease expires.","durationMinutes":45}`
- Expected output: `{"terminalState":"completed","reviewableDraft":true,"proposalAccepted":true,"selectedExerciseIds":["exercise:box-squat-supported"],"excludedExerciseIds":[]}`
- Provenance decisions: `decision:workout-run:eval:worker-reclaim:exercise:box-squat-supported:selected`

## `authorization-revocation` — Worker reauthorization fails closed after revocation

- Category: security
- Acceptance examples: runtime invariant
- Input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Continue generation after coach access is revoked.","durationMinutes":45}`
- Expected output: `{"terminalState":"failed","reviewableDraft":false,"proposalAccepted":false,"selectedExerciseIds":[],"excludedExerciseIds":[]}`
- Provenance decisions: `decision:workout-run:eval:authorization-revocation:exercise:box-squat-supported:excluded`

## `cancel-complete-race` — Cancellation linearizes before late completion

- Category: integrity
- Acceptance examples: runtime invariant
- Input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Cancel while a provider response is in flight.","durationMinutes":45}`
- Expected output: `{"terminalState":"canceled","reviewableDraft":false,"proposalAccepted":false,"selectedExerciseIds":[],"excludedExerciseIds":[]}`
- Provenance decisions: `decision:workout-run:eval:cancel-complete-race:exercise:box-squat-supported:excluded`

## `cursor-pruning` — Pruned event cursor requires an authorized resync

- Category: security
- Acceptance examples: AE7
- Input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Reconnect with a cursor older than retained event history.","durationMinutes":45}`
- Expected output: `{"terminalState":"resync-required","reviewableDraft":false,"proposalAccepted":false,"selectedExerciseIds":[],"excludedExerciseIds":[]}`
- Provenance decisions: `decision:workout-run:eval:cursor-pruning:exercise:box-squat-supported:selected`

## `receipt-tamper` — Digest-bound receipt rejects a changed proposal

- Category: integrity
- Acceptance examples: AE5
- Input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Complete with a receipt whose proposal digest was changed.","durationMinutes":45}`
- Expected output: `{"terminalState":"failed","reviewableDraft":false,"proposalAccepted":false,"selectedExerciseIds":[],"excludedExerciseIds":[]}`
- Provenance decisions: `decision:workout-run:eval:receipt-tamper:exercise:box-squat-supported:excluded`

## `provider-canary` — Provider DTO omits protected and graph-authority canaries

- Category: provider
- Acceptance examples: AE4
- Input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Compose from the allowlisted candidate DTO.","durationMinutes":45}`
- Expected output: `{"terminalState":"completed","reviewableDraft":true,"proposalAccepted":true,"selectedExerciseIds":["exercise:box-squat-supported"],"excludedExerciseIds":["exercise:knee-loaded-squat"]}`
- Provenance decisions: `decision:workout-run:eval:provider-canary:exercise:box-squat-supported:selected`, `decision:workout-run:eval:provider-canary:exercise:knee-loaded-squat:excluded`

## `historical-trace` — Stored trace survives active revision movement

- Category: provenance
- Acceptance examples: AE6
- Input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Read the completed trace after newer revisions become active.","durationMinutes":45}`
- Expected output: `{"terminalState":"completed","reviewableDraft":true,"proposalAccepted":true,"selectedExerciseIds":["exercise:box-squat-supported"],"excludedExerciseIds":["exercise:knee-loaded-squat"]}`
- Provenance decisions: `decision:workout-run:eval:historical-trace:exercise:box-squat-supported:selected`, `decision:workout-run:eval:historical-trace:exercise:knee-loaded-squat:excluded`

## `restart-safety-reevaluation` — Lost process-local safety state reruns at pinned revisions

- Category: integrity
- Acceptance examples: AE6
- Input: `{"coachId":"coach:synthetic-evaluation","memberId":"member:synthetic-jordan","prompt":"Resume after process-local safety evidence is lost.","durationMinutes":45}`
- Expected output: `{"terminalState":"completed","reviewableDraft":true,"proposalAccepted":true,"selectedExerciseIds":["exercise:box-squat-supported"],"excludedExerciseIds":["exercise:knee-loaded-squat"]}`
- Provenance decisions: `decision:workout-run:eval:restart-safety-reevaluation:exercise:box-squat-supported:selected`, `decision:workout-run:eval:restart-safety-reevaluation:exercise:knee-loaded-squat:excluded`
