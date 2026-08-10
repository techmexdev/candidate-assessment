# Accepted release residuals

Review run: `20260809-190708-3c5f3c5b`

Release branch: `codex/copy-first-axon-ui`

## Railway readiness ignores worker availability

- Severity: P1
- Location: `scripts/run-railway-demo.ts:223`
- Review finding: #3
- Status: accepted for the synthetic hosted demo release

Railway probes `/api/session`, which proves that the Next.js web child is live. It does not prove that the supervised workout worker has completed a graph poll. Making the endpoint worker-aware requires a new cross-process readiness signal.

This release keeps web liveness separate so the demo remains browsable when the worker is degraded. The supervisor logs worker degradation, the deployment runbook verifies graph state independently, and the release smoke exercises the real graph-backed Morning Brief flow. A future production hardening pass should add explicit worker readiness without turning a recoverable worker outage into a full web outage.

## Release boundary

The hosted target uses mock coach sessions and synthetic member data. This accepted residual does not authorize use with real member data or production authentication.
