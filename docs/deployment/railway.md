# Railway minimum demo

This is a small hosted demo, not a production deployment. It uses synthetic data, mock coach authentication, one Railway app replica, one supervised workout worker, and a single Neo4j Community service over Railway private networking. The private Bolt connection is plaintext inside the private network; production use should move to Neo4j TLS, real authentication, backups, and separate scalable worker infrastructure.

## Topology

Create two services in one Railway project and environment:

1. `app`: this repository, serving Next.js and the long-lived workout worker.
2. `neo4j`: Docker image `neo4j:2026.06.0-community`, with a Railway Volume mounted at `/data`.

Do not create a public Neo4j domain. The app connects to the database through the Neo4j service's `*.railway.internal` private domain on Bolt port `7687`. The checked-in [`railway.json`](../../railway.json) configures only the app service; Railway does not provision the database service or its volume from that file.

## Provisioning

Prerequisites are a Railway project, the Railway CLI, and access to the repository. The repository declares Node 24 and pnpm 11.9.0. Railway's Railpack build is `pnpm build`; the app start command is `pnpm railway:start`.

Create the Neo4j service from the Docker image and attach the volume before deploying the app. Configure the Neo4j service with:

```text
NEO4J_AUTH=neo4j/${{shared.NEO4J_PASSWORD}}
```

`NEO4J_AUTH` initializes a fresh database. It does not rotate the password on an existing `/data` volume. If the password or service target is wrong, stop and correct the configuration; do not delete the volume as a troubleshooting step.

Set one shared variable in the Railway environment:

```text
NEO4J_PASSWORD=<non-placeholder private demo password>
```

Then set these app-service variables. Replace `neo4j` with the actual Railway service namespace if the service has a different name.

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Keeps Next.js on its production server. |
| `AXON_RUNTIME_PROFILE` | `railway-demo` | Required for the hosted exception. |
| `NEO4J_ALLOW_INSECURE_RAILWAY` | `1` | Required in addition to the profile. |
| `NEO4J_PRIVATE_DOMAIN` | `${{neo4j.RAILWAY_PRIVATE_DOMAIN}}` | Must resolve to the exact private hostname. |
| `NEO4J_URI` | `bolt://${{NEO4J_PRIVATE_DOMAIN}}:7687` | Direct Bolt only; no URI credentials, path, or query. |
| `NEO4J_USERNAME` | `neo4j` | |
| `NEO4J_PASSWORD` | `${{shared.NEO4J_PASSWORD}}` | Never paste it into a command. |
| `NEO4J_DATABASE` | `neo4j` | |
| `WORKOUT_DEMO_MODE` | `deterministic` | No model-provider key is needed. |
| `WORKOUT_WORKER_ID` | `worker:railway-demo` | Keep one app replica. |
| `WORKOUT_ROUTE_SECRET` | generated 32-byte value | Use a secret manager/generator. |
| `COPILOT_SESSION_SECRET` | `${{WORKOUT_ROUTE_SECRET}}` | Must be the same 32-byte value. |
| `COPILOT_CONTINUATION_SECRET` | different generated 32-byte value | Must differ from the session secret. |

Do not configure provider keys, `WORKOUT_TEST_BYPASS`, `WORKOUT_LOCAL_COACH_ID`, `WORKOUT_LOCAL_MEMBER_IDS`, `COPILOT_LOCAL_COACH_ID`, or `COPILOT_LOCAL_MEMBER_IDS`. The supervisor rejects those public-demo overrides and never prints secret values.

Deploy Neo4j first and wait for the service to run, then deploy the app. Railway does not provide a Compose-style `depends_on` relationship here; the worker has bounded restart behavior while Neo4j finishes starting, and repeated failure makes the app deployment unhealthy.

## Seed from inside Railway

Private DNS is a runtime concern. Run all database commands through an SSH session in the app service, not from a laptop and not as a build/pre-deploy command. Set the service/project context in the Railway CLI, then use the equivalent of:

```bash
railway ssh --service app -- pnpm graph:seed:member -- --dry-run
railway ssh --service app -- pnpm graph:seed -- --dry-run
```

Record the dry-run `contextRevisionId`, `canonicalDigest`, node/relationship counts for each of the three members, and the movement `graphRevisionId`, canonical digest, and node/edge counts. The expected synthetic member IDs are:

