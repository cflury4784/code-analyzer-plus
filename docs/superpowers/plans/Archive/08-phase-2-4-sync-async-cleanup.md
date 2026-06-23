# Phase 2.4 — Address Mixed Sync/Async in `src/lms.ts`
## Implementation Plan

**Version**: 1.1 — 2026-06-22 (revised: scope narrowed to lms.ts only; helper extraction was completed in Phase 1b.2)
**Requires**: Phase 1b.2 complete (`PhaseOrchestrator` exists, `src/process-helpers.ts` exists, `src/index.ts` is already wiring-only)
**Provides**: `src/lms.ts` with `runLms` converted to async `spawn`; E1 satisfied

---

## Scope Note

`spawnAsync` and `detectGitNexus` were extracted from `src/index.ts` into `src/process-helpers.ts` by Phase 1b.2 (required by T2: `src/index.ts` must be wiring-only after that phase merges). Phase 2.4 does **not** touch those functions or `src/index.ts`. The only change in this phase is converting `src/lms.ts`'s `runLms` from synchronous to async.

---

## Requires Manifest

- Phase 1b.2 merged and green
- `src/process-helpers.ts` exists (created by Phase 1b.2)
- `src/index.ts` imports from `./process-helpers.js` (verified by Phase 1b.2)
- Windows test environment available for `.cmd` shim smoke test

## Provides Manifest

| Artifact | Description |
|---|---|
| `src/lms.ts` | `runLms` converted to async `spawn`; Windows `.cmd` shim behavior preserved |

E1 standard satisfied: no sync call inside async call chain in `src/lms.ts`.

---

## File 1: `src/lms.ts` (MODIFIED)

### 1. File Overview

`runLms` is declared `async` but calls `spawnSync`. This blocks the event loop during LMS binary execution. Convert to async `spawn` with a promise wrapper.

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
  node dist/src/index.js --skip-preflight --phase index
  ```
  Expected: no `EINVAL` or `ENOENT` during `lms` invocation
- DEP0190 check:
  ```powershell
  node --trace-deprecation dist/src/index.js --version
  ```
  Expected: no DEP0190 warning

### 6. Idempotency & Safety Checks

- All callers use `await` — no call site changes
- Rollback: revert `src/lms.ts` only

---

## Execution Order

```
1. Read src/lms.ts (mandatory — confirm spawnSync location before editing)
2. Modify src/lms.ts (replace spawnSync with spawn wrapper)
3. npx tsc --noEmit  [must pass]
4. npx vitest run  [all tests green]
5. Windows manual smoke test (mandatory)
6. DEP0190 check
```
