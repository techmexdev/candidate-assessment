# AI Engineer Take-Home

A staff-level take-home for AI engineering candidates: build a **knowledge graph** from exercise data and clinical ontologies, then a **coach dashboard** on top of it — an **AI workout generator** and a **member-context copilot** — that gives **safe, personalized, explainable** recommendations.

- **Time:** 1 day
- **Stack:** your choice — we want you to pick the tools and defend them
- **Data:** synthetic only (provided in [`data/`](./data)); never use real member data

## What's in this repo

| Path | Purpose |
|------|---------|
| [`ASSESSMENT.md`](./ASSESSMENT.md) | The full take-home spec — task, knowledge graphs, ontologies, build steps, deliverable |
| [`data/exercises.json`](./data/exercises.json) | Exercise catalog (50 exercises) |
| [`data/member-context.json`](./data/member-context.json) | One rich synthetic member: profile, goals, injuries, chat history, biomarkers, labs (blood panel + DEXA), adherence, churn signals |

## The gist

Two surfaces in one coach dashboard:

1. **Workout Generator** — a prompt + time form that calls an agentic runtime and renders a structured workout. It reasons over a **movement/clinical knowledge graph** (grounded with a bounded SNOMED CT subset plus SKOS and PROV-O; OPE is citation-only) to keep recommendations injury-aware, equipment-aware, and explainable. COPPER belongs to the Member Context graph, never the Movement safety authority.
2. **AI Copilot** — a chat panel with retrieval over a **member-context knowledge graph**: adherence trends, sleep, churn risk, the morning brief, charts, and past conversations.

See [`ASSESSMENT.md`](./ASSESSMENT.md) for the complete spec.

## Submitting

Build in a GitHub repo with a comprehensive README (architecture and tech-choice rationale, how to run locally, how you used AI, and your trade-offs). Use synthetic data only, then share the link.

## Current UI slice

The root route now renders the copy-first AXON coach dashboard. It uses only the synthetic records in `data/` plus one typed fixture adapter; the `ui/` directory remains a disconnected design reference and is never imported by production code.

```bash
pnpm install
pnpm dev
```

Quality gates are available through `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm test:a11y`, `pnpm test:visual`, and `pnpm build`.

Adjustment, override, Copilot, version history, and publication are deterministic local demonstrations. They do not authenticate a coach, call a model, query Neo4j, persist changes, or deliver a workout. The broader graph-backed implementation remains defined in [`docs/plans/2026-08-05-001-feat-graph-backed-coach-dashboard-plan.md`](./docs/plans/2026-08-05-001-feat-graph-backed-coach-dashboard-plan.md).

## Member Context knowledge graph

The repository includes a revisioned, provenance-bearing Member Context graph seeded only from the tracked synthetic Jordan fixture. Start the pinned local Neo4j service, validate the seed without writes, publish it, and inspect the active revision from the repository root:

```bash
docker compose up -d neo4j
pnpm graph:seed:member -- --dry-run
pnpm graph:seed:member
pnpm graph:seed:member -- --inspect
```

The graph is a bounded retrieval substrate, not a completed Copilot or clinical system. It does not support real member data, clinical validation, image analysis, model-authored Cypher, or direct client access to Neo4j. See [`docs/graph/member-context-schema.md`](./docs/graph/member-context-schema.md) for the complete schema, provenance and time rules, cross-graph boundary, publication lifecycle, application read port, and downstream pin-and-cite flow.

## Coach AI Copilot

The connected Copilot is a read-only server capability over the canonical Member Context graph. The server derives the synthetic coach entitlement, opens one active or explicitly continued revision, and gives the runtime only the bounded typed read handle. The browser and model never receive Neo4j credentials, Cypher, traversal controls, authorization claims, or permission to choose a member or revision.

The five quick prompts are deterministic and do not require a model: `Morning brief`, `Adherence`, `Sleep`, `What changed since last week?`, and `Churn risk`. Exact aliases resolve through the same versioned intent registry. Other bounded free text is sent to the configured model only for canonical intent classification; the provider may return stable intent IDs, but it cannot author facts, chart points, citations, risk levels, identity, or actions. Factual clauses, exact message quotations, charts, accessible chart summaries, citations, timestamps, and churn are rendered and validated deterministically from the pinned evidence.

