# Refactor Strategy

This strategy prioritizes stability, correctness, and maintainability. Phases are ordered by **Severity (High > Medium > Low)**.

**Note on Convergence**: All findings in this dataset have `convergence_count: 1` — they come from a single analysis pass with no cross-validation. Every finding must be manually verified against the source before Phase 1b begins (see Phase 0). Do not treat LLM-assigned severity as confirmed signal.

---

## Phase 0: Finding Validation (Prerequisite — no code written)

*Goal: Confirm each finding is real before committing to any refactor.*

Before executing any phase, a developer must verify each High- and Medium-severity finding directly against the source. Findings that cannot be reproduced are removed from scope. This phase produces a signed-off finding list, not code.

**Done when**: All Phase 1 and Phase 2 items are either confirmed (reproduced in code) or removed from scope. Finding list reviewed by at least one other engineer.

---

## Phase 1a: Immediate Unblocking (ship within one day)

*Goal: Restore a working CLI. Zero architectural risk.*

### 1a.1 Fix Bin Entry Point Mismatch

- **Finding**: `package.json` bin entry points to a file that does not exist or is wrong.
- **Impact**: CLI is currently broken for all users.
- **Action**: Verify the compiled entry file path, update the `bin` field in `package.json`.
- **Done when**: `npx gitnexus` (or the package binary name) executes without a "not found" or module resolution error.
- **Rollback**: Revert the `package.json` change — no other files touched.

---

## Phase 1b: Architectural Foundation (after Phase 0 sign-off)

*Goal: Establish the three core abstractions that all later phases depend on. Do not start Phase 2 until these are merged and integration tests pass.*

### 1b.1 Unify LLM Client Abstraction

- **Findings**:
  - Hardcoded API endpoint paths in `src/lm-studio.ts` and `src/lms-rest.ts`.
  - Abort controller and timeout setup duplicated across both files.
- **Action**:
  1. Define `LLMClient` interface with a single request method and shared abort signal lifecycle.
  2. Extract common error handling, abort patterns, and timeout logic into the interface implementation.
  3. Replace all hardcoded endpoint strings with environment config or a config object.
  4. Refactor `src/lm-studio.ts` and `src/lms-rest.ts` to implement `LLMClient`.
- **Done when**: Both files implement `LLMClient`; no `AbortController` construction exists outside the interface; all existing integration tests pass without modification; p99 request latency is within 5% of baseline (profile if SSE streaming is affected).
- **Rollback**: Revert the interface and both client files — downstream callers unchanged if the interface matches existing signatures.

### 1b.2 Centralize Phase Orchestration

- **Finding**: LLM orchestration, retry logic, and manifest updates are duplicated across `src/index.ts` and multiple phase files.
- **Action**:
  1. Implement `PhaseOrchestrator` responsible for: main execution loop, retry/backoff, manifest state reads and writes.
  2. Remove all orchestration logic from individual phase files — phases expose business logic only.
  3. Ensure `src/index.ts` delegates to `PhaseOrchestrator` for all flow control.
- **Done when**: No retry or manifest-update logic exists outside `PhaseOrchestrator`; integration tests pass; `src/index.ts` contains only wiring, not orchestration logic.
- **Rollback**: If integration tests fail after merge, revert this PR before starting Phase 2. Do not patch forward while tests are red.

> **Gate**: Run full integration test suite after 1b.2 merges. Phase 2 does not start until tests are green.

---

## Phase 2: Architectural Clean-Up (after Phase 1b gate passes)

*Goal: Improve testability, reduce duplication, enforce separation of concerns.*

### 2.1 Extract File System Abstraction

- **Findings**:
  - Mixed orchestration and file system operations in `src/phases/aggregate.ts` and `src/phases/dedup.ts`.
  - Tight coupling via shared `src/types.js` dependency.
- **Action**:
  1. Define `FileSystemService` interface for all I/O operations used by phase modules.
  2. Inject `FileSystemService` into phase modules via constructor or parameter — no direct `fs` imports in phase files.
  3. Refactor `aggregate.ts` and `dedup.ts` to use the injected service.
- **Pre-condition**: Run `npx madge --circular src/` before and after this PR to verify no new circular imports are introduced.
- **Done when**: No direct `fs` / `path` calls exist in phase modules; `FileSystemService` is injectable with a mock for unit tests; circular import check passes.
- **Rollback**: Revert interface and refactored phase files — orchestrator is unaffected.

### 2.2 Consolidate JSON Extraction Logic

- **Finding**: JSON extraction logic (brace-tracking, error handling) duplicated across phase modules.
- **Action**:
  1. Extract `extractJson(raw: string): unknown` as a pure utility function in `src/utils/`.
  2. Replace inline parsing in `src/phases/index.ts`, `analyze.ts`, and `dedup.ts` with calls to `extractJson`.
- **Done when**: No inline brace-tracking or JSON.parse error-swallowing exists outside `extractJson`; unit tests cover malformed input, empty string, and nested objects.

