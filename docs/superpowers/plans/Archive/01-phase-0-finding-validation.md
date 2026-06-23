# Phase 0 — Finding Validation
## Implementation Plan

**Version**: 1.0 — 2026-06-22
**Scope**: Phase 0 only. No code is written or modified.
**Target reader**: Local AI coding agent with ~90 k-token context window.
**Estimated size**: ~6,000 tokens (no split needed).

---

## Requires

The following must exist before this phase begins:

| Artifact | Expected location |
|---|---|
| Refactor strategy | `code-analysis/aggregate/refactor-strategy.md` |
| Standards document | `code-analysis/aggregate/standards.md` |
| Full source tree | `src/` — all `.ts` files listed in Section 3 below |
| Compiled output | `dist/` — produced by `npm run build` / `tsc` |
| `package.json` | project root |
| Test helpers | `tests/utils/envHelpers.ts`, `tests/utils/fsHelpers.ts` |

Phase 0 reads only. It does not modify any file.

---

## Provides

After this phase completes, the following are established facts that later phases may depend on:

| ID | Claim | Status after phase |
|---|---|---|
| V-1a | Bin entry mismatch confirmed or refuted | Signed off |
| V-1b.1 | Hardcoded endpoint strings confirmed or refuted | Signed off |
| V-1b.1b | Duplicate `AbortController`/timeout logic confirmed or refuted | Signed off |
| V-1b.2 | Duplicated orchestration/retry/manifest logic confirmed or refuted | Signed off |
| V-2.1 | Mixed FS + orchestration in phase modules confirmed or refuted | Signed off |
| V-2.2 | Inline JSON extraction duplication confirmed or refuted | Signed off |
| V-2.3 | Duplicated test env setup confirmed or refuted | Signed off |
| V-2.4a | Mixed sync/async in `src/lms.ts` confirmed or refuted | Signed off |
| V-2.4b | Inline business logic in `src/index.ts` confirmed or refuted | Signed off |
| V-2.5a | `process.platform` coupling in `src/preflight.ts` confirmed or refuted | Signed off |
| V-2.5b | `.gitignore` vs dynamic exclusion conflict confirmed or refuted | Signed off |

Findings that cannot be confirmed in source are struck from scope before Phase 1b begins.

---

## Overview

Phase 0 is a read-only audit. The agent reads source files, evaluates each finding from the refactor strategy against the actual code, and fills in the finding checklist (Section 4). No file is created, edited, or deleted. The checklist is the deliverable.

The spec warns explicitly: *"All findings in this dataset have `convergence_count: 1` — they come from a single analysis pass with no cross-validation."* The purpose of this phase is to confirm or refute each before any refactor work begins.

---

## Section 1 — File Overview

No files are created or modified. The files read during verification are:

| File | What to look for |
|---|---|
| `package.json` | `bin` field vs `dist/` tree |
| `dist/src/index.js` | Whether this path exists |
| `src/lm-studio.ts` | Hardcoded URL string, `AbortController` construction |
| `src/lms-rest.ts` | Hardcoded URL string, `AbortController` construction |
| `src/index.ts` | Retry logic, manifest reads/writes, inline orchestration |
| `src/phases/index.ts` | Inline JSON extraction (brace-tracking), `fs` imports |
| `src/phases/analyze.ts` | `fs` imports, manifest writes, byte-grouping logic |
| `src/phases/dedup.ts` | Inline JSON extraction, `fs` imports, local `safeMaxTokens` |
| `src/phases/aggregate.ts` | `fs` imports |
| `src/lms.ts` | `spawnSync` in an `async` function body |
| `src/preflight.ts` | `process.platform` or `spawnSync` for OS detection |
| `src/discovery.ts` | `.gitignore` integration, dynamic exclusion logic |
| `tests/utils/envHelpers.ts` | Scope of env-restore helper |
| `tests/utils/fsHelpers.ts` | Scope of temp-dir helper |
| `tests/unit/manifest.test.ts` | Inline `beforeEach`/`afterEach` env setup |
| `tests/unit/logger.test.ts` | Inline `beforeEach`/`afterEach` env setup |
| `tests/unit/discovery.test.ts` | Inline `beforeEach`/`afterEach` env setup |
| `tests/integration/phase1.test.ts` | Inline `beforeEach`/`afterEach` env setup |

---

## Section 2 — Change Summary

No changes. This phase produces a completed finding checklist (Section 4) only.

---

## Section 3 — Detailed Verification Procedures

Each procedure below corresponds to one finding. Read the listed file(s), apply the stated test, and record the result in Section 4.

---

### V-1a: Bin Entry Point Mismatch (Phase 1a.1)

**Files**: `package.json`, `dist/` directory listing

**Verification procedure**:
1. Read `package.json`. Locate the `bin` field. Record the exact path and key name it declares.
2. Check whether the declared file exists in the compiled output.
3. Cross-reference the binary name against README, docs, or CLI usage documentation.

**Confirmation test**: The finding is confirmed if the declared file does NOT exist, OR if the binary name does not match the documented user-facing CLI command.

