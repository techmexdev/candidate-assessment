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

1. **Workout Generator** — a prompt + time form that calls an agentic runtime and renders a structured workout. It reasons over a **movement/clinical knowledge graph** (grounded in ontologies like OPE, COPPER, SNOMED CT, PROV-O, SKOS) to keep recommendations injury-aware, equipment-aware, and explainable.
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
