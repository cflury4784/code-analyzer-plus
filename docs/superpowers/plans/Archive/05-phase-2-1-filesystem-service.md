# Phase 2.1 — Extract File System Abstraction
## Implementation Plan

**Version**: 1.0 — 2026-06-22
**Requires**: Phase 1b.2 integration test gate passed
**Provides**: `src/fs-service.ts` (FileSystemService interface + NodeFileSystemService); all four phase modules refactored; T1 standard fully satisfied
**Pre-condition**: Run `npx madge --circular src/` and record baseline before starting. This PR must not introduce any new circular imports.

---

## Requires Manifest

- Phase 1b.2 merged and green
- `npx madge --circular src/` baseline recorded
- No failing tests before starting

## Provides Manifest

| Artifact | Description |
|---|---|
| `src/fs-service.ts` | `FileSystemService` interface + `NodeFileSystemService` implementation |
| `src/phases/aggregate.ts` | Refactored: no direct `fs`/`path` imports |
| `src/phases/dedup.ts` | Refactored: no direct `fs`/`path` imports |
| `src/phases/index.ts` | Refactored: no direct `fs`/`path` imports |
| `src/phases/analyze.ts` | Refactored: no direct `fs`/`path` imports |

This phase covers **all four** phase modules. T1 requires ALL phase modules to be clean after this PR — no deferral.

---

## File 1: `src/fs-service.ts` (NEW)

### 1. File Overview

Defines `FileSystemService` interface (all I/O used by phase modules) and `NodeFileSystemService` (delegates to Node.js built-ins). Phase modules receive `FileSystemService` as a function parameter — no classes, no constructors.

### 2. Change Summary

New file — ~60 lines.

### 3. Detailed Code

```typescript
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Abstraction over Node.js file system operations used by phase modules.
 * Inject a mock in unit tests to avoid real disk I/O.
 * All methods mirror the Node.js fs/path signatures that phase modules use.
 */
export interface FileSystemService {
  readFileSync(path: string): string;
  writeFileSync(path: string, content: string): void;
  /** Creates directory and all intermediate directories (mkdir -p). Does not throw if exists. */
  mkdirSync(path: string): void;
  existsSync(path: string): boolean;
  join(...segments: string[]): string;
}

/**
 * Production implementation — delegates to Node.js built-ins.
 * Construct once per run; share across all phase calls.
 */
export class NodeFileSystemService implements FileSystemService {
  readFileSync(path: string): string {
    return readFileSync(path, 'utf8');
  }
  writeFileSync(path: string, content: string): void {
    writeFileSync(path, content, 'utf8');
  }
  mkdirSync(path: string): void {
    mkdirSync(path, { recursive: true });
  }
  existsSync(path: string): boolean {
    return existsSync(path);
  }
  join(...segments: string[]): string {
    return join(...segments);
  }
}
```

### 4. Implementation Notes

- `join` is on the interface so phase modules use `fs.join(...)` instead of bare `join`. A mock can redirect paths to temp directories.
- `mkdirSync` always uses `{ recursive: true }` internally — callers do not pass options.
- `writeFileSync` always writes UTF-8 — callers do not pass encoding.
- No imports from other `src/` files — no circular import risk.

### 5. Validation & Testing

Create `tests/unit/fs-service.test.ts`:
- Roundtrip write+read
- `existsSync` returns false for missing file, true after write
- `mkdirSync` creates nested directories, is idempotent

### 6. Idempotency & Safety Checks

- File does not exist yet
- `NodeFileSystemService` is stateless — safe to construct once and share

---

## Files 2–5: All Four Phase Modules (MODIFIED)

Apply the same structural change to each file:
1. Remove `import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';`
2. Remove `import { join } from 'path';`
3. Add `import type { FileSystemService } from '../fs-service.js';`
4. Add `fs: FileSystemService` as the 4th parameter (after `logger`, before `lmUrl?`) — but note: after Phase 1b.2, `runIndexPhase` and `runAnalyzePhase` also have `orchestrator: PhaseOrchestrator` as their FIRST parameter. The full parameter order is: `orchestrator, projectRoot, model, logger, fs, lmUrl?, timeoutMs?, numCtx?, signal?, ...`
5. Replace all bare `join(...)` calls with `fs.join(...)`
6. Replace all `readFileSync(path, 'utf8')` with `fs.readFileSync(path)`
7. Replace all `writeFileSync(path, content, 'utf8')` with `fs.writeFileSync(path, content)`
8. Replace all `mkdirSync(path, { recursive: true })` with `fs.mkdirSync(path)`
9. Replace all `existsSync(path)` with `fs.existsSync(path)`