### 2.3 Standardize Test Environment Management

- **Finding**: Test setup/teardown and environment variable restoration duplicated across test files.
- **Action**:
  1. Implement `TestEnvironmentManager` that returns fresh state per test — never a shared mutable instance.
  2. Refactor `tests/utils/fsHelpers.ts`, `tests/utils/envHelpers.ts`, and test files with duplicated `beforeEach`/`afterEach` blocks to use the manager.
- **Done when**: No duplicated env-var or temp-directory setup outside `TestEnvironmentManager`; each test call to the manager returns independent state (no test pollution verified by running tests in random order).

### 2.4 Address Mixed Sync/Async and Inline Logic

**Depends on**: Phase 1b.2 complete (`PhaseOrchestrator` exists).

- **Findings**:
  - Mixed sync/async execution in `src/lms.ts`.
  - Inline phase execution logic in `src/index.ts`.
- **Action**:
  1. Audit `src/lms.ts` — convert any sync operations that call async I/O or network to `async/await`. Remove mixed patterns.
  2. Verify `src/index.ts` is now wiring-only after 1b.2; remove any remaining inline execution logic.
- **Done when**: No synchronous file or network calls exist in `src/lms.ts` without an await; `src/index.ts` contains no business logic.

### 2.5 Refine Platform Detection and Discovery Logic

- **Findings**:
  - Platform-specific logic tightly coupled in `src/preflight.ts`.
  - Static `.gitignore` may conflict with dynamic exclusion logic in `src/discovery.ts`.
- **Action**:
  1. Extract platform detection into an adapter: `PlatformAdapter` interface with `win32` and `posix` implementations. Replace inline `process.platform` checks in `src/preflight.ts`.
  2. Audit `src/discovery.ts` — document which exclusion rules take precedence (dynamic wins over static `.gitignore`). If `.gitignore` and dynamic rules can conflict, enforce a precedence order in code and document it.
- **Done when**: No `process.platform === 'win32'` conditionals exist outside the adapter; exclusion precedence is explicit in code or a code comment at the conflict site.

---

## Phase 3: Low-Hanging Fruit and Test Hygiene (Low Severity)

*Goal: Polish test code and resolve minor inconsistencies.*

### 3.1 Extract Test Fixtures

- **Findings**:
  - Mock LLM response setup duplicated across test files.
  - Test modules define types locally instead of importing from `src/types.ts`.
- **Action**:
  1. Create `createTestManifestFixture` and `generatePromptFixture` in `tests/utils/fixtures.ts`. Use these wherever the same shape appears in 2+ test files. One-off test objects with ≤5 properties used only in a single `describe` block may remain inline.
  2. Replace any local type definitions in test files with imports from `src/types.ts`.
- **Done when**: No type definition exists in a test file that duplicates a definition in `src/types.ts`.

### 3.2 Extract Utility Functions

- **Findings**:
  - Duplicated byte-based grouping logic in `analyze.ts`.
  - Repeated regex-based identifier matching in `preflight.ts`.
- **Action**:
  1. Verify `groupByByteSize` and `resolveModelIdentifier` are pure functions (no side effects, no I/O) before extracting.
  2. Extract both into `src/utils/` and update callers.
- **Done when**: Both utilities have unit tests covering edge cases; no inline copies remain in source files.

---

## Summary of Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Phase 1b.2 (`PhaseOrchestrator`) breaks integration tests mid-refactor | Medium | Run full suite after PR merges; revert if red — do not patch forward |
| `LLMClient` abstraction degrades SSE streaming latency | Low | Profile p99 request latency before and after; revert if >5% regression |
| `FileSystemService` introduces circular imports at Node.js module load time (silent, hard to debug) | Medium | Run `npx madge --circular src/` as a required PR check for 2.1 |
| `PhaseOrchestrator` grows into a god object (>200 LOC, 10+ responsibilities) | Medium | Cap at 200 LOC; split into `RetryCoordinator` + `ManifestManager` if needed |
| `TestEnvironmentManager` used as a shared mutable instance, causing test pollution | Low | Manager API must return fresh state per call; enforce in code review |
| LLM-assigned severity is wrong (convergence_count: 1 throughout) | High | Phase 0 finding validation is mandatory before any Phase 1b work starts |

## Sequencing Diagram

```
Phase 0 (validate findings)
  └─► Phase 1a (bin fix — ship immediately, parallel with Phase 0)
  └─► Phase 1b.1 (LLMClient)
      └─► Phase 1b.2 (PhaseOrchestrator)
          └─► [integration test gate]
              └─► Phase 2.1 (FileSystemService)
              └─► Phase 2.2 (extractJson)
              └─► Phase 2.3 (TestEnvironmentManager)
              └─► Phase 2.4 (sync/async cleanup) — depends on 1b.2
              └─► Phase 2.5 (platform adapter)
                  └─► Phase 3.1, 3.2 (polish)
```
