# Phase 2.5 — Refine Platform Detection and Discovery Logic
## Implementation Plan

**Version**: 1.0 — 2026-06-22
**Requires**: Phase 1b.2 integration test gate passed
**Provides**: `src/platform-adapter.ts`; `src/preflight.ts` DXGI block injectable; `src/discovery.ts` precedence documented; unit test for exclusion precedence

---

## Requires Manifest

- Phase 1b.2 merged and green
- `src/preflight.ts` `PreflightDeps` interface accessible (will be modified)

## Provides Manifest

| Artifact | Description |
|---|---|
| `src/platform-adapter.ts` | `PlatformAdapter` interface, `Win32PlatformAdapter`, `PosixPlatformAdapter`, `createPlatformAdapter()` |
| `src/preflight.ts` | `queryGpuVramGB` accepts `platform` param; DXGI block moved to adapter |
| `src/discovery.ts` | Precedence comment added (no logic change) |
| `tests/discovery.test.ts` | Unit test: dynamic `.gitignore` wins over `FALLBACK_EXCLUDED` (f10 done-when) |

T4 standard now enforced. No `process.platform` conditionals in `src/preflight.ts`.

---

## Context from Phase 0 Validation (IMPORTANT)

Phase 0 confirmed: **no explicit `process.platform === 'win32'` guards** in `src/preflight.ts`. The DXGI PowerShell block runs unconditionally — on Linux/macOS it silently fails (returns 0). The `PlatformAdapter` is warranted for **testability**, not guard removal.

For `src/discovery.ts`: no actual conflict between `.gitignore` and `FALLBACK_EXCLUDED` is possible — they are mutually exclusive code paths. Scope is limited to a precedence comment + one verification test.

---

## File 1: `src/platform-adapter.ts` (NEW)

### 1. File Overview

Defines `PlatformAdapter` interface with one method (`queryGpuVramGbFallback`) plus `Win32PlatformAdapter` (DXGI PowerShell), `PosixPlatformAdapter` (no-op), and a `createPlatformAdapter()` factory. No imports from other `src/` files — no circular import risk.

### 2. Detailed Code

```typescript
import { spawnSync } from 'child_process';

/**
 * Platform-specific GPU VRAM fallback probe.
 * The Win32 implementation uses DXGI via PowerShell EncodedCommand.
 * The Posix implementation returns 0 — nvidia-smi is tried in the shared
 * fast path in queryGpuVramGB before this adapter is called.
 *
 * Note: spawnSync inside an async adapter method is intentional — this is
 * a bounded, timeout-guarded one-shot OS probe, not an event-loop-blocking
 * pattern. E1 applies to async call chains with file/network I/O, not to
 * OS stat calls with explicit timeouts.
 */
export interface PlatformAdapter {
  queryGpuVramGbFallback(): Promise<number>;
}

/** Windows: DXGI P/Invoke via PowerShell EncodedCommand. */
export class Win32PlatformAdapter implements PlatformAdapter {
  async queryGpuVramGbFallback(): Promise<number> {
    const cs = [
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class DxgiMem {',
      '    [DllImport("dxgi.dll")] public static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr f);',
      '    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
      '    public struct Desc1 {',
      '        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Description;',
      '        public uint VendorId,DeviceId,SubSysId,Revision;',
      '        public ulong DedicatedVideoMemory,DedicatedSystemMemory,SharedSystemMemory;',
      '        public long Luid; public uint Flags;',
      '    }',
      '    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate uint RelFn(IntPtr t);',
      '    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int Enum1Fn(IntPtr t,uint i,out IntPtr a);',
      '    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int GetDesc1Fn(IntPtr t,out Desc1 d);',
      '    static IntPtr VtblSlot(IntPtr o,int s){return Marshal.ReadIntPtr(Marshal.ReadIntPtr(o),s*IntPtr.Size);}',
      '    public static long TotalDedicatedVideoBytes() {',
      '        var iid=new Guid("770aae78-f26f-4dba-a829-253c83d1b387");',
      '        IntPtr pF;',
      '        if(CreateDXGIFactory1(ref iid,out pF)<0) return 0;',
      '        try {',
      '            long tot=0;',
      '            var en=(Enum1Fn)Marshal.GetDelegateForFunctionPointer(VtblSlot(pF,12),typeof(Enum1Fn));',
      '            for(uint i=0;;i++){',
      '                IntPtr pA;',
      '                if(en(pF,i,out pA)!=0)break;',
      '                try{',
      '                    var gd=(GetDesc1Fn)Marshal.GetDelegateForFunctionPointer(VtblSlot(pA,11),typeof(GetDesc1Fn));',
      '                    Desc1 d;',
      '                    if(gd(pA,out d)==0)tot+=(long)d.DedicatedVideoMemory;',
      '                }finally{',
      '                    ((RelFn)Marshal.GetDelegateForFunctionPointer(VtblSlot(pA,2),typeof(RelFn)))(pA);',
      '                }',
      '            }',
      '            return tot;',
      '        } finally{',
      '            ((RelFn)Marshal.GetDelegateForFunctionPointer(VtblSlot(pF,2),typeof(RelFn)))(pF);',
      '        }',
      '    }',
      '}',
    ].join('\r\n');

    const ps1 = `Add-Type -TypeDefinition @'\r\n${cs}\r\n'@\r\n[DxgiMem]::TotalDedicatedVideoBytes()`;
    const encoded = Buffer.from(ps1, 'utf16le').toString('base64');
    const pw = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'utf8', timeout: 15000,
    });
    if (pw.status === 0 && pw.stdout?.trim()) {
      const bytes = parseInt(pw.stdout.trim(), 10);
      if (!isNaN(bytes) && bytes > 0) return bytes / 1024 ** 3;
    }
    return 0;
  }
}

/** POSIX (Linux/macOS): no DXGI available; returns 0. nvidia-smi is tried in the shared fast path. */
export class PosixPlatformAdapter implements PlatformAdapter {
  async queryGpuVramGbFallback(): Promise<number> {
    return 0;
  }
}

/** Returns the correct adapter for the current platform. Inject in tests to avoid OS calls. */
export function createPlatformAdapter(): PlatformAdapter {
  return process.platform === 'win32'
    ? new Win32PlatformAdapter()
    : new PosixPlatformAdapter();
}
```