Start Neo4j, seed the synthetic Jordan revision, and run the app:

```bash
pnpm install
docker compose up -d neo4j
pnpm graph:seed:member
pnpm dev
```

Local development supplies a mock synthetic coach session when no session cookie is present. Jordan is the only canonical Member Context seed; Avery and Morgan remain in the synthetic roster but return a truthful unavailable-context state. For non-local use, configure `COPILOT_CONTINUATION_SECRET` and `COPILOT_SESSION_SECRET` with separate values of at least 32 bytes, plus the Neo4j variables documented below. `COPILOT_LOCAL_COACH_ID` and comma-separated `COPILOT_LOCAL_MEMBER_IDS` only customize the local mock scope.

Free-text classification is optional. Set `AI_GATEWAY_API_KEY` and `COPILOT_MODEL_ID` to enable the AI SDK provider. Without them, deterministic quick prompts still work and non-alias free text returns a retryable model-unavailable state. Provider input is restricted to the current question, canonical intent IDs, and empty bounded selection metadata; input/output telemetry and provider retries are disabled at this boundary.

The external result union keeps degraded behavior explicit:

| State | Meaning and recovery |
|---|---|
| `empty` / `insufficient-history` | No canonical context, or too few points; no chart or invented trend is returned. |
| `denied` | One non-enumerating response for unknown or unauthorized members. |
| `continuation-expired` / `stale` | The saved pin cannot be reopened; the coach must deliberately refresh. |
| `unavailable` | Graph failure or deadline; Retry is allowed and the prior ready answer may remain visible. |
| `model-error` | Provider unavailable, timeout, malformed selection, or rejected grounding; Retry is allowed. |
| `unsupported` / `invalid` | The question is outside supported intent or input bounds; Retry does not widen scope. |
| `cancelled` | Navigation or abort won; late completion cannot update the active athlete. |

`churn-v1` is a deterministic explanation policy, not a trained prediction. It requires at least two weekly adherence points and two planned workouts. A drop of at least 25 percentage points or at least two missed workouts is `elevated`; a 10–24 point drop or one miss is `watch`; otherwise the core result is `low`. Comparable member-message counts may add a signal, while source prose, sentiment, login-frequency claims, and model output cannot change the level. Source-provided risk remains separately labeled, and unsupported login reasons remain excluded.

Run the reproducible Copilot gates with a fake model and synthetic data only:

```bash
pnpm vitest run tests/unit/check-production-isolation.test.ts
pnpm check:isolation
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm test:a11y
pnpm typecheck
pnpm lint
pnpm build
```

The canonical grounding matrix runs all five quick prompts plus free text, follow-up, injection, sparse-history, and adversarial packet checks against real Neo4j without network model calls. It treats authorization, member/revision parity, evidence-kind compatibility, clause citations, chart equality, unsupported login/image claims, typed failures, and production isolation as release gates. Language quality and latency are reported signals only. If local Neo4j routing discovery is unavailable, the same focused test can use the direct endpoint with `NEO4J_URI=bolt://127.0.0.1:7687`.

This exact-retrieval baseline is intentionally conservative: it is auditable and deterministic, but it supports a small intent vocabulary and does not provide semantic/vector search, persisted chat transcripts, image analysis, voice transport, member messaging, graph writes, clinical recommendations, or a trained churn model. Every record and example is synthetic take-home data; do not ingest real member data or PHI.

## Movement and Clinical knowledge graph

This repository also contains the complete, member-agnostic Movement and Clinical graph contract. It has 13 node roles, 17 directed edge types, immutable revisions, deterministic safety paths, reviewed substitutions, and bounded ontology grounding. COPPER belongs to the Member Context graph. Recommendation history belongs to a separate Decision and Run graph.

All data and clinical rules are synthetic take-home examples. This graph is not clinically validated medical guidance.

### Local Neo4j and publication

Run these commands from the repository root. Docker keeps Neo4j on localhost and stores its data in the named `movement-neo4j-data` volume.