**Pre-populated verdict**: LIKELY CONFIRMED (binary name mismatch — `code-analyzer` registered, `gitnexus` expected by spec). Verify independently.

---

### V-1b.1a: Hardcoded API Endpoint Paths (Phase 1b.1)

**Files**: `src/lm-studio.ts`, `src/lms-rest.ts`

**Confirmation test**: Confirmed if either file contains a hardcoded string for a URL base, port, or route suffix not read from environment variables or a config object.

**Pre-populated verdict**: CONFIRMED — `lm-studio.ts` default param `'http://localhost:1234/v1/chat/completions'`; `lms-rest.ts` module constant `API_BASE = 'http://localhost:1234/api/v1'`.

---

### V-1b.1b: Duplicate AbortController / Timeout Logic (Phase 1b.1)

**Files**: `src/lm-studio.ts`, `src/lms-rest.ts`

**Confirmation test**: Confirmed if both files independently construct `AbortController` instances and set up abort-on-timeout timers with no shared implementation.

**Pre-populated verdict**: CONFIRMED — both files duplicate the pattern. Secondary finding: `lms-rest.ts` lacks external signal forwarding that `lm-studio.ts` implements — latent bug.

---

### V-1b.2: Duplicated Orchestration / Retry / Manifest Logic (Phase 1b.2)

**Files**: `src/index.ts`, `src/phases/index.ts`, `src/phases/analyze.ts`, `src/phases/dedup.ts`, `src/phases/aggregate.ts`

**Confirmation test**: Confirmed if manifest mutation and retry invocation are duplicated across phase modules with no central coordinator.

**Pre-populated verdict**: CONFIRMED (with scope note) — retry and manifest writes duplicated across all 4 phase files. `src/index.ts` is flow-control only (does NOT contain retry logic — strategy framing is slightly imprecise). `MAX_ATTEMPTS = 3` magic number repeated in all four phase files.

---

### V-2.1: Mixed FS + Orchestration in Phase Modules (Phase 2.1)

**Files**: `src/phases/aggregate.ts`, `src/phases/dedup.ts`, `src/phases/analyze.ts`, `src/phases/index.ts`

**Confirmation test**: Confirmed if any phase file imports `fs` directly and calls it inline.

**Pre-populated verdict**: CONFIRMED — all four phase modules import `fs` methods directly.

---

### V-2.2: Inline JSON Extraction Duplication (Phase 2.2)

**Files**: `src/phases/index.ts`, `src/phases/analyze.ts`, `src/phases/dedup.ts`

**Confirmation test**: Confirmed if brace-tracking JSON extraction logic appears in more than one file, or in any phase file without import from `src/utils/`.

**Pre-populated verdict**: CONFIRMED — two overlapping inline brace-tracking functions in `src/phases/index.ts` (`extractJsonArray`, `extractJsonFromResponse`). `analyze.ts` and `dedup.ts` use bare `JSON.parse` without extraction guard. No `extractJson` utility exists yet. C4 is currently violated.

---

### V-2.3: Duplicated Test Environment Setup (Phase 2.3)

**Files**: `tests/utils/envHelpers.ts`, `tests/utils/fsHelpers.ts`, test files

**Confirmation test**: Confirmed if two or more test files contain inline `beforeEach`/`afterEach` blocks that replicate setup without calling the existing helpers.

**Pre-populated verdict**: CONFIRMED (partial) — `tests/unit/manifest.test.ts` and `tests/integration/phase1.test.ts` duplicate temp-dir setup inline. Other files use helpers correctly.

---

### V-2.4a: Mixed Sync/Async in `src/lms.ts` (Phase 2.4)

**File**: `src/lms.ts`

**Confirmation test**: Confirmed if any `async` function calls a `*Sync` variant without await.

**Pre-populated verdict**: CONFIRMED — `runLms` is `async` but calls `spawnSync` synchronously. Intentional Windows workaround (comment in source). Phase 2.4 must handle this carefully.

---

### V-2.4b: Inline Business Logic in `src/index.ts` (Phase 2.4)

**File**: `src/index.ts`

**Confirmation test**: Confirmed if `src/index.ts` contains logic beyond wiring.

**Pre-populated verdict**: CONFIRMED — `detectGitNexus` (47-line function) and `spawnAsync` utility defined inline. `main()` contains the full orchestration loop.

---

### V-2.5a: Platform-Specific Logic Coupling in `src/preflight.ts` (Phase 2.5)

**File**: `src/preflight.ts`

**Confirmation test**: Confirmed if explicit `process.platform` checks appear inline outside an abstraction.

**Pre-populated verdict**: PARTIALLY CONFIRMED — no explicit `process.platform === 'win32'` guards. Implicit OS-specific paths exist (DXGI PowerShell block). Testability concern valid; structural coupling overstated by strategy.

---

### V-2.5b: `.gitignore` vs Dynamic Exclusion Conflict in `src/discovery.ts` (Phase 2.5)

**File**: `src/discovery.ts`

**Confirmation test**: Confirmed if both `.gitignore` and dynamic rules can apply to the same path and precedence is undocumented.

