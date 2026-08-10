# Spec: Bounded Copilot decision briefs

Status: ready-for-agent

Type: feature

## Problem Statement

The Copilot workbench is still too dense to use as a morning decision surface. Progressive disclosure was added around facts, trends, risk reasoning, and sources, but the primary `Summary` remains unbounded. A rich answer can therefore place adherence history, workout history, risk reasons, unsupported-source caveats, member messages, and coach messages above the actual risk signal and next action.

From the coach's perspective, this is still an evidence dump. The coach must read a large block of equally weighted text before learning what changed, why it matters, and what to do next. Raw field labels such as `weekly-workout-completion` and repeated `Source-provided supported risk reason` copy make the surface feel machine-shaped. The first viewport is dominated by evidence even though evidence is supposed to be available on demand.

The current presentation also duplicates meaning. A churn-risk answer can describe risk throughout the summary and then repeat the risk signal and next action below it. Hiding only the secondary sections does not solve the problem while the primary section can contain an arbitrary number of clauses.

## Solution

Turn every ready Copilot result into a bounded decision brief. The default card answers only three questions:

1. **What is the signal?** Show the supported headline state or a truthful limitation.
2. **Why does it matter?** Show at most one concise, human-readable, evidence-backed reason.
3. **What should the coach do next?** Show at most one action.

The default decision layer must contain no more than three content blocks and no unbounded clause list. It must not show raw packet field names, repeated history rows, message transcripts, source locators, revision identifiers, unsupported-source explanations, or the complete generated answer.

The full original answer remains losslessly available in a new, initially closed **Full analysis** disclosure. Existing facts, trend/chart, risk reasoning, and sources/revision disclosures remain independently available and initially closed. Opening any disclosure operates only on the already-loaded answer packet and never issues another request.

The concise decision layer is deterministic and uses existing structured packet semantics rather than asking a model to summarize itself:

- For churn risk, lead with the derived risk level, then the first supported human-readable source reason when present, then the first next action.
- For a morning brief, show the highest-priority morning task, indicate the count of additional tasks without rendering them, and show the first next action when distinct.
- For chart-backed adherence or sleep answers, show the latest supported value or direction available from the chart projection, then the first next action.
- For a limitation or degraded answer, show the truthful limitation/status instead of a confident decision brief.
- For any other ready intent, show only the first meaningful answer clause and the first next-action clause. Move all remaining clauses to Full analysis.

The intended churn-risk card reads conceptually like this:

> **Elevated**  
> Adherence fell 100% → 50% over two weeks.  
> Review the missed-session pattern with the member.  
> Full analysis · 16 statements  
> Trend and chart · 4 weeks  
> Risk reasoning · 2 reasons  
> Sources · 9 references

This example communicates hierarchy, not prescribed final copy. The implementation must use the packet's existing grounded values and supported language.

## User Stories

