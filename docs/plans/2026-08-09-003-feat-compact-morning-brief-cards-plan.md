---
title: "feat: Compact morning brief cards"
type: feat
date: 2026-08-09
topic: compact-morning-brief-cards
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
origin: docs/plans/2026-08-09-002-feat-concise-copilot-ui-plan.md
---

# feat: Compact morning brief cards

## Goal Capsule

- **Objective:** Make the selected-athlete Today morning brief digestible at a glance, with supporting evidence available only when the coach asks for it.
- **Authority:** The user request defines the compact-first outcome. The existing concise Copilot plan and loaded `CopilotAnswerPacket` define the presentation and trust boundaries.
- **Active scope:** The Today morning-brief answer card, its progressive disclosures, focused browser coverage, and production deployment verification.
- **Execution profile:** Lightweight UI follow-up over the existing presentation projection and native disclosure components.
- **Stop conditions:** Do not change Copilot contracts, retrieval, graph data, model output, the full Copilot workbench, the immutable Insight view, or Today citation navigation.
- **Tail ownership:** The executor owns implementation, tests, review, delivery, deployment to the configured Railway environment, and post-deploy smoke verification.
- **Open blockers:** None.

## Product Contract

### Summary

The Today morning brief becomes a compact decision card. It shows freshness, the primary brief or truthful limitation, the supported headline risk, and the next action first. Facts, trends, churn reasoning, sources, and exact revision details remain reachable through labeled, initially closed disclosures.

### Problem Frame

Today currently passes the morning brief through a legacy compact mode that only hides the chart. Every section, churn reason, citation, and revision identifier still renders with equal weight, so a coach must read a machine-shaped evidence packet before finding the decision.

The full Copilot route already solves this problem with a lossless packet projection and native progressive disclosure. Today should adopt that hierarchy without creating a second summary authority or changing the loaded packet.

### Requirements

- R1. The default Today card shows the brief freshness, primary brief or limitation, supported headline risk, and next action when present.
- R2. Facts, stable context, trends, charts, full churn reasoning, citations, and revision metadata start hidden behind content-aware disclosures.
- R3. Every loaded clause, chart, churn reason, citation, and revision reference remains reachable without a new request or packet mutation.
- R4. Empty disclosures are omitted, and sparse, pending, stale, unsupported, unavailable, and error outcomes remain truthful. When a ready brief is retained during a refresh, keep its original freshness visible, add an explicit updating state, and retain it with the typed failure plus an allowed retry if replacement fails.
- R5. The card uses native disclosure semantics, visible focus, 44px targets, existing AXON tokens, and wrapping that works at 320px, 430px, and 1440px.
- R6. The full Copilot workbench and immutable Insight output do not change. Today citations remain read-only chips because Today does not own the supporting-context route handoff.
- R7. After local verification, create one reviewed release checkpoint, record its commit SHA, and deploy that exact revision to the configured Railway production environment. Verify the hosted brief flow without reseeding unchanged graph data.

### Key Flows

- F1. **Scan the brief:** The coach opens an athlete from Today and understands the summary, freshness, risk signal, and next action without expanding detail.
- F2. **Inspect evidence:** The coach opens one or more labeled disclosures and reads the exact loaded facts, trend, risk reasoning, sources, and revision data.
- F3. **Handle sparse or degraded data:** The card shows the available limitation or status and renders no empty disclosure controls.
- F4. **Use the hosted result:** After deployment, the coach opens the configured Railway app and completes the same collapsed-to-expanded brief flow.

### Acceptance Examples

- AE1. **Rich brief is concise by default.** Given a brief with repeated facts, trend data, churn, citations, and revision metadata, the default card shows only the primary coaching layer and closed disclosure summaries.
- AE2. **Detail stays complete and local.** Opening every content-bearing disclosure, including additional context, reveals the existing packet content and does not issue another Copilot, conversation, or graph request.
- AE3. **Sparse brief stays honest.** A limitation-only or partial packet shows its limitation and creates only content-bearing disclosures.
- AE4. **Disclosure is accessible and responsive.** Keyboard and assistive-technology users can open and close each group, and long evidence labels wrap without horizontal overflow at supported widths.
- AE5. **Production reflects the compact brief.** The deployed Today view loads the selected athlete's brief with closed detail groups and reveals the evidence when expanded.

### Success Criteria

