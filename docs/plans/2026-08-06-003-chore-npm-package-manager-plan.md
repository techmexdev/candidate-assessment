---
title: npm Package Manager Migration - Plan
type: chore
date: 2026-08-06
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# npm Package Manager Migration - Plan

## Goal Capsule

- **Objective:** Make npm the repository's active package manager while preserving the current Node 24 runtime contract, exact direct dependency versions, developer commands, Playwright server behavior, and quality gates.
- **Authority:** This plan and the current active repository configuration govern the migration. Historical files under `docs/plans/` remain records and do not define the active package-manager contract.
- **Execution profile:** Apply a narrow package-management and documentation change. Do not modify application behavior.
- **Stop conditions:** Stop if npm cannot resolve the existing direct dependency pins, a required native dependency cannot install on Node 24, or a package-manager semantic difference changes application behavior beyond this plan.
- **Tail ownership:** The implementer owns clean-install verification and every existing quality gate before landing the migration.

## Product Contract

### Summary

Replace pnpm with the npm distributed through the repository's Node 24 runtime. Keep the application and its dependency declarations stable while changing the lockfile, active command surfaces, and developer instructions.

### Problem Frame

The repository currently requires pnpm through its package-manager metadata, lockfile, build script, Playwright server command, and README. This prevents contributors from using npm as the ordinary install and task runner even though the project is a single package and its application scripts are otherwise package-manager-neutral.

The migration has one non-mechanical difference: `pnpm-workspace.yaml` limits dependency build scripts to `sharp` and `unrs-resolver`, while the npm bundled with Node 24 does not provide equivalent enforced allowlist behavior. The migration must make this security-policy change visible and verify the native dependencies from a clean npm installation.

### Requirements

**Package ownership**

- R1. npm must be the only active package manager documented and invoked by the repository.
- R2. The repository must commit an npm lockfile generated from the unchanged exact direct dependency versions in `package.json`.
- R3. The pnpm lockfile and pnpm-only workspace configuration must be removed after the npm dependency graph installs successfully.

**Behavior preservation**

- R4. The build must continue to run production-isolation validation before the Next.js production build.
- R5. Playwright must continue to launch the development server on `127.0.0.1:3100` with the existing URL, reuse, and timeout behavior.
- R6. The npm-installed graph must provide working `sharp` and `unrs-resolver` native bindings on the supported Node 24 environment.

**Contributor workflow**

- R7. The README must show npm commands for installation, local development, and every existing quality gate.
- R8. A clean npm install and the full existing validation suite must pass without relying on a pnpm-shaped `node_modules` tree.

### Scope Boundaries

- Historical package-manager commands in `docs/plans/` and `ui/uploads/` remain unchanged because those artifacts describe earlier repository states.
- Application source, tests, dependency upgrades, and runtime feature work are outside this migration.
- Playwright browser acquisition remains an environment prerequisite rather than a package-manager migration deliverable.

#### Deferred to Follow-Up Work

- Enforcing a strict per-dependency install-script allowlist would require a separately pinned npm 12 toolchain and a broader developer/CI bootstrap policy. This plan uses the npm bundled with Node 24 and records the weaker lifecycle-script posture as a known risk.

### Acceptance Examples