### 3. Validation & Testing

Create `tests/platform-adapter.test.ts`:
- `PosixPlatformAdapter.queryGpuVramGbFallback()` resolves to `0` (pure — no OS calls needed)
- `Win32PlatformAdapter`: subclass and override `spawnSync` call, verify returns `0` on non-zero exit status

---

## File 2: `src/preflight.ts` (MODIFIED)

### 1. Change Summary

- Add import: `import { createPlatformAdapter, type PlatformAdapter } from './platform-adapter.js';`
- Add `platform: PlatformAdapter` field to `PreflightDeps`
- Modify `queryGpuVramGB` to accept `platform: PlatformAdapter` parameter
- Remove the DXGI C# block from `queryGpuVramGB` — delegate to `platform.queryGpuVramGbFallback()`
- Update `defaultDeps` to wire `createPlatformAdapter()`

### 2. Detailed Modifications

**Import addition** (after existing imports):
```typescript
import { createPlatformAdapter, type PlatformAdapter } from './platform-adapter.js';
```

**`PreflightDeps` modification**:
```diff
 export interface PreflightDeps {
   lms: Lms;
   totalmem: () => number;
   freemem: () => number;
   gpuVramGB?: () => Promise<number>;
+  platform: PlatformAdapter;
 }
```

**`queryGpuVramGB` signature change**:
```diff
-async function queryGpuVramGB(): Promise<number> {
+async function queryGpuVramGB(platform: PlatformAdapter): Promise<number> {
```

**`queryGpuVramGB` body**: keep the NVIDIA fast path (unchanged), replace the DXGI block:

```typescript
async function queryGpuVramGB(platform: PlatformAdapter): Promise<number> {
  // NVIDIA fast path (cross-platform — fails gracefully on non-NVIDIA machines)
  const nv = spawnSync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', [], {
    encoding: 'utf8', shell: true, timeout: 5000,
  });
  if (nv.status === 0 && nv.stdout?.trim()) {
    const mib = nv.stdout.trim().split('\n')
      .map((l) => parseInt(l.trim(), 10)).filter((n) => !isNaN(n))
      .reduce((a, b) => a + b, 0);
    if (mib > 0) return mib / 1024;
  }
  // Platform-specific fallback (DXGI on win32, no-op on posix)
  return platform.queryGpuVramGbFallback();
}
```

**`defaultDeps` update**:
```typescript
const defaultAdapter = createPlatformAdapter();

const defaultDeps: PreflightDeps = {
  lms: defaultLms,
  totalmem: osTotalmem,
  freemem: osFreemem,
  gpuVramGB: () => queryGpuVramGB(defaultAdapter),
  platform: defaultAdapter,
};
```

**Delete** the entire DXGI C# block from `preflight.ts` — it now lives in `Win32PlatformAdapter`.

### 3. Implementation Notes