1. As a coach, I want to understand the main signal in a few seconds, so that I can decide which member needs attention first.
2. As a coach, I want the risk level to appear before supporting history, so that the conclusion is not buried below evidence.
3. As a coach, I want to see one supported reason for the signal, so that the conclusion is useful without becoming a text wall.
4. As a coach, I want to see one next action, so that the answer leads directly to a coaching decision.
5. As a coach, I want the default answer to contain no more than three content blocks, so that it remains scannable.
6. As a coach, I want repeated adherence readings collapsed by default, so that a timeline does not compete with the current signal.
7. As a coach, I want workout completion history collapsed by default, so that past sessions do not overwhelm today's decision.
8. As a coach, I want member and coach message transcripts collapsed by default, so that conversation evidence appears only when I need context.
9. As a coach, I want raw source locators and revision identifiers hidden by default, so that provenance does not dominate the reading surface.
10. As a coach, I want unsupported-source caveats available but not promoted into the headline, so that the default view stays concise and trustworthy.
11. As a coach, I want a Full analysis disclosure, so that I can recover every original answer statement when needed.
12. As a coach, I want Full analysis to preserve the original statement order, so that expanding it does not alter the packet's meaning.
13. As a coach, I want facts, trends, risk reasoning, and sources to remain separate disclosures, so that I can open only the kind of evidence I need.
14. As a coach, I want disclosure labels to describe their contents and useful counts, so that I can choose whether expanding them is worthwhile.
15. As a coach, I want the card to avoid generic machine labels such as `Summary`, so that the hierarchy reads like a coaching brief.
16. As a coach, I want percentages and changes rendered in compact human form such as `100% → 50%`, so that I can recognize the trend faster.
17. As a coach, I want the member's name used in human-facing copy when the packet supports it, so that the action feels specific rather than generic.
18. As a coach, I want a morning brief to show only its highest-priority task by default, so that multiple tasks do not recreate the same density problem.
19. As a coach, I want to know that more morning tasks exist without reading them immediately, so that important work is not silently discarded.
20. As a coach, I want chart-backed answers to expose the latest value or direction without rendering the complete chart, so that the decision layer remains compact.
21. As a coach, I want sparse answers to remain useful, so that the UI does not create empty placeholders when little evidence exists.
22. As a coach, I want limitation-only answers to state the limitation plainly, so that missing evidence cannot look like a confident recommendation.
23. As a coach, I want stale, unavailable, unsupported, pending, and failed outcomes to remain explicit, so that brevity never hides degraded state.
24. As a coach, I want a retained prior answer to keep its original freshness while an update runs, so that I do not mistake old evidence for new evidence.
25. As a coach, I want retry and refresh controls to remain visible when allowed, so that the concise layout does not hide recovery actions.
26. As a coach, I want opening a disclosure to be immediate, so that inspecting already-loaded evidence does not create another loading cycle.
27. As a coach, I want disclosure state to stay local to the answer, so that expanding evidence does not change the member, revision, or request.
28. As a keyboard user, I want every disclosure reachable and operable with Enter and Space, so that evidence inspection does not require a pointer.
29. As a keyboard user, I want focus to remain on the disclosure control after toggling it, so that I do not lose my place.
30. As a screen-reader user, I want the decision brief and disclosure states announced with native semantics, so that the compact hierarchy is understandable non-visually.
31. As a coach using a narrow screen, I want long evidence and source strings to wrap inside expanded sections, so that the page never scrolls horizontally.
32. As a coach using a desktop screen, I want the complete default decision layer and its disclosure rows visible without scrolling through the answer body, so that the result functions as a brief.
33. As a coach, I want previous Copilot results to remain collapsed behind Previous results, so that only the newest decision competes for attention.
34. As a coach, I want cited conversation context to remain revision-pinned, so that opening supporting material preserves the answer's trust boundary.
35. As a reviewer, I want the complete packet to remain reachable, so that concision does not weaken auditability.
36. As a reviewer, I want default and expanded visual proofs at desktop and mobile widths, so that the density improvement is directly reviewable.
37. As a product owner, I want the same bounded decision rule applied by the shared workbench projection, so that Today and Copilot do not drift into separate summary systems.
38. As a product owner, I want the change confined to presentation, so that graph retrieval, model behavior, and answer contracts remain stable.
39. As an engineer, I want deterministic intent-specific preview rules, so that the same packet always produces the same default brief.
40. As an engineer, I want every omitted primary clause accounted for in Full analysis, so that no content is accidentally lost during projection.
41. As an engineer, I want unsupported source reasons excluded from the default “why,” so that a concise card cannot elevate untrusted evidence.
42. As an engineer, I want empty disclosures omitted, so that the compact card contains no dead-end controls.
43. As an engineer, I want disclosure toggles to create no Copilot, graph, or conversation requests, so that presentation state stays separate from retrieval state.
44. As an engineer, I want the projection tested against rich, sparse, limitation-only, and multi-answer packets, so that the bounded layout holds across packet shapes.

## Implementation Decisions

- Keep the existing answer packet immutable and authoritative. Do not change the Copilot API, retrieval recipes, graph reads, prompt behavior, or packet schema for this feature.
- Correct the shared Copilot presentation projection rather than introducing a page-specific truncation. Both the full workbench and the Today brief should consume the same bounded decision model when they use workbench presentation.
- Add an explicit decision-layer projection with separate fields for headline signal/limitation, one supported reason or compact metric, one action, and omitted primary sections.
- Treat three primary content blocks as a hard structural ceiling. A block may wrap naturally, but the renderer may not map an arbitrary clause array into the default surface.
- Use deterministic intent-specific precedence. Churn risk uses derived level plus the first supported human-readable reason; morning brief uses the highest-priority task; chart-backed intents use existing chart projection values; other intents use the first meaningful answer clause.
- Never use unsupported source reasons as the concise “why.” If no supported human-readable reason exists, omit that block instead of displaying a machine reason code or inventing prose.
- Show only the first next-action clause in the decision layer. Preserve any additional action clauses in Full analysis.
- Add a Full analysis presentation group containing every original primary clause that is not represented verbatim in the decision layer. Preserve section identity, clause order, evidence IDs, and packet binding.
- Keep limitations and degraded states outside disclosures when they affect safe interpretation. A limitation may replace the normal decision layer.
- Keep freshness, pending/update state, retained-answer state, retry, refresh, pin, and existing context-navigation controls visible under their current rules.
- Keep facts, trend/chart, risk reasoning, sources/revision, additional context, and previous results as independent native disclosures. Full analysis is an additional content-bearing group, not a replacement for those groups.
- Replace generic item counts with useful domain counts when the information is available, such as statements, weeks, reasons, messages, and references. Fall back to items only when no honest domain unit exists.
- Use the AXON content hierarchy: human-facing sentence case for decision copy, compact numerical notation for changes, and the system/data register only for provenance inside expanded detail.
- Do not rely on visual line clamping as the only hiding mechanism. Content removed from the default decision layer must live inside an operable disclosure and must not be exposed as a visually hidden default text wall.
- Disclosure expansion remains local browser state over already-loaded content. It does not fetch, refresh, mutate, pin, or reproject the answer.
- Keep the existing revision-pinned supporting-context handoff for eligible citations on the full Copilot route. Today retains its current read-only citation behavior.
- Omit empty groups and avoid duplicated clauses across the default decision layer and Full analysis unless the duplicate is required to preserve a trust-critical limitation.
- Preserve the synthetic-demo boundary and existing human-in-the-loop language. The assistant reports; the coach decides.