- AE1. Given a clean checkout on Node 24, when a contributor runs `npm ci`, then npm installs the committed graph without rewriting `package.json` or `package-lock.json`.
- AE2. Given Playwright starts its managed server, when it forwards the configured host and port arguments through npm, then the existing test base URL becomes reachable on port 3100.
- AE3. Given a production build, when npm runs the build script, then production-isolation validation completes before Next.js compilation begins.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Use Node 24's bundled npm without a separate npm bootstrap.** This matches the request for normal npm and preserves `.nvmrc` and `engines.node`. Remove the pnpm `packageManager` marker instead of replacing it with an exact npm marker that npm does not enforce and that can drift as Node 24 updates its bundled npm.
- KTD2. **Regenerate the dependency graph instead of translating the pnpm lockfile.** npm and pnpm encode and resolve transitive graphs differently. Keep every direct version pin unchanged, generate `package-lock.json` with npm under Node 24, and review native and optional dependency changes before retiring `pnpm-lock.yaml`.
- KTD3. **Accept npm's bundled lifecycle-script behavior and audit the result.** The current pnpm allowlist does not transfer to the bundled npm as an equivalent enforced policy. Clean-install verification must confirm `sharp` and `unrs-resolver` work and must flag unexpected install-script packages for review.
- KTD4. **Translate command indirection at the script boundary.** Use `npm run` for named scripts and npm's `--` separator when Playwright forwards Next.js host and port arguments. This preserves local binary resolution and current command behavior.

### Sequencing

1. Establish a valid npm dependency graph and lockfile before deleting pnpm's lock and workspace files.
2. Switch the active build, Playwright, and README command surfaces after the npm graph is known to install.
3. Verify from a clean npm dependency tree under Node 24; results from the existing pnpm-shaped tree do not prove the migration.

### Risks and Mitigations

- **Install-script policy regression:** Bundled npm runs dependency lifecycle scripts more broadly than the current pnpm allowlist. Review install output and lockfile install-script metadata, and stop on unexpected packages rather than silently accepting them.
- **Transitive graph drift:** npm may select different transitive versions even when direct pins remain exact. Review `package-lock.json` for direct-version changes, peer-resolution warnings, and platform-specific optional packages.
- **Cross-platform native packages:** `sharp`, Next.js SWC packages, and `unrs-resolver` depend on platform-specific optional packages. Run clean-install and build verification on the deployment operating system and architecture when it differs from development.
- **Concurrent README edits:** `README.md` is already modified in the current worktree. Apply the npm command edits to the current file without replacing unrelated user changes.

### Sources and Research

