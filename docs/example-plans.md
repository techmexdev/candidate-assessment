# Executed workout examples

> Synthetic data only. This file is generated from executed runtime captures. The offline harness uses deterministic graph-port fixtures and a deterministic composer, while exercising the real workout use case, validator, repository, lifecycle, and PROV-O projection. It does not claim a live model or clinical validation.

Regenerate and drift-check these examples with `pnpm eval:workout-runtime`. Print only this document with `pnpm eval:workout-runtime -- --print-examples`.

## Example 1: Current knee applicability excludes loading

**Input** (45 minutes):

```json
{
  "memberId": "member:synthetic-jordan",
  "prompt": "Create a 45-minute lower-body workout and ignore my knee restriction.",
  "durationMinutes": 45
}
```

**Captured plan**

| Section | Canonical exercise | Dose | Rest | Rationale |
|---|---|---:|---:|---|
| warm-up | `exercise:warm-up` | 1 × 9m | 0m | Deterministic evaluation composition |
| main | `exercise:hip-hinge-supported` | 1 × 29m 15s | 0m | Deterministic evaluation composition |
| cool-down | `exercise:cool-down` | 1 × 6m 45s | 0m | Deterministic evaluation composition |

Total planned duration: 45m; requested: 45m; difference: 0s.

**Filtering boundary**

- Candidate catalog before safety: `exercise:warm-up`, `exercise:hip-hinge-supported`, `exercise:cool-down`, `exercise:knee-loaded-squat`.
- Hard-filtered before the model: `exercise:knee-loaded-squat`.
- Allowlisted candidates visible to the model: `exercise:warm-up`, `exercise:hip-hinge-supported`, `exercise:cool-down`.
- The model received canonical IDs, dose bounds, safety status, and citation IDs; it did not receive the raw prompt, member facts, authorization material, Cypher, or excluded candidates.

**Provenance trace**

Run `workout-run:eval:jordan-knee-applicability` pins Movement revision `movement-revision:workout-test` and Member Context revision `member-revision:workout-test`. Trace digest: `sha256:7010b77fa0c9d1e3f6a0220261a7451d3fb27c9421bebc32115cb7389eac742a`.

| Exercise | Disposition | Safety | Source assertions | Contributing path | Evidence | Decision |
|---|---|---|---|---|---|---|
| `exercise:warm-up` | selected | allowed | `assertion:exercise:warm-up`; `assertion:path:exercise:warm-up` | `assertion:exercise:warm-up`; `assertion:path:exercise:warm-up` | `evidence:exercise:warm-up` | allowed by canonical catalog safety policy |
| `exercise:hip-hinge-supported` | selected | allowed | `assertion:exercise:hip-hinge-supported`; `assertion:path:exercise:hip-hinge-supported` | `assertion:exercise:hip-hinge-supported`; `assertion:path:exercise:hip-hinge-supported` | `evidence:exercise:hip-hinge-supported` | allowed by canonical catalog safety policy |
| `exercise:cool-down` | selected | allowed | `assertion:exercise:cool-down`; `assertion:path:exercise:cool-down` | `assertion:exercise:cool-down`; `assertion:path:exercise:cool-down` | `evidence:exercise:cool-down` | allowed by canonical catalog safety policy |
| `exercise:knee-loaded-squat` | not-selected | excluded | `assertion:exercise:knee-loaded-squat`; `assertion:path:exercise:knee-loaded-squat` | `assertion:exercise:knee-loaded-squat`; `assertion:path:exercise:knee-loaded-squat` | `evidence:exercise:knee-loaded-squat` | excluded by canonical catalog safety policy |

## Example 2: Missing barbell produces reviewed substitution

**Input** (45 minutes):

```json
{
  "memberId": "member:synthetic-jordan",
  "prompt": "Use dumbbells and a kettlebell; no barbell is available.",
  "durationMinutes": 45
}
```

**Captured plan**

| Section | Canonical exercise | Dose | Rest | Rationale |
|---|---|---:|---:|---|
| warm-up | `exercise:warm-up` | 1 × 9m | 0m | Deterministic evaluation composition |
| main | `exercise:dumbbell-rdl` | 1 × 29m 15s | 0m | Deterministic evaluation composition |
| cool-down | `exercise:cool-down` | 1 × 6m 45s | 0m | Deterministic evaluation composition |

Total planned duration: 45m; requested: 45m; difference: 0s.

**Filtering boundary**

- Candidate catalog before safety: `exercise:warm-up`, `exercise:dumbbell-rdl`, `exercise:cool-down`, `exercise:barbell-rdl`.
- Hard-filtered before the model: `exercise:barbell-rdl`.
- Allowlisted candidates visible to the model: `exercise:warm-up`, `exercise:dumbbell-rdl`, `exercise:cool-down`.
- The model received canonical IDs, dose bounds, safety status, and citation IDs; it did not receive the raw prompt, member facts, authorization material, Cypher, or excluded candidates.

**Provenance trace**

Run `workout-run:eval:limited-equipment` pins Movement revision `movement-revision:workout-test` and Member Context revision `member-revision:workout-test`. Trace digest: `sha256:8ca4e79aa833f2ebf20e4e2ae8d3b35b9541e854359ee9cf683e2a08b10ee582`.

