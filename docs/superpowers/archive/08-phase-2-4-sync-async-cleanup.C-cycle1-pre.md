# Phase 2.4 — Address Mixed Sync/Async and Inline Logic
## Implementation Plan

**Version**: 1.0 — 2026-06-22
**Requires**: Phase 1b.2 complete (`PhaseOrchestrator` exists at `src/phase-orchestrator.ts`, integration test gate green)
**Provides**: `src/lms.ts` async-only; `src/gitnexus-detect.ts` (extracted helpers); `src/index.ts` wiring-only

---

## Requires Manifest

- Phase 1b.2 merged and green
- `src/phase-orchestrator.ts` exists
- Windows test environment available for `.cmd` shim smoke test

## Provides Manifest

| Artifact | Description |
|---|---|
| `src/lms.ts` | `runLms` converted to async `spawn`; Windows `.cmd` shim behavior preserved |
| `src/gitnexus-detect.ts` | `spawnAsync` and `detectGitNexus` extracted from `src/index.ts` |
| `src/index.ts` | Wiring-only after Phase 1b.2 cleanup; `spawnAsync`/`detectGitNexus` import from new module |

E1 standard satisfied in `src/lms.ts` (no sync call inside async call chain).

---

## File 1: `src/lms.ts` (MODIFIED)

### 1. File Overview

`runLms` is declared `async` but calls `spawnSync`. This blocks the event loop during LMS binary execution. Convert to `async spawn` with a promise wrapper.

**Critical**: The original `spawnSync` call uses `shell: true` and a joined command string — both are Windows-required for `.cmd` shim resolution and DEP0190 avoidance. These must survive the conversion exactly.

### 2. Change Summary

- Remove `import { spawnSync } from 'child_process';`
- Add `import { spawn } from 'child_process';`
- Replace `runLms` body with async `spawn` + promise wrapper

### 3. Detailed Code — `runLms` replacement

```typescript
/**
 * Windows .cmd shim note: `shell: true` lets Windows resolve `lms` as either
 * .exe or .cmd shim (npm global install). The full command is passed as a
 * single joined string (not args array) to avoid Node.js DEP0190
 * (shell=true + args array deprecation). This matches the original spawnSync
 * pattern. The async conversion preserves both constraints.
 */
export async function runLms(args: string[], opts: RunOpts = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const cmd = 'lms ' + args.join(' ');
    const proc = spawn(cmd, [], { shell: true } as Parameters<typeof spawn>[2]);

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, opts.timeoutMs);
    }

    (proc.stdout as NodeJS.ReadableStream | null)?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    (proc.stderr as NodeJS.ReadableStream | null)?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (timer !== undefined) clearTimeout(timer);
      if (err.code === 'ENOENT') {
        return reject(new Error('lms binary not found on PATH — is LM Studio CLI installed?'));
      }
      reject(new Error(`lms ${args[0] ?? ''} failed: ${err.message}`));
    });

    proc.on('close', (code: number | null) => {
      if (timer !== undefined) clearTimeout(timer);
      if (timedOut) {
        return reject(new Error(`lms ${args[0] ?? ''} timed out after ${(opts.timeoutMs ?? 0) / 1000}s`));
      }
      if (code !== 0) {
        return reject(new Error(`lms ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
      }
      resolve(stdout);
    });
  });
}
```

### 4. Implementation Notes

- `shell: true` is mandatory for Windows `.cmd` shim resolution. Do not remove.
- Single-string join is mandatory to avoid DEP0190. Do not pass args as a separate array.
- `spawnSync` `maxBuffer` enforcement moves to documentation only — `spawn` does not natively enforce it. For current usage (JSON blobs <100 KB), not a practical concern.
- All callers of `runLms` already use `await` — no call site changes needed.

### 5. Validation & Testing

- `npx tsc --noEmit` must pass
- Existing `runLms` tests: if they mock `spawnSync` directly, update to mock `spawn` instead
- **Windows manual smoke test** (mandatory):
  ```powershell
  node dist/index.js --skip-preflight --phase index
  ```
  Expected: no `EINVAL` or `ENOENT` during `lms` invocation
- DEP0190 check:
  ```powershell
  node --trace-deprecation dist/index.js --version
  ```
  Expected: no DEP0190 warning

### 6. Idempotency & Safety Checks

- All callers use `await` — no call site changes
- Rollback: revert `src/lms.ts` only; independent of other files in this phase

---

## File 2: `src/gitnexus-detect.ts` (NEW)

### 1. File Overview

Receives `spawnAsync` and `detectGitNexus`, currently inline in `src/index.ts`. Moving them here makes `src/index.ts` wiring-only.

### 2. Detailed Code

```typescript
import { spawn } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import * as readline from 'readline';
import { openGitNexus } from './gitnexus.js';
import type { GitNexusContext } from './gitnexus.js';
import type { Logger } from './logger.js';