- The default Today brief is materially shorter than the fully expanded packet and communicates the coach's decision layer without scrolling through provenance.
- Exact evidence remains available on demand, with no network activity caused by disclosure toggles.
- Existing Copilot, Insight, pending, error, citation, and revision behavior does not regress.
- Focused tests, production build, and post-deploy smoke checks pass.

### Scope Boundaries

**Included**

- The selected-athlete Today morning-brief card.
- Reuse of the existing packet presentation projection and native disclosure renderer.
- Focused unit/browser/accessibility/responsive/visual proof and Railway deployment verification.

**Deferred to Follow-Up Work**

- Persisted disclosure preferences, coach-configurable default groups, and server- or model-generated summaries.
- A separate density pass for immutable Insight detail.

**Outside this plan**

- Packet, prompt, model, retrieval, graph, voice, workout, authentication, or persistence changes.
- New source-navigation behavior from Today or graph reseeding for an unchanged UI-only release.

## Assumptions

- Reuse the existing concise Copilot hierarchy instead of introducing a second card design.
- Keep the packet's first meaningful morning-brief section as primary copy; do not paraphrase or deduplicate source claims.
- Preserve freshness, limitation, supported headline risk, and next action outside disclosures because they affect safe interpretation.
- Keep Today citations non-interactive. The full Copilot route remains the evidence-navigation surface.
- The current feature branch contains adjacent graph and deployment work. Patch only the narrow brief surfaces, preserve existing edits, and audit every changed path before release. Map each non-brief change to an existing plan and completed verification gate; exclude or defer anything that cannot be verified as part of the release checkpoint.
- The configured Railway environment is a synthetic hosted demo even when its environment is named production. Do not describe it as a production-ready clinical system.

## Planning Contract

### Key Technical Decisions

- KTD1. **Reuse the existing packet projection.** `buildCopilotAnswerViewModel` already separates primary content from facts, trend, risk, sources, and additional context without losing packet identity.
- KTD2. **Use the existing native disclosure renderer on Today.** This keeps toggles local, keyboard-accessible, and consistent with the full Copilot workbench.
- KTD3. **Keep trust-critical context visible.** Freshness, limitations, derived headline risk, and next action stay in the primary layer; verbose reasons and exact provenance move behind disclosures.
- KTD4. **Preserve surface boundaries.** The change opts in only the Today brief call site. The full workbench retains citation navigation, and Insight retains its immutable full-detail presentation.
- KTD5. **Verify density as behavior, not only appearance.** Browser tests prove initial visibility, disclosure completeness, no request on toggle, keyboard semantics, and overflow before visual snapshots are accepted.
- KTD6. **Keep the shared projection backward-compatible.** If the packet projection needs a change, make it additive only and prove that the full Copilot route retains its current primary content and disclosure composition.
- KTD7. **Release an immutable reviewed artifact.** Audit the complete worktree, run gates against the exact release checkpoint, deploy its recorded SHA, and keep the prior healthy Railway deployment available for rollback.

### Sequencing

U1 applies the existing progressive hierarchy to Today and proves the packet behavior. U2 verifies accessibility, supported widths, visual density, and the hosted release path.

### Sources & Research

- `docs/plans/2026-08-09-002-feat-concise-copilot-ui-plan.md` — existing concise Copilot projection and the explicit deferred Today follow-up.
- `src/features/coach-dashboard/copilot-view-model.ts` — pure packet-to-primary/disclosure projection with rich and sparse coverage.
- `src/features/coach-dashboard/CoachDashboard.tsx` — Today legacy compact call site and shared progressive answer renderer.
- `src/features/coach-dashboard/dashboard.module.css` — existing AXON card, disclosure, focus, and wrapping styles.
- `tests/e2e/copilot-grounding.spec.ts` — intercepted packet and no-refetch disclosure patterns.
- `tests/e2e/coach-dashboard-accessibility.spec.ts` and `tests/e2e/coach-dashboard-responsive.spec.ts` — existing keyboard, Axe, reduced-motion, and viewport proof.
- `tests/visual/coach-dashboard-desktop.spec.ts` and `tests/visual/coach-dashboard-mobile.spec.ts` — dashboard snapshot conventions.
- `docs/deployment/railway.md` and `railway.json` — configured hosted-demo deployment and smoke boundaries.
- No `docs/solutions/` corpus exists. Current repository patterns are authoritative for this plan.

## Implementation Units

### U1. Make the Today brief progressive