## Testing Decisions

- The primary acceptance seam is the existing browser-rendered Copilot workbench fed a deterministic rich answer packet. This is the highest useful seam because the failure is the amount and hierarchy of text a coach actually sees, not an isolated helper implementation.
- A good test asserts external behavior: which grounded statements are visible by default, which are hidden, the maximum number of decision blocks, the disclosure labels and states, exact content after expansion, request counts, focus behavior, and overflow. Tests should not assert internal React component structure beyond stable accessibility roles and established test identifiers.
- The rich churn-risk browser case must prove that the default card shows the risk signal, one supported reason, and one next action while raw adherence rows, workout rows, message transcripts, unsupported-source copy, locators, and revision IDs are not visible.
- The same case must prove that Full analysis starts closed, exposes every omitted original answer clause in original order when opened, and does not issue a Copilot, graph, or conversation request.
- A morning-brief browser case must prove that only the highest-priority task is visible by default, an additional-task count is available, and remaining tasks are recoverable on demand.
- A chart-backed case must prove that the concise metric is visible while the complete chart and text summary remain in the Trend and chart disclosure.
- Sparse and limitation-only cases must prove that no empty decision or disclosure regions appear and that limitations remain visible.
- Pending, retained-ready, failed, stale, unsupported, unavailable, retry, and refresh cases must retain their existing truthful status and controls.
- A multi-answer case must prove that only the newest answer is primary and earlier answers remain under Previous results.
- Accessibility coverage must use the existing native disclosure test pattern: keyboard focus, Enter/Space toggle, focus retention, collapsed/expanded semantics, and Axe checks in both states.
- Responsive coverage must reuse the existing 320px, 430px, and 1440px matrix. The default card must not overflow, long expanded evidence must wrap, disclosure targets must remain at least 44 by 44 CSS pixels, and the desktop default decision layer plus disclosure rows must be reachable without scrolling through an unbounded answer body.
- Visual coverage must update the existing Copilot workbench and Morning Brief default/expanded snapshots. Review should compare text density and hierarchy, not merely accept changed pixels.
- Pure projection tests are appropriate as a secondary seam for deterministic precedence and losslessness. They must prove that every source clause is either represented in the decision layer or assigned to a disclosure, unsupported reasons never become the concise “why,” and empty groups are omitted.
- Prior art is the existing Copilot grounding suite for rich/sparse/degraded packets and no-refetch disclosure behavior, the existing accessibility suite for native disclosure behavior, the responsive suite for measured overflow and target geometry, and the desktop/mobile visual snapshot suites for density review.

## Out of Scope

- Changing the Copilot answer packet, model prompts, generation behavior, retrieval recipes, evidence selection, graph schemas, graph data, or revision authority.
- Asking a model to generate a second summary or rewrite evidence.
- Fetching detail only when a disclosure opens.
- Persisting disclosure preferences across navigation or sessions.
- Introducing tabs, modals, drawers, a separate evidence page, or a new navigation hierarchy.
- Redesigning the composer, quick prompts, voice controls, workout generator, athlete profile, full graph explorer, or immutable Insight detail surface.
- Removing exact evidence, citations, unsupported-source caveats, or revision metadata from the answer entirely.
- Changing clinical or churn methodology, recalculating risk, or promoting source-provided risk above deterministic derived risk.
- Adding new analytics or production telemetry as part of this UI correction.

## Further Notes

- The screenshot demonstrates that progressive disclosure is only effective when the primary region is also bounded. The defect is not font size or card width; it is the projection rule that treats every clause in the `answer` section as primary.
- The preferred visual hierarchy is **signal → one supported why → one action → disclosures**. The current **summary dump → repeated signal → action** hierarchy should be removed.
- Exact evidence remains essential, but it is audit material rather than the default reading surface. The implementation must optimize for a coach deciding what to do next while preserving one-step access to the complete packet.
- Local Markdown is used for publication because the upstream GitHub repository is read-only for the current account and the writable fork has GitHub Issues disabled. No repository settings were changed.
