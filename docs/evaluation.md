# Workout runtime evaluation

> Component evaluation only: synthetic inputs are executed through the real deterministic workout use case and in-memory repository. Expected values never populate observations. Safety validity and provenance completeness are release gates; provider latency and style are unavailable in this offline harness and therefore non-gating. Connected Neo4j acceptance is a separate gate (`pnpm test:connected`) with evidence in [`docs/evidence/connected-acceptance-capture.json`](./evidence/connected-acceptance-capture.json).

## Current result

- Corpus: 15 executable deterministic scenarios
- Recommendation validity: 100.0%
- Provenance completeness: 100.0%
- Release ready: yes

## Scenario scores

| Scenario | Validity | Provenance | Hard gates | Provider latency (ms) | Provider style |
|---|---:|---:|---|---:|---:|
| `jordan-knee-applicability` | 100.0% | 100.0% | pass | unavailable | unavailable |
| `limited-equipment` | 100.0% | 100.0% | pass | unavailable | unavailable |
| `deadlift-zero-match` | 100.0% | 100.0% | pass | unavailable | unavailable |
| `split-squat-family-exclusion` | 100.0% | 100.0% | pass | unavailable | unavailable |
| `ambiguous-safety` | 100.0% | 100.0% | pass | unavailable | unavailable |
| `malformed-proposal` | 100.0% | 100.0% | pass | unavailable | unavailable |
| `duplicate-submission` | 100.0% | 100.0% | pass | unavailable | unavailable |
| `worker-reclaim` | 100.0% | 100.0% | pass | unavailable | unavailable |
| `authorization-revocation` | 100.0% | 100.0% | pass | unavailable | unavailable |
| `cancel-complete-race` | 100.0% | 100.0% | pass | unavailable | unavailable |
| `cursor-pruning` | 100.0% | 100.0% | pass | unavailable | unavailable |
| `receipt-tamper` | 100.0% | 100.0% | pass | unavailable | unavailable |
| `provider-canary` | 100.0% | 100.0% | pass | unavailable | unavailable |
| `historical-trace` | 100.0% | 100.0% | pass | unavailable | unavailable |
| `restart-safety-reevaluation` | 100.0% | 100.0% | pass | unavailable | unavailable |

## Scoring contract

The harness creates a queued run, executes `createExecuteWorkoutRun` against `InMemoryWorkoutRunRepository`, and derives terminal state, draft presence, proposal acceptance, candidate membership, safety classification, privacy-boundary checks, lifecycle checks, and provenance from stored runtime outputs. Lifecycle scenarios additionally exercise replay, reclaim, cancellation, cursor pruning, receipt rejection, and safety reevaluation. A mutation test deliberately corrupts a captured output and proves the gate fails.

Completed runs require a valid stored PROV-O projection with pinned revisions and complete decision evidence. Non-completed runs require pinned run identity and the absence of a fabricated completion trace. A score below 100.0% on either hard gate exits `pnpm eval:workout-runtime` unsuccessfully.

This offline corpus does not call a model provider, so provider latency and style are explicitly unavailable. They must be measured by a separate provider-backed canary before becoming observational signals; they never soften a failed hard gate.

This report proves component lifecycle, validation, privacy, and provenance invariants only. It must not be cited as provider quality or connected graph proof; use the connected capture and U5 adapter tests for those claims.
