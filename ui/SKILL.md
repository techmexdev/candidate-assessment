---
name: axon-design
description: Use this skill to generate well-branded interfaces and assets for AXON, the graph-backed fitness-coaching product, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.

Core rule: **ink is human, Signal is machine** — carbon ink (#111111) on chalk surfaces for everything a person does; the holographic Signal gradient (`--ax-signal`) ONLY for graph/AI-produced content (provenance, decision paths, retrieval states). Never decorative, never red/green semantics, no emoji.

Type: Archivo variable (display = font-stretch 125%, weight 600–700, tracking −0.02em; body = normal width) + JetBrains Mono 10px uppercase tracked +0.12em for the system/data voice. Tokens live in `tokens/*.css`, imported via `styles.css`.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.
If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.
