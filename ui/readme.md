# AXON Design System

**AXON** is the design system for a graph-backed fitness-coaching product: a coach-facing dashboard that drafts daily workouts from a knowledge graph, explains every decision with provenance, and requires human approval before anything reaches a member. The name reads both ways — the neural graph doing the reasoning, and the muscle fiber doing the work.

Built from scratch for this product (no external brand imported). Primary artifacts in this project:
- `Coach Dashboard v2.dc.html` — the flagship mobile prototype (chalk theme)
- `Coach Dashboard.dc.html` — earlier dark/lime exploration (superseded by AXON carbon theme)
- `Coach Dashboard Wireframes.dc.html` — IA explorations
- Product data: `uploads/member-context.json`, `uploads/exercises.json`; plan: `uploads/2026-08-05-001-feat-graph-backed-coach-dashboard-plan.md`

## The one idea to remember

**Ink is human. Signal is machine.** Everything a *person* does — buttons, approvals, warnings, text — is carbon ink on chalk. Everything the *graph or AI* produced — provenance, decision paths, retrieval states, suggested actions — carries the holographic **Signal** gradient. If it shimmers, a machine reasoned it; a coach can always tell at a glance which is which. Never use Signal decoratively.

## Full graph inspection

- Focused Movement explanations and member profiles remain the default. `Show full graph` is an optional curiosity path inside the originating surface.
- Full graph views are read-only and show the complete bounded snapshot, total node/relationship counts, authority (`canonical` or `fixture`), and the pinned graph/context revision.
- Selecting a node or relationship opens persistent source/provenance details. Show explicit `none · identity or lineage node` when no direct assertion exists; never infer a source from nearby data.
- Keep the semantic relationship inventory available with the viewport. A dense canvas may scroll, but it must not silently replace the complete projection with a top-N subset.
- `← Focused view` returns to the originating explanation or profile. Graph inspection must not mutate workouts, approvals, member context, Copilot state, or graph data.

## CONTENT FUNDAMENTALS

- **Voice**: calm, professional, verb-led. The assistant reports; the coach decides. Copy never hypes ("Celebrate the knee win, watch churn", "Override — keep warning").
- **Two registers**: sentence-case Archivo for human-facing copy; UPPERCASE JetBrains Mono for the system/data voice (kickers, provenance, doses: `3×10 · DUMBBELL`, `SNOMED CT SUBSET · INJURY REPORT 05/10`).
- **Person**: the member is named ("Jordan", "her"), the coach is "you" implicitly; the system refers to itself as "the graph" / "assistant", never "I".
- **Numbers are celebrated**: big expanded numerals (50%, 6.3h, 58). Trends written with arrows: `100% → 50%`.
- **Provenance is a sentence habit**: every claim cites its source inline or in a mono tag. No unsourced assertions.
- **No emoji.** Glyphs only: ✓ ! ✗ → ← − + ⊂ ↓ (see ICONOGRAPHY).
- **Safety copy is specific**: name the structure and the rule ("Deep knee flexion under load — patellofemoral pain (recovering)"), never vague ("may be unsafe").

## VISUAL FOUNDATIONS

- **Themes**: *Chalk* (default, light — review & desk work) and *Carbon* (`[data-ax-theme="carbon"]` — in-workout/night). Both strictly monochrome + Signal.
- **Color**: carbon ink scale (#111111 → #A0A099) on chalk surfaces (#F7F7F4 / #FFFFFF). No brand hue, no red/green semantics — warnings are ink + `!` glyph, success is ink + `✓`. The only chroma in the system is the Signal gradient (`--ax-signal`, soft/faint tints for washes).
- **Type**: Archivo variable (width axis). Display = Archivo Expanded (`font-stretch:125%`, weight 600–700, tracking −0.02em) — athletic, engineered, jersey-adjacent. Body = Archivo normal width. Data voice = JetBrains Mono 10px uppercase tracked +0.12em. Stat numerals use stretch ~110%.
- **Spacing**: 4px base scale (`--ax-s1..s8`); screens pad 18px; card innards 14–16px; sibling gaps 10–12px via flex/grid `gap`.
- **Radii**: pills (999) for ALL actions; 20px hero cards & sheets; 14px rows; 10px inputs/tiles.
- **Borders**: 1px hairlines everywhere (#E4E4DF); stronger #D8D8D2 for interactive outlines; *dashed* borders mean excluded / not-applicable.
- **Shadows**: near-flat. Cards get a whisper (`--ax-shadow-card`); only floating elements (toast, sheets) get depth. No inner shadows.
- **Backgrounds**: flat chalk; the desk behind the app column gets a faint Signal radial glow. No imagery, no textures, no gradients outside Signal.
- **Motion**: `--ax-ease` (.2,.7,.2,1); fade-up 280ms for arriving content; sheets slide up; Signal shimmer (`ax-signal-shift`, background-position loop ~1.6s) ONLY while the machine is working. Press = scale(.99); hover = border darkens to ink or bg lifts. No bounces.
- **Transparency/blur**: scrim `rgba(20,20,18,.32)` behind sheets; action bars may use slight translucency. No glassmorphism.
- **Cards**: white, 1px hairline, radius 14–20, whisper shadow. Recessed groups (exclusions) use `--ax-surface-sub` + dashed border.
- **Layout**: mobile-first 430px column, sticky bottom action bars (52px primary buttons), 44px minimum hit target, uppercase mono section labels instead of heavy headers.
- **Charts**: solid ink bars on `--ax-bg` panels, mono axis labels; history/context in line grays, the "now" bar in ink (or Signal when machine-highlighted).

## ICONOGRAPHY

- **Unicode-glyph-first system** (intentional): ✓ confirm/celebrate · ! warning (in a filled ink circle) · ✗ excluded · → forward/CTA · ← back · + / − expand/collapse · ↓ graph-edge direction · ⊂ hierarchy ("patellofemoral ⊂ knee") · · interpunct separator. Glyphs render in the text color of their context; warning `!` sits in a 20–26px filled ink circle with white glyph.
- No icon font or SVG set is bundled. If richer icons become necessary, use **Lucide** (CDN) at 1.5px stroke to match the hairline system — flag any such addition.
- **No logo exists.** Render "AXON" in Archivo Expanded 700 uppercase wherever a mark would go. Do not draw a symbol.

## Index

- `styles.css` — global entry (imports everything under `tokens/`)
- `tokens/` — `fonts.css`, `colors.css`, `typography.css`, `spacing.css`, `effects.css`
- `guidelines/` — foundation specimen cards (Design System tab)
- `components/core/` — Button, Chip, Card, Input, Segmented, TabBar, Toast
- `components/data/` — StatTile, BarChart, VersionTimeline
- `components/agentic/` — SignalKicker, ProvenanceTag, LaneNode, SignalShimmer
- `ui_kits/coach-app/` — Today-screen recreation of the flagship prototype
- `SKILL.md` — agent-skill entry point

### Intentional additions
- The `agentic/` component group (SignalKicker, ProvenanceTag, LaneNode, SignalShimmer) exists because the ink-vs-Signal distinction is the system's core semantic and needs first-class primitives.