export function spawnAsync(
  cmd: string,
  args: string[],
  opts: { cwd: string; shell: boolean },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { ...opts, stdio: 'inherit' });
    proc.on('close', resolve);
    proc.on('error', reject);
  });
}

export async function detectGitNexus(
  projectRoot: string,
  logger: Logger,
): Promise<GitNexusContext | null> {
  const dbPath = join(projectRoot, '.gitnexus');

  if (!existsSync(dbPath)) {
    console.log(
      '\n⚠  GitNexus index not found.\n' +
      '   Run: npx gitnexus analyze\n' +
      '   This enables smarter batching and faster, more accurate results.\n',
    );
    if (!process.stdin.isTTY) {
      logger.info('Non-TTY stdin detected — continuing without GitNexus');
      return null;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(resolve => {
      rl.question('Continue without GitNexus? [y/N] ', resolve);
    });
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      process.exit(0);
    }
    return null;
  }

  logger.info('GitNexus index found — running npx gitnexus analyze to refresh');
  try {
    const exitCode = await spawnAsync('npx', ['gitnexus', 'analyze'], {
      cwd: projectRoot,
      shell: true,
    });
    if (exitCode !== 0) {
      logger.warn('npx gitnexus analyze exited non-zero — skipping GitNexus enrichment', { code: exitCode });
      return null;
    }
  } catch {
    logger.warn('npx gitnexus analyze failed to spawn — skipping enrichment');
    return null;
  }

  const ctx = await openGitNexus(projectRoot);
  if (!ctx) logger.warn('GitNexus schema probe failed or DB locked — skipping enrichment');
  return ctx;
}
```

### 3. Implementation Notes

- `closeGitNexus` is NOT imported here — the cleanup registration stays in `src/index.ts` as lifecycle wiring.
- No logic changes from the original inline functions.

### 4. Validation & Testing

Unit test `tests/gitnexus-detect.test.ts`:
- No `.gitnexus` dir, non-TTY stdin → returns `null`, no prompt
- `.gitnexus` exists, `spawnAsync` exits 0 → `openGitNexus` called
- `.gitnexus` exists, `spawnAsync` exits non-zero → returns `null`

### 5. Idempotency & Safety Checks

- New file — no overwrite risk
- Circular import check: `gitnexus-detect.ts` imports from `gitnexus.ts` and `logger.ts`; neither imports from `gitnexus-detect.ts`

---

## File 3: `src/index.ts` (MODIFIED)

After Phase 1b.2 already moved the execution loop, this phase removes the two inline helpers.

### Changes

1. Remove `spawnAsync` function body
2. Remove `detectGitNexus` function body
3. Remove now-unused imports: bare `spawn`, `readline`, `existsSync` from `fs` (if only used by those two functions — verify before removing)
4. Add import: `import { detectGitNexus } from './gitnexus-detect.js';`
5. Remove `import { openGitNexus, closeGitNexus } from './gitnexus.js'` only if `openGitNexus` is no longer referenced directly in `index.ts`. Keep `closeGitNexus` — used in the `process.once('exit', ...)` cleanup handler.

### Post-edit verification

```powershell
# No business logic remains
grep -n "function|const.*=.*async\|spawnAsync\|detectGitNexus" src/index.ts
# Expected: only main() and the arrow function in main().catch(...)
```

---

## Execution Order

```
1. Read src/lms.ts, src/index.ts (mandatory before editing)
2. Modify src/lms.ts (replace spawnSync with spawn)
3. npx tsc --noEmit  [must pass]
4. Create src/gitnexus-detect.ts
5. npx tsc --noEmit  [must pass]
6. Modify src/index.ts (remove inline helpers, add import)
7. npx tsc --noEmit  [must pass]
8. npx madge --circular src/  [must be clean]
9. npx vitest run  [all tests green]
10. Windows manual smoke test (mandatory)
11. DEP0190 check
```