**Pre-populated verdict**: PARTIALLY REFUTED — no actual conflict possible (mutually exclusive code paths). `ALWAYS_EXCLUDED` > `.gitignore` precedence is real but undocumented. Scope reduced to adding a precedence comment.

---

## Section 4 — Finding Checklist (executor fills in)

| Finding ID | Strategy ref | Status | Evidence location | Notes |
|---|---|---|---|---|
| V-1a | Phase 1a.1 | ✅ CONFIRMED | `package.json` bin key `"code-analyzer"` → `./dist/src/index.js`; dist file exists. Binary name mismatch vs `gitnexus`. | File path correct; only bin key name wrong. |
| V-1b.1a | Phase 1b.1 | ✅ CONFIRMED | `src/lm-studio.ts:41` hardcoded `http://localhost:1234/v1/chat/completions`; `src/lms-rest.ts:4` `API_BASE = 'http://localhost:1234/api/v1'` | Both files contain module-level or default-param hardcoded URLs. |
| V-1b.1b | Phase 1b.1 | ✅ CONFIRMED | `src/lm-studio.ts:49` `new AbortController()`; `src/lms-rest.ts:22` `new AbortController()`. No shared implementation. | Latent bug: `lms-rest.ts` lacks external signal forwarding. |
| V-1b.2 | Phase 1b.2 | ✅ CONFIRMED | `MAX_ATTEMPTS` in all 4 phase modules; `withRetry` duplicated. Retry NOT in `src/index.ts`. | Scope note: orchestrator must absorb from phase modules, not index.ts. |
| V-2.1 | Phase 2.1 | ✅ CONFIRMED | `src/phases/aggregate.ts:1`, `analyze.ts:1`, `dedup.ts:1`, `index.ts:1` all import from `'fs'` directly. | All four phase modules confirmed. |
| V-2.2 | Phase 2.2 | ✅ CONFIRMED | `src/phases/index.ts` contains inline `extractJsonArray` and `extractJsonFromResponse` (brace-tracking). `analyze.ts`/`dedup.ts` use bare `JSON.parse`. | No `src/utils/extractJson.ts` exists yet. |
| V-2.3 | Phase 2.3 | ✅ CONFIRMED | `tests/unit/manifest.test.ts` and `tests/integration/phase1.test.ts` duplicate inline temp-dir setup. | Partial — other test files use helpers correctly. |
| V-2.4a | Phase 2.4 | ✅ CONFIRMED | `src/lms.ts:29` `spawnSync(...)` inside `async function runLms`. | Intentional Windows workaround per comment — must preserve shell:true + joined string in conversion. |
| V-2.4b | Phase 2.4 | ✅ CONFIRMED | `src/index.ts:62` `spawnAsync`, `src/index.ts:70` `detectGitNexus` (47-line inline fn). | Both scheduled for extraction to `src/process-helpers.ts` in Phase 1b.2. |
| V-2.5a | Phase 2.5 | ⚠️ PARTIALLY CONFIRMED | No explicit `process.platform === 'win32'` in `src/preflight.ts`. DXGI PowerShell block present but unconditional. | PlatformAdapter warranted for testability only. |
| V-2.5b | Phase 2.5 | ⚠️ PARTIALLY REFUTED | Mutually exclusive code paths — no actual conflict. `ALWAYS_EXCLUDED` > `.gitignore` > `FALLBACK_EXCLUDED` precedence undocumented. | Scope: precedence comment + one unit test only. |

---

## Section 5 — Scope Adjustments to Carry into Phase 1b

1. **V-1b.2**: Retry logic is NOT in `src/index.ts` — it is in the four phase modules. `PhaseOrchestrator` must absorb `withRetry` and `MAX_ATTEMPTS` from phase modules, not from `src/index.ts`.
2. **V-2.2**: Phase 2.2 scope covers all three files: two overlapping extractors in `index.ts`, and bare `JSON.parse` in `analyze.ts`/`dedup.ts`.
3. **V-2.5a**: Confirm with tech lead whether DXGI block should be extracted to `PlatformAdapter`. If testability alone is insufficient justification, descope Phase 2.5 to the precedence comment only.
4. **V-2.5b**: Scope reduced to adding a precedence order comment in `src/discovery.ts` at the `buildIgnore` call site.

**Secondary finding (not in strategy)**: `lms-rest.ts` does not forward external abort signals — latent bug. Assign to Phase 1b.1 or Phase 2.4.

---

## Section 6 — Validation & Testing

1. Every row in Section 4 is filled with CONFIRMED, REFUTED, or PARTIALLY CONFIRMED/REFUTED.
2. Each row cites at least one specific evidence location (file path + line number or function name).
3. Any REFUTED finding includes a one-sentence statement of what the code actually does.
4. Any PARTIALLY CONFIRMED/REFUTED finding includes a scope note.
5. A second engineer has reviewed and initialed the checklist before Phase 1b work begins.

---

## Section 7 — Idempotency & Safety Checks

- Fully idempotent — reads only.
- No files created, modified, or deleted.
- Re-running produces the same result assuming source is unchanged.
- If source files have changed since Phase 0 ran, re-run relevant procedures.