**Goal:** Replace the legacy dense compact output with the existing concise primary-and-disclosure hierarchy while preserving every packet detail.

**Requirements:** R1-R4, R6; F1-F3; AE1-AE3; KTD1-KTD4.

**Dependencies:** None.

**Files:**

- `src/features/coach-dashboard/CoachDashboard.tsx` — opt the Today morning brief into the shared progressive presentation.
- `src/features/coach-dashboard/dashboard.module.css` — change only if a Today-specific focus, target-size, or responsive correction is required.
- `tests/e2e/copilot-grounding.spec.ts` — prove default visibility, disclosure completeness, and no request on toggle.
- `tests/unit/copilot-view-model.test.ts` — change only if implementation introduces new projection behavior; otherwise use the existing rich and sparse coverage unchanged.

**Approach:**

1. Use the existing answer projection for the selected morning-brief packet.
2. Render its primary section, freshness, headline risk, and next action before closed, content-bearing detail groups.
3. Preserve all existing facts, charts, churn distinctions, citations, revision references, and degraded outcomes.
4. Keep the change at the Today call site or an equally narrow shared seam. Do not alter Copilot request state or supporting-context navigation.

**Execution note:** Start with an assertion for the intended concise default that fails against the current dense Today rendering, then make the existing progressive hierarchy satisfy it.

**Patterns to follow:** `CopilotWorkbenchAnswerCard`, `CopilotDisclosure`, `buildCopilotAnswerViewModel`, and the full-route assertions in `tests/e2e/copilot-grounding.spec.ts`.

**Test scenarios:**

- Covers F1 / AE1. A rich morning brief shows freshness, primary coaching copy, derived risk level, and next action while facts, reasons, sources, and revision text are hidden.
- Covers F2 / AE2. Opening facts, trend, risk, sources, and additional context exposes every exact loaded clause and keeps the intercepted request count unchanged.
- Covers F2 / AE2. The trend disclosure exposes its chart without changing the full Copilot route's primary content or disclosure composition.
- Covers F3 / AE3. A sparse or limitation-only packet shows truthful primary content and omits empty disclosure summaries.
- Covers R4. A retained ready brief keeps its original freshness and shows a visible updating state while replacement is pending; on failure it remains visible beside the typed failure and allowed retry control.
- The full Copilot route still exposes revision-pinned citation actions, while Today citations remain read-only chips.
- The immutable Insight route retains its current full-detail output.

**Verification:** The Today card is concise by default, complete when expanded, and produces no packet, route, or request-contract diff.

### U2. Prove responsive, accessible, and deployed behavior

**Goal:** Validate the collapsed and expanded Today brief across supported interaction modes and deliver the verified working tree to the configured Railway environment.

**Requirements:** R5-R7; F1-F4; AE4-AE5; KTD5.

**Dependencies:** U1.

**Files:**

- `tests/e2e/coach-dashboard-accessibility.spec.ts` — add Today disclosure keyboard, focus, semantics, and Axe coverage.
- `tests/e2e/coach-dashboard-responsive.spec.ts` — cover collapsed and expanded Today briefs at 320px, 430px, and 1440px.
- `tests/visual/coach-dashboard-desktop.spec.ts` — update or add the selected-athlete Today default and expanded snapshots.
- `tests/visual/coach-dashboard-mobile.spec.ts` — update or add the selected-athlete Today default and expanded snapshots.
- `tests/visual/coach-dashboard-desktop.spec.ts-snapshots/` — update only snapshots affected by the brief hierarchy.
- `tests/visual/coach-dashboard-mobile.spec.ts-snapshots/` — update only snapshots affected by the brief hierarchy.

**Approach:**

1. Exercise native summaries by keyboard in both closed and open states and retain visible focus.
2. Check the card and disclosures for horizontal overflow with long labels at every supported width.
3. Capture deterministic collapsed and expanded visual states with existing AXON snapshots.
4. Run focused and repository-wide quality gates, then audit every changed path and create a reviewed release checkpoint that contains only intended, verified work.
5. Record the active sealed Movement and Member Context revisions, digests, and counts before deployment. Deploy the exact reviewed commit to the configured Railway production environment without reseeding when those active graph inputs remain healthy.
6. Confirm the deployment reports the recorded commit, re-check the active graph revisions, and verify app health plus the selected-athlete brief flow on the hosted URL.
7. If health, graph readiness, or the hosted brief flow fails, roll Railway back to the immediately previous healthy deployment or configuration and repeat the liveness and hosted-flow checks. Do not reseed or roll back graph data as part of this UI rollback.

