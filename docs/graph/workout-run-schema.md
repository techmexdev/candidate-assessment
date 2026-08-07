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

## Runtime and provider boundary

The workout agent never receives a graph client or graph query tool. Server-side resolution pins the Movement/Clinical and Member Context revisions, evaluates the canonical catalog, and passes only eligible typed candidates plus allowlisted evidence IDs to the composer. Raw prompts, applicability or injury text, hidden exclusions, authorization material, graph credentials, and arbitrary evidence text stay outside the provider DTO. Provider unavailability or malformed output produces a typed non-reviewable failure; deterministic safety and final composition validation never degrade to model judgment.

Provider configuration belongs to the server composition root: it injects an AI SDK `LanguageModel` into the workout-composer adapter and may override the adapter's five-second timeout. The runtime itself reads no provider-specific environment variables and stores only the run's model-configuration identifier. API keys, provider clients, and provider response artifacts must remain server-only and outside Run events, ordinary reads, provenance projections, fixtures, and client bundles.

Each protected worker stage reauthorizes through the run's stable authorization-reference ID. Authorization failure, loss of process-local safety state, or a changed revision seal invalidates dependent artifacts and fails closed. Safety-session loss triggers evaluation again at the already pinned revisions; it does not promote fixture data or follow current graph pointers.

## Provenance and evaluation contract

The PROV-O projection supplements rather than replaces the runtime schema. `WorkoutRun` is the generation activity; prompt, revision, policy, candidate-set, model-proposal, and workout-version records are entities. `USED`, `WAS_GENERATED_BY`, and `WAS_DERIVED_FROM` provide the portable projection while `RECORDED_DECISION` retains the application-specific classification, assertion, traversed path, evidence, and explanation for every selected, excluded, cautioned, down-ranked, or substituted exercise. New decisions record selection disposition (`selected | not-selected`) separately from the canonical graph safety classification (`allowed | caution | downranked | excluded`), so choosing a cautioned or down-ranked candidate never erases its safety status and omitting an allowed candidate never relabels it as down-ranked. The legacy `kind` summary remains readable for stored v1 traces.

`tests/fixtures/workout-generation-scenarios.ts` is the checked-in deterministic evaluation corpus. `pnpm eval:workout-runtime` requires 100% recommendation validity and provenance completeness and rejects drift in `docs/demo-scenarios.md` or `docs/evaluation.md`. All fixture identities and prompts are synthetic; production prompts, health context, authorization artifacts, and provider payloads must never be copied into the corpus or documentation.