- The repository's active pnpm surface is limited to `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `playwright.config.ts`, and `README.md`.
- [npm `ci` documentation](https://docs.npmjs.com/cli/v11/commands/npm-ci/) defines frozen clean-install behavior and lockfile agreement requirements.
- [npm lockfile documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/) defines the committed dependency-tree contract and lockfile version used by modern npm.
- [npm script documentation](https://docs.npmjs.com/cli/v11/commands/npm-run/) defines local binary resolution and argument forwarding.
- [Node 24 release archive](https://nodejs.org/en/download/archive/v24) records the npm version distributed with the active Node line.
- [Next.js installation requirements](https://nextjs.org/docs/app/getting-started/installation) and [Playwright installation requirements](https://playwright.dev/docs/intro) support the repository's Node 24 runtime.
- [sharp installation guidance](https://sharp.pixelplumbing.com/install/) identifies cross-platform lockfile and native-binary considerations.

---

## Implementation Units

### U1. Establish canonical npm dependency state

- **Goal:** Replace pnpm's package metadata and lock state with a clean npm dependency graph while preserving the current direct dependencies.
- **Requirements:** R1-R4, R6, R8; KTD1-KTD3.
- **Dependencies:** None.
- **Files:**
  - `package.json`
  - `package-lock.json`
  - `pnpm-lock.yaml`
  - `pnpm-workspace.yaml`
- **Approach:**
  1. Remove the pnpm package-manager marker and translate the nested build invocation to npm while leaving all dependency and devDependency entries unchanged.
  2. Generate `package-lock.json` under Node 24 from a clean npm resolution.
  3. Inspect peer-resolution output, platform-specific optional packages, and dependencies with install scripts.
  4. Remove the pnpm lockfile and pnpm workspace file only after the npm graph is valid.
- **Execution note:** This is packaging work; prefer clean-install and native-runtime smoke evidence over adding application test code.
- **Patterns to follow:** Preserve the exact version-pin style already used in `package.json` and retain the existing isolation-first build ordering.
- **Test scenarios:** Test expectation: none -- this unit changes package metadata and lock state, so clean-install and native-module smoke verification provide the relevant evidence.
- **Verification:** A fresh `npm ci` under Node 24 leaves the manifest and lockfile unchanged, resolves every direct pin exactly, and provides working native dependencies for lint and build paths.

### U2. Migrate active command and documentation surfaces

- **Goal:** Make npm the command path for contributors, Playwright, and all repository quality gates.
- **Requirements:** R1, R4, R5, R7, R8; KTD4.
- **Dependencies:** U1.
- **Files:**
  - `playwright.config.ts`
  - `README.md`
  - `tests/e2e/coach-dashboard-responsive.spec.ts`
  - `tests/visual/coach-dashboard-desktop.spec.ts`
- **Approach:**
  1. Change Playwright's managed-server command to invoke the development script through npm and forward the existing host and port arguments.
  2. Replace active README install, development, and quality-gate examples with correct npm forms.
  3. Leave historical plan artifacts and all application behavior untouched.
- **Execution note:** Validate the managed-server path from Playwright itself; a manually started development server does not prove argument forwarding.
- **Patterns to follow:** Preserve the existing Playwright base URL, server URL, reuse policy, timeout, and current README structure.
- **Test scenarios:**
  - Covers AE2. From a clean npm tree with no server already running, start a focused Playwright browser test and verify that the managed server reaches the configured gallery URL on port 3100.
  - Covers AE3. Run the npm production-build entry point and verify that a failed isolation check prevents Next.js compilation while a passing check proceeds to the build.
  - Run the documented npm development and quality-gate commands and verify that every command maps to an existing script without npm argument-parsing errors.
- **Verification:** Active non-historical files contain no pnpm commands, and npm can launch the Playwright server and every documented quality gate.

---

## Verification Contract

| Gate | Command or evidence | Covers | Done signal |
|---|---|---|---|
| Runtime baseline | `node --version` and `npm --version` under the repository's Node 24 environment | U1-U2 | Node reports version 24 and npm is the version bundled with that Node installation. |
| Frozen dependency install | `npm ci` from a clean dependency tree | U1 | Install succeeds, `package-lock.json` remains unchanged, and no unexpected lifecycle-script package is accepted without review. |
| Dependency integrity | `npm ls sharp unrs-resolver` plus lockfile review | U1 | Both native dependencies resolve without invalid or missing-package errors; exact direct pins are unchanged. |
| Static quality | `npm run lint` and `npm run typecheck` | U1-U2 | ESLint and TypeScript pass without new errors. |
| Unit behavior | `npm test` | U1-U2 | The existing Vitest suite passes from the npm-installed tree. |
| Playwright server path | `npm run test:e2e` | U2 | Playwright launches the npm-managed server and the existing browser suite passes. |
| Accessibility and visual coverage | `npm run test:a11y` and `npm run test:visual` | U2 | Existing accessibility checks and reviewed visual baselines pass without package-manager regressions. |
| Isolation and production build | `npm run build` | U1-U2 | Isolation validation runs first and the Next.js production build succeeds, including native image tooling. |
| Active-reference audit | Search active files outside `docs/plans/` and `ui/uploads/` for `pnpm` | U1-U2 | No active pnpm lock, configuration, command, or documentation reference remains. |

---

## Definition of Done

- R1-R8 and AE1-AE3 are satisfied.
- `package-lock.json` is the sole committed package-manager lockfile.
- `pnpm-lock.yaml` and `pnpm-workspace.yaml` are removed.
- Direct dependency and devDependency versions remain unchanged.
- The npm-installed tree passes all Verification Contract gates under Node 24.
- Unexpected dependency lifecycle scripts, peer-resolution changes, and native optional-package differences are resolved or surfaced as blockers.
- Existing unrelated worktree changes, including concurrent README edits, are preserved.
- No abandoned migration experiments or duplicate package-manager configuration remain in the final diff.