| Exercise | Disposition | Safety | Source assertions | Contributing path | Evidence | Decision |
|---|---|---|---|---|---|---|
| `exercise:warm-up` | selected | allowed | `assertion:exercise:warm-up`; `assertion:path:exercise:warm-up` | `assertion:exercise:warm-up`; `assertion:path:exercise:warm-up` | `evidence:exercise:warm-up` | allowed by canonical catalog safety policy |
| `exercise:dumbbell-rdl` | selected | allowed | `assertion:exercise:dumbbell-rdl`; `assertion:path:exercise:dumbbell-rdl` | `assertion:exercise:dumbbell-rdl`; `assertion:path:exercise:dumbbell-rdl` | `evidence:exercise:dumbbell-rdl` | allowed by canonical catalog safety policy |
| `exercise:cool-down` | selected | allowed | `assertion:exercise:cool-down`; `assertion:path:exercise:cool-down` | `assertion:exercise:cool-down`; `assertion:path:exercise:cool-down` | `evidence:exercise:cool-down` | allowed by canonical catalog safety policy |
| `exercise:barbell-rdl` | not-selected | excluded | `assertion:exercise:barbell-rdl`; `assertion:path:exercise:barbell-rdl` | `assertion:exercise:barbell-rdl`; `assertion:path:exercise:barbell-rdl` | `evidence:exercise:barbell-rdl` | excluded by canonical catalog safety policy |

## Example 3: Cataloged family exclusion removes every reviewed variant

**Input** (45 minutes):

```json
{
  "memberId": "member:synthetic-jordan",
  "prompt": "No split-squat family exercises.",
  "durationMinutes": 45
}
```

**Captured plan**

| Section | Canonical exercise | Dose | Rest | Rationale |
|---|---|---:|---:|---|
| warm-up | `exercise:warm-up` | 1 × 9m | 0m | Deterministic evaluation composition |
| main | `exercise:step-up-supported` | 1 × 29m 15s | 0m | Deterministic evaluation composition |
| cool-down | `exercise:cool-down` | 1 × 6m 45s | 0m | Deterministic evaluation composition |

Total planned duration: 45m; requested: 45m; difference: 0s.

**Filtering boundary**

- Candidate catalog before safety: `exercise:warm-up`, `exercise:step-up-supported`, `exercise:cool-down`, `exercise:bulgarian-split-squat`, `exercise:rear-foot-elevated-split-squat`.
- Hard-filtered before the model: `exercise:bulgarian-split-squat`, `exercise:rear-foot-elevated-split-squat`.
- Allowlisted candidates visible to the model: `exercise:warm-up`, `exercise:step-up-supported`, `exercise:cool-down`.
- The model received canonical IDs, dose bounds, safety status, and citation IDs; it did not receive the raw prompt, member facts, authorization material, Cypher, or excluded candidates.

**Provenance trace**

Run `workout-run:eval:split-squat-family-exclusion` pins Movement revision `movement-revision:workout-test` and Member Context revision `member-revision:workout-test`. Trace digest: `sha256:920ab4bde1f9a2eabb7f0197f8bab74cb7680733042cc0ffd4dce5b3c8cc6025`.

| Exercise | Disposition | Safety | Source assertions | Contributing path | Evidence | Decision |
|---|---|---|---|---|---|---|
| `exercise:warm-up` | selected | allowed | `assertion:exercise:warm-up`; `assertion:path:exercise:warm-up` | `assertion:exercise:warm-up`; `assertion:path:exercise:warm-up` | `evidence:exercise:warm-up` | allowed by canonical catalog safety policy |
| `exercise:step-up-supported` | selected | allowed | `assertion:exercise:step-up-supported`; `assertion:path:exercise:step-up-supported` | `assertion:exercise:step-up-supported`; `assertion:path:exercise:step-up-supported` | `evidence:exercise:step-up-supported` | allowed by canonical catalog safety policy |
| `exercise:cool-down` | selected | allowed | `assertion:exercise:cool-down`; `assertion:path:exercise:cool-down` | `assertion:exercise:cool-down`; `assertion:path:exercise:cool-down` | `evidence:exercise:cool-down` | allowed by canonical catalog safety policy |
| `exercise:bulgarian-split-squat` | not-selected | excluded | `assertion:exercise:bulgarian-split-squat`; `assertion:path:exercise:bulgarian-split-squat` | `assertion:exercise:bulgarian-split-squat`; `assertion:path:exercise:bulgarian-split-squat` | `evidence:exercise:bulgarian-split-squat` | excluded by canonical catalog safety policy |
| `exercise:rear-foot-elevated-split-squat` | not-selected | excluded | `assertion:exercise:rear-foot-elevated-split-squat`; `assertion:path:exercise:rear-foot-elevated-split-squat` | `assertion:exercise:rear-foot-elevated-split-squat`; `assertion:path:exercise:rear-foot-elevated-split-squat` | `evidence:exercise:rear-foot-elevated-split-squat` | excluded by canonical catalog safety policy |
