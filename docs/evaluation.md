# Workout runtime evaluation

> Synthetic data only. Safety validity and provenance completeness are deterministic release gates; latency, provider availability, and model style are reported separately and never soften a failed hard gate.

## Current result

- Corpus: 15 deterministic scenarios
- Recommendation validity: 100.0%
- Provenance completeness: 100.0%
- Release ready: yes

## Scenario scores

| Scenario | Validity | Provenance | Hard gates | Latency (ms) | Model style |
|---|---:|---:|---|---:|---:|
| `jordan-knee-applicability` | 100.0% | 100.0% | pass | not sampled | not sampled |
| `limited-equipment` | 100.0% | 100.0% | pass | not sampled | not sampled |
| `deadlift-zero-match` | 100.0% | 100.0% | pass | not sampled | not sampled |
| `split-squat-family-exclusion` | 100.0% | 100.0% | pass | not sampled | not sampled |
| `ambiguous-safety` | 100.0% | 100.0% | pass | not sampled | not sampled |
| `malformed-proposal` | 100.0% | 100.0% | pass | not sampled | not sampled |
| `duplicate-submission` | 100.0% | 100.0% | pass | not sampled | not sampled |
| `worker-reclaim` | 100.0% | 100.0% | pass | not sampled | not sampled |
| `authorization-revocation` | 100.0% | 100.0% | pass | not sampled | not sampled |
| `cancel-complete-race` | 100.0% | 100.0% | pass | not sampled | not sampled |
| `cursor-pruning` | 100.0% | 100.0% | pass | not sampled | not sampled |
| `receipt-tamper` | 100.0% | 100.0% | pass | not sampled | not sampled |
| `provider-canary` | 100.0% | 100.0% | pass | 880 | 0.96 |
| `historical-trace` | 100.0% | 100.0% | pass | not sampled | not sampled |
| `restart-safety-reevaluation` | 100.0% | 100.0% | pass | not sampled | not sampled |

## Scoring contract

Recommendation validity requires the canonical terminal state, draft/persistence outcome, proposal validation result, selected/excluded candidate membership, graph-authoritative safety result, lifecycle invariant, and privacy boundary to all match the fixture. Provenance completeness requires a run/activity, both pinned revisions, source entities, derivation links, and—per decision—the run, revisions, assertion, traversed path, evidence, source entity, and derivation relation.

A score below 100.0% on either hard gate exits `pnpm eval:workout-runtime` unsuccessfully. Provider style and latency remain observational quality signals.