**Execution note:** Treat this as UI and release work; prefer focused browser proof first, then the full production build and hosted smoke check.

**Patterns to follow:** Existing `@a11y`, responsive overflow, visual snapshot, Railway healthcheck, and hosted-demo smoke conventions.

**Test scenarios:**

- Covers F1-F2 / AE4. Enter and Space toggle each summary, focus stays visible, closed content is excluded from view, and expanded content remains readable.
- Covers AE4. At the 320px viewport, each disclosure summary has a measured interactive box of at least 44 by 44 CSS pixels.
- Covers AE4. Axe reports no violations in collapsed and expanded states.
- Covers AE4. At 320px, 430px, and 1440px, long chart, source, and revision content wraps without document or card overflow.
- Visual regression shows a shorter default brief while the expanded state preserves the complete evidence hierarchy.
- Covers F4 / AE5. The deployed app healthcheck succeeds, the selected athlete opens, the Today brief starts collapsed, and an evidence disclosure expands successfully.

**Verification:** Local browser and build gates pass, the deployment becomes healthy, and the hosted UI demonstrates the same compact-to-detailed flow.

## Verification Contract

| Gate | Scope | Completion signal |
| --- | --- | --- |
| Focused Vitest | Existing packet projection | Rich, sparse, and content-bearing group tests remain green. |
| Focused Playwright | Today brief, Copilot, accessibility, responsive, and visual paths | Default content is concise, detail is complete, toggles are local, and supported widths do not overflow. |
| `pnpm lint` | Changed feature and test files | No lint errors or new suppressions. |
| `pnpm typecheck` | Shared presentation seam and tests | No type errors or contract changes. |
| `pnpm test` | Repository unit regressions | Unit suite passes. |
| `pnpm build` | Production bundle and isolation check | Build succeeds with the existing Railway entrypoint. |
| Release scope audit | Complete worktree and release checkpoint | Every changed path is mapped to intended work and a verification owner; gates pass on the recorded commit SHA. |
| Graph readiness | Active sealed Movement and Member Context snapshots | Pre- and post-deploy revisions, digests, and counts remain healthy and unchanged unless an independently verified data release is explicitly included. |
| Railway deployment | Exact reviewed commit in the configured production environment | Deployment reports the recorded SHA, is healthy at `/api/session`, and no worker restart exhaustion appears. |
| Hosted browser smoke | Selected athlete Today brief | Primary layer is visible, detail starts closed, and one disclosure expands without an error. |
| Rollback drill | Previous healthy Railway deployment | On any failed release gate, rollback restores liveness and the hosted brief flow without graph data mutation. |

## Operational Notes

- Deploy only after local verification, code review, worktree scope audit, and release-checkpoint creation pass.
- Use the repository's existing linked Railway project and production environment. Do not create or reconfigure services for the brief change.
- Treat adjacent graph or deployment edits as separate release scope: include them only when they map to an existing plan, have an explicit verification owner, and do not invalidate the no-reseed assumption.
- Do not reseed Movement or Member Context data when the active revisions are healthy and unchanged. If the audited release requires a graph data contract change, stop the deployment rather than guessing at a destructive migration.
- Treat `/api/session` as web liveness, then verify the actual brief flow in the browser before calling the release complete.
- Keep the immediately previous healthy Railway deployment as the rollback target until post-deploy graph and browser checks pass.
- Preserve the deployment runbook's synthetic-demo boundary in all handoff language.

## Definition of Done

- R1-R7, F1-F4, AE1-AE5, and all Success Criteria are satisfied.
- U1 renders the Today morning brief as a concise primary card with complete, initially closed supporting disclosures.
- U2 proves keyboard, Axe, responsive, visual, build, deployment, and hosted-flow behavior.
- No answer clause, chart, churn reason, citation, or revision reference is deleted or fabricated.
- No Copilot, graph, model, voice, workout, persistence, or authentication contract changes.
- Existing worktree changes are preserved; every released path is mapped to intended, verified work, and the final diff contains no abandoned brief prototype or duplicate disclosure renderer.
- The configured Railway deployment reports the reviewed release SHA, is healthy, preserves active graph readiness, and demonstrates progressive disclosure in the hosted Today brief.
