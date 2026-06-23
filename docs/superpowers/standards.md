# Codebase Standards & Engineering Principles

**Version**: 1.1 — 2026-06-22
**Owner**: Assign to tech lead before Phase 1b starts.
**Review cadence**: Revisit and update after each phase completes.
**Change process**: PR to this file requires approval from 2 engineers. Standards in the *Target Architecture* section are promoted to *Current Invariants* when the implementing PR merges.

---

## How to read this document

Standards are split into two tiers:

- **Current Invariants** — enforced now. A PR violating these is blocked.
- **Target Architecture** — enforced once the named refactor PR merges. Until then, treat as design intent, not a code review blocker.

Both tiers use "must" for requirements and "must not" for prohibitions. Where "should" appears, it is a guideline, not a requirement — see Section 6.

---

## Current Invariants

These are enforced in all PRs today.

### C1. Configuration — No Hardcoded Runtime Values

The following must be externalized to environment variables or a config object:

- API endpoint paths (base URLs, route suffixes)
- Model identifiers and aliases
- File system root paths
- Timeout values (connection, read, abort)
- Retry counts and backoff intervals
- Model sampling parameters (temperature, top-p, max tokens)

Hardcoded strings for any of the above in `src/lm-studio.ts`, `src/lms-rest.ts`, or any new client file are prohibited.

### C2. Bin Entry Consistency

The `package.json` `bin` field must point to a file that exists in the compiled output. Mismatches are critical blockers — they break the CLI for all users.

### C3. Shared Types

Shared types must be imported from `src/types.ts`. Type definitions must not be duplicated in phase modules or test files. If a test file needs a type that does not exist in `src/types.ts`, add it there.

### C4. Utility Extraction

Complex parsing logic — any logic with branching, error handling, or state (e.g., brace-tracking JSON extraction) — must be extracted into pure functions in `src/utils/`. Inline parsing of this complexity in phase modules is prohibited. Pure functions with no side effects and no I/O may be tested in isolation.

---

## Target Architecture

These standards become enforced once the referenced PR merges. Before that, they are design intent.

### T1. Phase Module Isolation
*Gated on: Phase 2.1 PR — `src/fs-service.ts`*

Phase modules (`src/phases/*.ts`) must not import `fs`, `path`, or any Node.js I/O module directly. All file system operations must go through a `FileSystemService` parameter (defined in `src/fs-service.ts`) passed to each exported function. Phase modules must remain function exports — not classes. This makes phases testable in isolation without touching the real file system.

Circular imports are prohibited. Run `npx madge --circular src/` on every PR that touches phase modules.

### T2. Orchestration Boundary
*Gated on: Phase 1b.2 PR — `src/phase-orchestrator.ts`*

`PhaseOrchestrator` (defined in `src/phase-orchestrator.ts`) owns: the main execution loop, retry/backoff logic, and manifest state reads and writes. Phase modules must not implement any of these. `src/index.ts` must not contain business logic — wiring only.

`PhaseOrchestrator` must not exceed 200 lines. If it grows beyond that, split responsibilities into `RetryCoordinator` and `ManifestManager`.

### T3. LLM Client Contract
*Gated on: Phase 1b.1 PR — `src/llm-client.ts`*

All LLM interactions (LM Studio, REST, SSE) must go through the `LLMClient` interface (defined in `src/llm-client.ts`). Direct construction of `AbortController` or inline timeout logic outside the interface implementation is prohibited. Every network request must be cancellable within the shared abort signal lifecycle defined by the interface.

### T4. Platform Abstraction
*Gated on: Phase 2.5 PR (PlatformAdapter)*

Platform-specific logic must be encapsulated in a `PlatformAdapter` with `win32` and `posix` implementations. Inline `process.platform` checks in `src/preflight.ts` or any phase module are prohibited after this PR merges.

---

## Error Handling and Resilience

These apply now.

### E1. Consistent Async/Await

All functions that perform I/O or network calls must be `async` and use `await`. Mixing synchronous calls that block the event loop with async callers is prohibited. If a function calls `fs.readFileSync` or any `*Sync` variant inside an async call chain, it must be converted.

### E2. Abort Signal Scope

*(Becomes enforceable after T3 merges.)* Until then: do not introduce new `AbortController` instances that are not cleaned up on request completion or error. Leaked abort controllers that are never resolved are a memory risk in long-running processes.

---

## Testing Standards

### TS1. Test Environment Isolation

All test setup, teardown, and environment variable save/restore must go through `TestEnvironmentManager`. `TestEnvironmentManager` must return fresh, independent state on every call — it must never hold shared mutable state across tests. Duplicated `beforeEach`/`afterEach` blocks that replicate env setup across test files are prohibited.

### TS2. Fixture Scope

Test data shared across 2 or more test files must use shared fixture utilities (`createTestManifestFixture`, `generatePromptFixture`) defined in `tests/utils/fixtures.ts`. **This file does not exist yet — it is created in Phase 3.1.** Until it exists, shared test data may be defined locally with a `// TODO: move to fixtures.ts in Phase 3.1` comment. One-off test objects with 5 or fewer properties used only within a single `describe` block may be defined inline — this is preferred over wrapping trivial objects in fixtures.

### TS3. No Type Duplication in Tests

Test modules must not define types that already exist in `src/types.ts`. See C3.

---

## Guidelines (non-blocking)

These are best practices. A PR should not be blocked on these, but reviewers may call them out.

- Platform adapter implementations should be independently unit-testable without mocking the OS.
- Discovery exclusion rules (dynamic vs. static `.gitignore`) should have their precedence documented at the call site if any ambiguity exists.
- Utility functions extracted in Phase 3 should have at least one test covering an edge case (empty input, boundary value) — not just the happy path.