```bash
# Start the pinned local Neo4j service.
docker compose up -d neo4j

# Compile and validate. This writes nothing.
pnpm graph:seed -- --dry-run

# Stage, read back, validate, and seal the revision. This does not activate it.
pnpm graph:seed

# Inspect the active pointer or one named historical/staged revision.
pnpm graph:inspect
pnpm graph:inspect -- --revision <revision-id>

# Activation is always explicit. Use the active ID from inspect, or null for the first activation.
pnpm graph:seed -- --activate --expected-prior <current-revision-id-or-null> --actor <curator-id>

# Verify unit and real-Neo4j behavior.
pnpm test
pnpm test:integration
```

The dry-run and seed output contains only synthetic counts, revision IDs, source digests, validation state, and activation outcome. Copy the dry-run `graphRevisionId` when you want to inspect the staged revision. Activation uses compare-and-swap: a stale expected prior fails and leaves the current revision active.

The local defaults are safe only for local development and tests:

| Variable | Local default | Meaning |
|---|---|---|
| `NEO4J_URI` | `neo4j://127.0.0.1:7687` | Driver endpoint. A non-local endpoint must use `neo4j+s://` or `bolt+s://`. |
| `NEO4J_USERNAME` | `neo4j` | Local database user. |
| `NEO4J_PASSWORD` | `movement-graph-local-test` | Synthetic local password. It is rejected outside local/test environments. |
| `NEO4J_DATABASE` | `neo4j` | Database name. |

Set all credentials explicitly outside local development. Do not reuse the synthetic password.

### Restart and recovery

Restart the service without deleting its named volume, then verify the active pointer and historical revision:

```bash
docker compose restart neo4j
pnpm graph:inspect
pnpm graph:inspect -- --revision <revision-id>
```

If a stage fails, the prior active revision remains active. Fix the source manifest and rerun the dry run and stage. If activation returns `stale_revision`, inspect the current pointer and repeat only after deciding which prior revision you expect. If a client loses the activation response, inspect first; a same-target retry is idempotent and returns `already_active`.

No reset-all or prune command is provided. Recovery never requires deleting the database, active pointer, or historical revisions.

### Degraded-mode limits

If Neo4j is unavailable, canonical resolution, safety, substitution, and historical explanation fail closed. The in-memory fixture adapter may support deterministic demos or tests, but fixture authority cannot mark a movement allowed, reviewable, or safe. The current dashboard fixture is not proof that the graph is available and does not replace a pinned canonical read.

The service accepts only bounded, static graph reads. It does not accept model-authored Cypher, mix graph revisions, infer safety from an anatomy stress edge, invent ontology mappings, or guess substitutes when the reviewed set is empty.

See [the Movement and Clinical schema](./docs/graph/movement-clinical-schema.md) for every role, edge, safety consequence, walkthrough, boundary, and revision state. See [the ontology model](./docs/ontology-model.md) for the SNOMED CT, OPE, SKOS, PROV-O, release, and license rationale.

## Graph-controlled catalog safety

The catalog-safety boundary evaluates the complete catalog through bounded graph traversal at one authorized Member Context revision and one sealed Movement/Clinical revision. Injury decisions require a matching clinical rule plus the reviewed anatomy path; missing equipment and explicit reviewed-family exclusions are hard filters, while ordinary preferences only down-rank. Within this boundary, prompt text cannot authorize safety, and a model cannot supply Cypher, traversal bounds, or an allowed candidate.

Incomplete applicability, denied scope, unavailable or unsealed revisions, broken paths, mixed revisions, fixture authority, and incomplete or over-cap catalogs fail closed without a partial allowed set. Successful results carry both revision IDs and stable assertion/evidence paths, then remain behind a short-lived, server-owned evaluation token whose claims are re-authorized for candidate validation. Expired, superseded, revoked, explicitly invalidated, or locally absent sessions require a fresh evaluation and reveal no retained candidate classifications.

This workflow and all of its facts, rules, examples, and fixtures are synthetic take-home material. It is not clinically validated guidance and must not be used for diagnosis or care. See the [Movement and Clinical schema](./docs/graph/movement-clinical-schema.md#complete-catalog-safety-boundary) and [Member Context schema](./docs/graph/member-context-schema.md#workout-safety-constraint-projection) for traversal, provenance, redaction, and token-lifecycle details.
