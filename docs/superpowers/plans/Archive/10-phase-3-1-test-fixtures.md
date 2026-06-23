# Phase 3.1 — Extract Test Fixtures
## Implementation Plan

**Version**: 1.0 — 2026-06-22
**Requires**: Phase 2.3 complete (`tests/utils/TestEnvironmentManager.ts` must exist)
**Provides**: `tests/utils/fixtures.ts`; `sseResponse` duplication eliminated; `BatchEntry` literals consolidated

---

## Requires Manifest

- Phase 2.3 merged and green (`TestEnvironmentManager` exists)
- `msw` in `devDependencies` (required for `HttpResponse` in fixtures)
- All tests green on branch before starting

## Provides Manifest

| Artifact | Description |
|---|---|
| `tests/utils/fixtures.ts` | New file — `generatePromptFixture` + `createTestManifestFixture` |
| `tests/unit/lm-studio.test.ts` | Inline `sseResponse` removed; uses `generatePromptFixture` |
| `tests/integration/phase1.test.ts` | Inline `sseResponse` removed; uses `generatePromptFixture` |
| `tests/unit/manifest.test.ts` | Inline `BatchEntry` literals replaced with `createTestManifestFixture` |

TS2 satisfied: shared test data used across 2+ files lives in `fixtures.ts`.

---

## Pre-Condition Check (MANDATORY)

```powershell
Test-Path 'tests/utils/TestEnvironmentManager.ts'
# Must return True. If False: Phase 2.3 has not merged — stop.
```

---

## What is extracted vs what stays inline

### Extracted (shared across 2+ files)

**`sseResponse` → `generatePromptFixture`**: Identical function exists in:
- `tests/unit/lm-studio.test.ts` (lines 6–10)
- `tests/integration/phase1.test.ts` (lines 23–27)

Both produce an MSW `HttpResponse` with `text/event-stream` content-type simulating LM Studio SSE streaming. Extract to `fixtures.ts`.

**`BatchEntry` inline literals → `createTestManifestFixture`**: Four identical or near-identical `BatchEntry` shape literals in `tests/unit/manifest.test.ts` across separate `describe` blocks. Extract.

### Stays inline (inline exception per TS2)

| Symbol | File | Reason |
|---|---|---|
| `emptyDedup` | `prompts.test.ts` | 5 props, single file, single describe |
| `file()` builder | `batcher.test.ts` | 4-prop `FileEntry`, single file only |
| `makeLms()` / `makeDeps()` | `preflight.test.ts` | Complex vi.fn mocking, not duplicated |
| `MOCK_INDEX_ITEM` | `phase1.test.ts` | 7 props but single file/describe |

### Type duplication audit result

All test files import types from `src/types.ts` or `src/gitnexus.js`. No locally-defined type definitions duplicate `src/types.ts`. C3/TS3: no violations. No type changes required.

---

## File 1: `tests/utils/fixtures.ts` (NEW)

### 1. File Overview

Central home for shared test data factories. No vitest/jest imports — pure utility importable by any test file. ESM `.js` extension on imports.

### 2. Detailed Code

```typescript
import { HttpResponse } from 'msw';
import type { BatchEntry } from '../../src/types.js';

/**
 * Generate a minimal MSW HttpResponse simulating an LM Studio SSE streaming reply.
 * Note: despite the name `generatePromptFixture`, this produces an HTTP response
 * fixture (not a text prompt) — the name follows the project spec.
 *
 * @param content - The string to embed in the SSE delta.content field.
 *   Typically a JSON-serialized payload (e.g. JSON.stringify([indexItem])).
 */
export function generatePromptFixture(content: string): HttpResponse {
  const chunk = JSON.stringify({
    choices: [{ delta: { content }, finish_reason: null }],
  });
  return new HttpResponse(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/**
 * Create a BatchEntry test fixture with sensible defaults.
 * Supply only the fields relevant to the specific assertion.
 */
export function createTestManifestFixture(overrides: Partial<BatchEntry> = {}): BatchEntry {
  return {
    id: 'batch-001',
    files: [],
    size_bytes: 0,
    status: 'pending',
    attempts: 0,
    completed_at: null,
    output_file: 'code-analysis/index/batch-001.json',
    ...overrides,
  };
}
```

### 3. Implementation Notes

- Import path uses `.js` extension (`../../src/types.js`) — this project uses ESM `.js` imports for TypeScript files.
- `msw` must be a dev dependency — verify in `package.json` before creating this file.
- `HttpResponse` is from `msw` — if only `sseResponse` used it in both files, check whether removing the local function leaves `HttpResponse` unused in each file and remove the import there.

### 4. Validation & Testing

- `npx tsc --noEmit` must pass after creation

---

## File 2: `tests/unit/lm-studio.test.ts` (MODIFY)

**Remove** the inline `sseResponse` function (lines 6–10).

**Add** import:
```typescript
import { generatePromptFixture } from '../utils/fixtures.js';
```

**Replace** all `sseResponse(...)` calls with `generatePromptFixture(...)`.

**Verify** no `sseResponse` reference remains:
```powershell
grep -n "sseResponse" tests/unit/lm-studio.test.ts  # must be zero
```

**Remove** `HttpResponse` from the `msw` import if it is no longer used directly in this file (check for other uses first).

---

## File 3: `tests/integration/phase1.test.ts` (MODIFY)

**Remove** the inline `sseResponse` function (lines 23–27).

**Add** import:
```typescript
import { generatePromptFixture } from '../utils/fixtures.js';
```

**Replace** the call `sseResponse(JSON.stringify([MOCK_INDEX_ITEM]))` with `generatePromptFixture(JSON.stringify([MOCK_INDEX_ITEM]))`.

Note: `HttpResponse` is also used directly at line ~76 and ~84 in this file — retain the `msw` import.

---

## File 4: `tests/unit/manifest.test.ts` (MODIFY)

**Add** import:
```typescript
import { createTestManifestFixture } from '../utils/fixtures.js';
```

**Replace** the four inline `BatchEntry` literals with fixture calls:

| Original shape | Replacement |
|---|---|
| All-default BatchEntry | `createTestManifestFixture()` |
| `status: 'completed', attempts: 2, completed_at: '2026-01-01T00:00:00Z'` | `createTestManifestFixture({ status: 'completed', attempts: 2, completed_at: '2026-01-01T00:00:00Z' })` |
| Dedup variant `id: 'partial-001', output_file: 'code-analysis/dedup/partial-001.json', status: 'completed', ...` | `createTestManifestFixture({ id: 'partial-001', status: 'completed', attempts: 1, completed_at: '...', output_file: 'code-analysis/dedup/partial-001.json' })` |

---

## Execution Order

```
1. Test-Path tests/utils/TestEnvironmentManager.ts  [must be True]
2. Create tests/utils/fixtures.ts
3. npx tsc --noEmit  [must pass]
4. Edit tests/unit/lm-studio.test.ts
5. Edit tests/integration/phase1.test.ts
6. Edit tests/unit/manifest.test.ts
7. npx vitest run  [all tests green]
8. grep -rn "function sseResponse" tests/  [must be zero]
```

## Post-Merge TS2 Compliance Check

```powershell
# No sseResponse remains outside fixtures.ts
grep -rn "function sseResponse" tests/
# Expected: zero results
```
