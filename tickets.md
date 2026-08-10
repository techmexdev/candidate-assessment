# Tickets: Bounded Copilot decision briefs

Build a scan-first Copilot decision layer while preserving complete, revision-bound evidence on demand. Source: `.scratch/copilot-decision-brief/PRD.md`.

Work the **frontier**: any ticket whose blockers are all done. This set is a linear chain, so work top to bottom.

## Replace the churn-risk text wall with a decision brief

**What to build:** When a coach opens a rich churn-risk answer, show the derived signal, one supported human-readable reason, and one next action before any evidence. Preserve the original answer statements in an initially closed Full analysis disclosure so the result is concise without losing auditability.

**Blocked by:** None — can start immediately.

- [x] A rich churn-risk result renders no more than three primary decision blocks.
- [x] Raw adherence rows, workout rows, message transcripts, unsupported-source explanations, locators, and revision IDs are hidden by default.
- [x] Full analysis starts closed and reveals every omitted original answer clause in original order.
- [x] Unsupported source reasons never become the default “why”; if no supported human-readable reason exists, the block is omitted.
- [x] Opening Full analysis does not issue a Copilot, graph, or conversation request.

## Apply the bounded decision rule to every workbench intent

**What to build:** Make the shared workbench projection deterministic across morning briefs, chart-backed answers, fallback answers, and limitation/degraded states so Today and Copilot use one compact hierarchy rather than separate summary systems.

**Blocked by:** Replace the churn-risk text wall with a decision brief.

- [x] Morning briefs show only the highest-priority task by default and expose remaining tasks on demand.
- [x] Chart-backed answers show a compact supported value or direction while the complete chart remains in its disclosure.
- [x] Other ready intents show at most one meaningful answer clause and one action; remaining clauses are recoverable in Full analysis.
- [x] Limitation, stale, unsupported, unavailable, pending, retained-answer, retry, and refresh states remain truthful and visible.
- [x] Every source clause is represented in the decision layer or assigned to a disclosure, with empty groups omitted.
- [x] Previous results remain collapsed and revision-pinned citation navigation keeps its current behavior.

## Prove compactness, accessibility, and responsive behavior

**What to build:** Demonstrate that the bounded decision brief is materially shorter by default, complete when expanded, keyboard-accessible, and usable at all supported widths.

**Blocked by:** Apply the bounded decision rule to every workbench intent.

- [x] Browser acceptance covers visible and hidden default content, complete expansion, and no request on disclosure toggles.
- [x] Enter and Space operate each native disclosure, focus remains visible, and Axe reports no violations when collapsed or expanded.
- [x] At 320px, 430px, and 1440px, the card does not overflow and expanded evidence wraps inside the surface.
- [x] Disclosure controls retain at least 44 by 44 CSS-pixel hit areas.
- [x] Desktop and mobile default/expanded visual snapshots make the density change reviewable.
- [x] Typechecking, focused tests, the full test suite, lint, and production build pass.