The detailed modifications for `aggregate.ts` and `dedup.ts` follow. Apply the identical pattern to `index.ts` and `analyze.ts`.

**Important for `index.ts`**: This file contains two inline brace-tracking JSON extraction functions (`extractJsonArray`, `extractJsonFromResponse`) — those are C4 violations deferred to Phase 2.2. Do NOT remove them in this phase. Only remove `fs`/`path` imports and add the `FileSystemService` parameter.

**Important for `analyze.ts`**: Contains `JSON.parse(raw) as AnalysisOutput` on LLM output — C4 violation deferred to Phase 2.2. Do not remove it here.

---

## File 2: `src/phases/aggregate.ts` (MODIFIED)

### 1. File Overview

Remove direct `fs`/`path` imports. Add `FileSystemService` parameter. Replace all `join(...)` with `fs.join(...)` and all `readFileSync`/`writeFileSync`/`mkdirSync`/`existsSync` with `fs.*` equivalents.

### 2. Change Summary

- Remove: `import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';`
- Remove: `import { join } from 'path';`
- Add: `import type { FileSystemService } from '../fs-service.js';`
- Add `fs: FileSystemService` as 4th parameter (after `logger`, before `lmUrl?`)

### 3. Detailed Code Modifications

**Import diff**:
```diff
-import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
-import { join } from 'path';
+import type { FileSystemService } from '../fs-service.js';
```

**Signature diff**:
```diff
 export async function runAggregatePhase(
   projectRoot: string,
   model: string,
   logger: Logger,
+  fs: FileSystemService,
   lmUrl?: string,
```

**Call site replacements** (apply to all occurrences):
- `join(...)` → `fs.join(...)`
- `readFileSync(path, 'utf8')` → `fs.readFileSync(path)`
- `writeFileSync(path, content, 'utf8')` → `fs.writeFileSync(path, content)`
- `mkdirSync(path, { recursive: true })` → `fs.mkdirSync(path)`
- `existsSync(path)` → `fs.existsSync(path)`

### 4. Implementation Notes

- `JSON.parse(fs.readFileSync(...))` — reading previously written file from disk, not LLM output. Not a C4 concern.
- After Phase 2.1, `src/phase-orchestrator.ts` (the caller) must pass `new NodeFileSystemService()` as the 4th argument.

### 5. Validation & Testing

Unit test `tests/unit/phases/aggregate.test.ts`:
- Mock `FileSystemService` with `existsSync` returning `true` → function returns early, no LLM call
- Mock with `existsSync` returning `false` → LLM called; `mkdirSync` and `writeFileSync` called with correct paths

Mock scaffold:
```typescript
function makeMockFs(overrides: Partial<FileSystemService> = {}): FileSystemService {
  return {
    readFileSync: vi.fn().mockReturnValue('{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    join: (...segments: string[]) => segments.join('/'),
    ...overrides,
  };
}
```

### 6. Idempotency & Safety Checks

- Re-running with `existsSync` returning `true` for both output files is a no-op (returns early). Behavior preserved.

---

## File 3: `src/phases/dedup.ts` (MODIFIED)

### 1. File Overview

Same structural change. Both `runDedupPhase` AND `buildDedupBatches` (private helper) use `fs`/`path` — both receive `FileSystemService`.

### 2. Change Summary

- Remove direct `fs`/`path` imports
- Add `FileSystemService` parameter to both `buildDedupBatches` and `runDedupPhase`
- Replace all bare `join`/`readFileSync`/`writeFileSync`/`mkdirSync`/`existsSync` calls

### 3. Detailed Code Modifications

**Import diff**: same as `aggregate.ts`.

**`buildDedupBatches` signature**:
```diff
-function buildDedupBatches(projectRoot: string): ...
+function buildDedupBatches(projectRoot: string, fs: FileSystemService): ...
```

**`runDedupPhase` signature**:
```diff
 export async function runDedupPhase(
   projectRoot: string,
   model: string,
   logger: Logger,
+  fs: FileSystemService,
   lmUrl?: string,
```

**`buildDedupBatches` internal call**:
```diff
-const { batches: computedBatches, passAGroups } = buildDedupBatches(projectRoot);
+const { batches: computedBatches, passAGroups } = buildDedupBatches(projectRoot, fs);
```