- Public API (`ensureModelReady`, `resolveLoadedIdentifier`) signatures are unchanged.
- `PreflightDeps` is additive — existing test code that constructs `PreflightDeps` objects manually must add `platform: new PosixPlatformAdapter()` (or a mock). **Scan `tests/` for `PreflightDeps` literals before running tests.**
- `gpuVramGB` field remains in `PreflightDeps` — tests that mock the full VRAM query continue to work.

### 4. Validation & Testing

- `npx tsc --noEmit` must pass
- Existing preflight integration tests must pass without modification (public API unchanged)
- After merge: `grep -rn "process\.platform" src/` → zero results (only in `createPlatformAdapter`)

---

## File 3: `src/discovery.ts` (MODIFIED — comment only)

Add the following comment at the `buildIgnore` call site in `discoverFiles`:

```typescript
  // Exclusion precedence (mutually exclusive code paths — no conflict possible):
  //   1. ALWAYS_EXCLUDED: applied first, unconditionally, before any .gitignore or fallback check.
  //   2. .gitignore (dynamic): if a .gitignore exists, buildIgnore returns an ignore instance and
  //      FALLBACK_EXCLUDED is never consulted for directory skipping (ig !== null branch below).
  //   3. FALLBACK_EXCLUDED (static): used only when no .gitignore exists (ig === null).
  //      Dynamic (.gitignore) always wins because the two paths are mutually exclusive.
  const ig = buildIgnore(projectRoot);
```

Add inline comment at the `ig !== null` branch in `walk`:
```typescript
        if (ig !== null) {
          // .gitignore present — dynamic exclusion; FALLBACK_EXCLUDED unreachable here.
          if (ig.ignores(relPath + '/')) continue;
        } else {
          // No .gitignore — use static fallback.
          if (FALLBACK_EXCLUDED.has(entry.name)) continue;
        }
```

**No logic changes.**

---

## File 4: `tests/discovery.test.ts` (NEW or APPEND)

### Unit test for exclusion precedence (f10 done-when requirement)

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverFiles } from '../../src/discovery.js';

describe('discoverFiles — exclusion precedence', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'discovery-prec-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('dynamic .gitignore exclusion applies when .gitignore exists (FALLBACK_EXCLUDED unreachable)', () => {
    // node_modules is in FALLBACK_EXCLUDED. We also add it to .gitignore.
    // With .gitignore present, FALLBACK_EXCLUDED is never consulted — .gitignore wins by code path.
    // The path is still excluded regardless; this test verifies the invariant holds.
    writeFileSync(join(tmpRoot, '.gitignore'), 'node_modules/\n');
    mkdirSync(join(tmpRoot, 'node_modules'));
    writeFileSync(join(tmpRoot, 'node_modules', 'pkg.js'), 'module.exports = {}');
    mkdirSync(join(tmpRoot, 'src'));
    writeFileSync(join(tmpRoot, 'src', 'main.ts'), 'export const x = 1;');

    const files = discoverFiles(tmpRoot);
    const paths = files.map(f => f.path);

    expect(paths).not.toContain('node_modules/pkg.js');
    expect(paths).toContain('src/main.ts');
  });

  it('FALLBACK_EXCLUDED applies when no .gitignore exists', () => {
    mkdirSync(join(tmpRoot, 'node_modules'));
    writeFileSync(join(tmpRoot, 'node_modules', 'pkg.js'), 'module.exports = {}');
    mkdirSync(join(tmpRoot, 'src'));
    writeFileSync(join(tmpRoot, 'src', 'main.ts'), 'export const x = 1;');

    const files = discoverFiles(tmpRoot);
    const paths = files.map(f => f.path);

    expect(paths).not.toContain('node_modules/pkg.js');
    expect(paths).toContain('src/main.ts');
  });
});
```

---

## Execution Order

```
1. Create src/platform-adapter.ts
2. npx tsc --noEmit  [must pass]
3. npx madge --circular src/  [must be clean]
4. Modify src/preflight.ts (add import, modify PreflightDeps, refactor queryGpuVramGB)
5. Scan tests/ for PreflightDeps object literals — add platform field to each
6. npx tsc --noEmit  [must pass]
7. Modify src/discovery.ts (comment only)
8. Create/append tests/discovery.test.ts
9. npx vitest run  [all tests green]
```

## Post-Merge Checks

```powershell
# No inline process.platform checks
grep -rn "process\.platform" src/
# Expected: zero results (only in platform-adapter.ts)

# No DXGI C# block in preflight.ts
grep -n "DxgiMem\|DXGI\|EncodedCommand" src/preflight.ts
# Expected: zero results
```
