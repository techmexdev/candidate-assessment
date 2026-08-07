# Decision and Run graph schema

The workout-generation runtime owns a separate `WorkoutRun` namespace. It records execution and provenance identities without adding relationships to Movement/Clinical or Member Context nodes. Those graphs are referenced only by their immutable revision, seal, assertion, and evidence identifiers.

## Stored roles

- `WorkoutRun` is the PROV activity and authorization boundary. It stores coach/member ownership, the durable authorization-reference ID, request and idempotency digests, pinned revision IDs, policy/model identifiers, lifecycle state, lease generation, and event sequence allocator.
- `WorkoutRunInputRevision` is append-only. Clarification creates the next integer revision and moves the run's active input pointer; earlier prompt snapshot IDs and digests are retained.
- `WorkoutRunEvent` contains a per-run atomic sequence, schema version, event kind, timestamp, and an allowlisted safe-data projection. Raw prompts, evidence text, safety rationales, provider payloads, and authorization material are forbidden.
- `WorkoutModelProposal` and `WorkoutValidationReceipt` retain the proposal entity identity and receipt bindings used at completion.
- `WorkoutVersion` is the immutable, reviewable draft generated once by a completed run.
- `WorkoutExerciseDecision` retains the exact exercise classification, pinned revision IDs, assertion IDs, contributing path IDs, evidence IDs, and explanation projection used by that run.

`USED`, `GENERATED` / `WAS_GENERATED_BY`, and `WAS_DERIVED_FROM` project the PROV-O activity/entity relationships. `RECORDED_DECISION`, `HAS_INPUT_REVISION`, `HAS_VALIDATION_RECEIPT`, and `HAS_EVENT` preserve application-specific meanings.

## Lifecycle and concurrency

The allowed path is `queued → running → completed|failed|canceled|awaiting-clarification`; clarification answers append an input revision and move `awaiting-clarification → queued`. Failed, canceled, and completed runs are terminal. Retrying creates a distinct queued run with `retryOfRunId`; it never mutates the failed attempt.

A claim has an expiry and monotonically increasing generation. Reclaiming an expired lease increments the generation. Heartbeats, checkpoints, event appends, failures, clarification, and completion compare both generation and worker ID. Consequently a stale worker cannot mutate after reclaim.

Completion is one Neo4j write transaction. It verifies run ownership, authorization reference, current fence, state, request digest, pinned revisions, resolved-constraint digest, validation-receipt bindings, complete decision evidence, workout identity, and provenance shape before creating the immutable workout, decisions, PROV links, receipt, and one terminal event. Cancellation wins when its transaction changes the run before the completion compare-and-set. Duplicate completion with the same workout version is a read-only replay.

## Idempotency, replay, and retention

The database uniqueness key is `(coachId, memberId, action, idempotencyKeyDigest)`. A matching request digest replays the stored run; a changed request digest conflicts. A new idempotency key may create a new run for the same logical request.

Event cursors are HMAC-authenticated, opaque, run-bound, schema-versioned, and carry the exclusive next sequence. Cursor parsing happens only after coach/member/run authorization. Malformed, foreign, or ahead-of-high-water cursors return the same not-found result and disclose no event bounds. When retained history begins after the cursor, reads return `resync_required` with the authoritative run snapshot URL.

Production retention may prune old event nodes and protected prompt/provider artifacts under separate policies. Runs, input digests, workout versions, validation receipts, decisions, referenced revision/seal/assertion IDs, and canonical provenance remain immutable for historical trace verification. Historical reads verify the stored bundle and fail closed; they never query active graph pointers to reconstruct past reasoning.