Apply `fs.*` replacements to all bare `join`/`readFileSync`/`writeFileSync`/`mkdirSync`/`existsSync` throughout both functions.

**Note**: `JSON.parse(fs.readFileSync(...))` in `buildDedupBatches` reads analysis batch files from disk — not LLM output. Not a C4 concern. Do not add `extractJson` here (that is Phase 2.2 scope).

### 4. Implementation Notes

- `safeMaxTokens` local function stays — not orchestration or I/O logic.
- Pass B has an `existsSync(findingsPath)` early-exit guard — must use `fs.existsSync(findingsPath)` after refactor.
- `buildDedupBatches` is called once per `runDedupPhase` invocation — `fs` parameter does not need module-level wiring.

### 5. Validation & Testing

Unit test `tests/unit/phases/dedup.test.ts`:
- `buildDedupBatches`: mock `FileSystemService` returns pre-seeded JSON; verify batch IDs
- Pass B early-exit: `existsSync(findingsPath)` returns true → no LLM call
- Pass A failure propagates: `updatePhaseStatus` called with `'failed'`

### 6. Idempotency & Safety Checks

- Pass A skips completed batches
- Pass B has `existsSync` guard — re-running is safe

---

## Caller Update

After all four phase files are modified, update all call sites in `src/phase-orchestrator.ts` to pass `new NodeFileSystemService()`.

```powershell
npx grep -rn "runAggregatePhase|runDedupPhase|runIndexPhase|runAnalyzePhase" src/
```

Expected primary caller: `src/phase-orchestrator.ts`. Add import and instance:

```typescript
import { NodeFileSystemService } from './fs-service.js';

const fsService = new NodeFileSystemService();

// Full corrected call signatures — the fs parameter is inserted as the 5th argument
// (after logger, before lmUrl). The previous undefined for lmUrl? shifts right by one:
// All four phase calls must be updated — complete corrected signatures:
await runIndexPhase(
  this, this.projectRoot, resolvedModel, this.logger,
  fsService,          // NEW — FileSystemService
  undefined,          // lmUrl?
  timeoutMs, numCtx, this.signal, gitNexusCtx,
);
await runAnalyzePhase(
  this, this.projectRoot, resolvedModel, this.logger,
  fsService,          // NEW — FileSystemService
  undefined,          // lmUrl?
  timeoutMs, numCtx, this.signal, gitNexusCtx,
);
await runDedupPhase(
  this, this.projectRoot, resolvedModel, this.logger,
  fsService,          // NEW — FileSystemService
  undefined,          // lmUrl?
  timeoutMs, numCtx, this.signal,
);
await runAggregatePhase(
  this, this.projectRoot, resolvedModel, this.logger,
  fsService,          // NEW — FileSystemService
  undefined,          // lmUrl?
  timeoutMs, numCtx, this.signal,
);
```

**Important**: The Phase 1b.2 plan wrote `src/phase-orchestrator.ts` before Phase 2.1 existed. After Phase 2.1 inserts `fs: FileSystemService` as the 5th parameter, the previously written orchestrator call sites must be updated to the signatures above. Run `npx tsc --noEmit` immediately after updating the orchestrator — the compiler will report any remaining argument-count mismatches.

---

## Execution Order

```
1. npx madge --circular src/  (record baseline)
2. Create src/fs-service.ts
3. npx tsc --noEmit  [must pass]
4. Modify src/phases/aggregate.ts
5. npx tsc --noEmit  [must pass]
6. Modify src/phases/dedup.ts
7. npx tsc --noEmit  [must pass]
8. Update caller (src/phase-orchestrator.ts) to pass NodeFileSystemService
9. npx tsc --noEmit  [must pass]
10. npx madge --circular src/  [must match baseline]
11. npm test  [all tests green]
```

## Done Criteria

- [ ] `src/fs-service.ts` created
- [ ] `aggregate.ts` has no `import ... from 'fs'` or `import ... from 'path'`
- [ ] `dedup.ts` has no `import ... from 'fs'` or `import ... from 'path'`
- [ ] All callers updated
- [ ] `npx madge --circular src/` matches pre-PR baseline
- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` passes
- [ ] Unit tests exist for `NodeFileSystemService`, `runAggregatePhase` (mock FS), `runDedupPhase` (mock FS)
- [ ] All four phase modules have no `import ... from 'fs'` or `import ... from 'path'`
- [ ] T1 standard fully enforced (noted in PR description)
