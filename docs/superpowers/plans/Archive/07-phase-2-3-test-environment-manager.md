# Phase 2.3 — Standardize Test Environment Management
## Implementation Plan

**Version**: 1.0 — 2026-06-22
**Requires**: Phase 1b.2 integration test gate passed
**Provides**: `tests/utils/TestEnvironmentManager.ts`; `envHelpers.ts` and `fsHelpers.ts` deleted; TS1 standard satisfied
**Blocks**: Phase 3.1 must not start until this phase merges

---

## Requires Manifest

- Phase 1b.2 merged and green
- `tests/utils/envHelpers.ts` exports `restoreEnvVars(saved: Record<string, string|undefined>): void`
- `tests/utils/fsHelpers.ts` exports `createTempFileSystemSetup(baseDir: string)` returning `{ root, cleanup }`
- These two files confirmed in Phase 0

## Provides Manifest

| Artifact | Description |
|---|---|
| `tests/utils/TestEnvironmentManager.ts` | `setupTempFs`, `snapshotEnv`, `restoreEnvVars` (re-exported for migration) |
| `tests/utils/envHelpers.ts` | Deleted after all callers migrated |
| `tests/utils/fsHelpers.ts` | Deleted after all callers migrated |

TS1 satisfied: no duplicated `beforeEach`/`afterEach` env/fs setup outside `TestEnvironmentManager`.

---

## Migration order (MANDATORY — do not delete helpers until all callers updated)

1. Create `TestEnvironmentManager.ts`
2. Migrate `tests/unit/logger.test.ts`
3. Migrate `tests/unit/discovery.test.ts`
4. Migrate `tests/unit/manifest.test.ts`
5. Migrate `tests/integration/phase1.test.ts`
6. Verify no remaining imports: `grep -rn "envHelpers\|fsHelpers" tests/` → zero results
7. Delete `envHelpers.ts`
8. Delete `fsHelpers.ts`

---

## File 1: `tests/utils/TestEnvironmentManager.ts` (NEW)

```typescript
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export interface TempFsResult {
  root: string;
  cleanup: () => void;
}

/**
 * Creates a temporary directory. Returns fresh, independent state per call.
 * No shared mutable state in this module — test isolation is structural.
 */
export function setupTempFs(baseDir: string): TempFsResult {
  const root = join(tmpdir(), `${baseDir}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Captures a snapshot of named env vars and returns a restore function.
 * Call restore() in afterEach.
 */
export function snapshotEnv(keys: string[]): { restore: () => void } {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) saved[key] = process.env[key];
  return {
    restore: () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

/**
 * Restores process.env entries from a pre-captured snapshot object.
 * Re-exported for incremental migration; prefer snapshotEnv for new code.
 * TODO: remove after all callers use snapshotEnv.
 */
export function restoreEnvVars(envVars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(envVars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
```

---

## Files 2–5: Caller migrations

### `tests/unit/logger.test.ts`

```diff
-import { createTempFileSystemSetup, type TempFsResult } from '../utils/fsHelpers.js';
-import { restoreEnvVars } from '../utils/envHelpers.js';
+import { setupTempFs, restoreEnvVars, type TempFsResult } from '../utils/TestEnvironmentManager.js';
```

```diff
-  fs = createTempFileSystemSetup('logger-test');
+  fs = setupTempFs('logger-test');
```

`restoreEnvVars` call sites are syntactically unchanged — function re-exported from `TestEnvironmentManager`.

### `tests/unit/discovery.test.ts`

```diff
-import { createTempFileSystemSetup, type TempFsResult } from '../utils/fsHelpers.js';
+import { setupTempFs, type TempFsResult } from '../utils/TestEnvironmentManager.js';
```

```diff
-  fs = createTempFileSystemSetup('discovery-test');
+  fs = setupTempFs('discovery-test');
```

### `tests/unit/manifest.test.ts`

**Remove** imports: `mkdirSync`, `rmSync` from `fs`; `tmpdir` from `os` (if only used for temp-dir setup).

**Add**:
```typescript
import { setupTempFs, type TempFsResult } from '../utils/TestEnvironmentManager.js';
```

**Add** variable:
```typescript
let tempFs: TempFsResult;
```

**Replace `beforeEach`**:
```diff
 beforeEach(() => {
-  testRoot = join(tmpdir(), `manifest-test-${Date.now()}`);
-  mkdirSync(testRoot, { recursive: true });
+  tempFs = setupTempFs('manifest-test');
+  testRoot = tempFs.root;
 });
```

**Replace `afterEach`**:
```diff
 afterEach(() => {
-  rmSync(testRoot, { recursive: true, force: true });
+  tempFs.cleanup();
 });
```

Keep any `fs` functions (`existsSync`, `writeFileSync`) still used in test bodies — only remove the setup-specific ones.

### `tests/integration/phase1.test.ts`

**Add**:
```typescript
import { setupTempFs, type TempFsResult } from '../utils/TestEnvironmentManager.js';
```

**Add** variable:
```typescript
let tempFs: TempFsResult | undefined;
```

**In `setupProject()`**: replace temp-dir creation:
```diff
-testRoot = join(tmpdir(), `phase1-test-${Date.now()}`);
-mkdirSync(join(testRoot, 'src', 'utils'), { recursive: true });
+tempFs = setupTempFs('phase1-test');
+testRoot = tempFs.root;
+mkdirSync(join(testRoot, 'src', 'utils'), { recursive: true });
```

**Replace `afterEach`**:
```diff
 afterEach(() => {
-  if (testRoot) rmSync(testRoot, { recursive: true, force: true });
+  if (tempFs) tempFs.cleanup();
 });
```

---

## Implementation Notes

- `TestEnvironmentManager` is a module, not a class. No instance to accidentally share.
- `setupTempFs` uses `Date.now()` suffix — matches existing helper behavior exactly.
- `restoreEnvVars` is re-exported (not deleted) so `logger.test.ts` compiles without a behavior change.
- The `mkdirSync` call in `phase1.test.ts` body (creating `code-analysis/index` fixture) is NOT temp-dir setup — leave it untouched.

---

## Validation & Testing

### Stale import check (run before deleting helpers)
```powershell
grep -rn "envHelpers|fsHelpers" tests/
# Must return zero results
```

### Full test suite
```powershell
npx vitest run
# All tests must pass. Count must not change.
```

### Random-order isolation test
```powershell
npx vitest run --sequence.shuffle
# All tests must pass. Failure = shared mutable state.
```

### TypeScript compile
```powershell
npx tsc --noEmit
```

---

## Post-Merge TS1 Compliance Check

```powershell
grep -rn "beforeEach|afterEach" tests/ | Select-String "mkdirSync|rmSync|tmpdir|process\.env"
# Expected: zero results
```

---

## Rollback

Revert `TestEnvironmentManager.ts` and the four modified test files. Restore `envHelpers.ts` and `fsHelpers.ts` from git history. All original import paths valid again.