```text
mbr_01HX9JORDAN
mbr_02HX9AVERY
mbr_03HX9MORGAN
```

Inspect active pointers before any activation:

```bash
railway ssh --service app -- pnpm graph:inspect
railway ssh --service app -- pnpm graph:seed:member -- --inspect
```

For Movement, stage and validate the candidate without activation. The result must be sealed and its digest/counts must match the dry-run:

```bash
railway ssh --service app -- pnpm graph:seed
```

Activate it only after comparing the recorded active revision. On a fresh database, the predecessor is `null`; otherwise pass the exact inspected active ID:

```bash
railway ssh --service app -- pnpm graph:seed -- \
  --activate --expected-prior <recorded-movement-active-or-null> \
  --actor curator:railway-demo
```

For Member Context, stage/validate each tracked fixture first. The `--stage` command does not change the active pointer and returns the seal, digest, and counts. Then activate each member separately with its own compare-and-swap predecessor:

```bash
railway ssh --service app -- pnpm graph:seed:member -- --stage --member jordan
railway ssh --service app -- pnpm graph:seed:member -- --stage --member avery
railway ssh --service app -- pnpm graph:seed:member -- --stage --member morgan

railway ssh --service app -- pnpm graph:seed:member -- \
  --member jordan --expected-active <jordan-active-or-none>
railway ssh --service app -- pnpm graph:seed:member -- \
  --member avery --expected-active <avery-active-or-none>
railway ssh --service app -- pnpm graph:seed:member -- \
  --member morgan --expected-active <morgan-active-or-none>
```

The activation command stages idempotently, validates the canonical read-back, and then performs the explicit CAS activation. Stop on the first failure. A stale predecessor must fail closed and leave the prior active pointer unchanged. Never use a batch command with an inferred moving predecessor when you are replacing a non-empty database.

After activation, inspect again and require every active pointer to target a sealed revision with matching canonical digest and counts. Repeat the same-target seed once to prove idempotence. These commands never delete or reset data.

## Demo-ready smoke checklist

`/api/session` is only a web liveness check. A 200 response does not mean the seeded demo is ready.

- [ ] The app deployment is healthy at `/api/session`.
- [ ] Neo4j is running privately on Bolt `7687`, with the Railway Volume mounted at `/data`.
- [ ] SSH from the app resolves the exact `NEO4J_PRIVATE_DOMAIN` and authenticates with the configured credentials.
- [ ] Movement and all three Member Context active pointers are sealed, with expected IDs, digests, and counts.
- [ ] Worker logs contain `ready` and `polling`; there is no restart loop or `retry-exhausted` signal.
- [ ] Mock sign-in works with the default demo coach and all three synthetic members are visible.
- [ ] One deterministic workout reaches a terminal result.
- [ ] Copilot quick prompts return graph-backed responses with citations.
- [ ] Repeating a same-target seed is idempotent; a stale expected predecessor is rejected.

Only after all of these pass should the public URL be shared with a reviewer.

## Persistence and recovery check

Restart the Neo4j service without deleting `/data`, then run the inspect commands again over SSH. Active revision IDs, seals, digests, counts, and graph reads must remain available. Restart/redeploy the app with a synthetic queued or running workout and confirm the worker reclaims the lease once, reaches one terminal result, and cannot mutate through a stale fence.

App rollback and graph rollback are separate operations. Restore the previous app deployment/config first. For graph rollback, inspect the last-known-good sealed revision, record the current active ID, and activate the known-good revision using that current ID as the expected predecessor. Do not treat a Railway app rollback as a Neo4j rollback. Loss of the `/data` volume is data loss outside this demo's recovery guarantee.

## Boundaries

This profile deliberately omits TLS for private Bolt, real authentication, PHI, provider-backed generation, public Neo4j access, HA, backups, multi-replica worker scaling, and automated migrations. Keep one app replica: scaling the combined web/worker service would create duplicate queue consumers. For a real deployment, split the worker, use TLS or Neo4j Aura, add real auth and secret rotation, add backups/observability, and load-test the queue semantics.

Useful references: [Railway config as code](https://docs.railway.com/config-as-code/reference), [Railway private networking](https://docs.railway.com/networking/private-networking), [Railway SSH](https://docs.railway.com/cli/ssh), [Railway pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command), and [Neo4j Docker persistence](https://neo4j.com/docs/operations-manual/current/docker/introduction/).
