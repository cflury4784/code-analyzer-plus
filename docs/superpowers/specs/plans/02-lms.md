# Plan 02 — `src/lms.ts` (`lms` CLI runner)

**Phase:** P2 of the LM Studio Preflight feature.
**Provides:** `lms.ts:LoadedModel`, `lms.ts:runLms`, `lms.ts:serverStatus`, `lms.ts:startServer`, `lms.ts:listLoaded`, `lms.ts:unloadAll`, `lms.ts:estimateTotalGB`, `lms.ts:load`, `lms.ts:Lms` (type of the wrapper bundle)
**Requires:** (none — leaf module; depends only on `child_process`)

Self-contained. Creates one new module wrapping the `lms` binary. All `--json` parsing is
defensive. `runLms` is the single seam that spawns the binary, so tests mock only `runLms`.

---

## File: `src/lms.ts`

### 1. File Overview
Thin, single-purpose async wrappers over the `lms` (LM Studio) CLI. Every function that parses
`--json` validates the shape and throws a **labeled** error rather than leaking a bare
`SyntaxError`. `runLms` centralizes process spawning (mirroring `src/claude-cli.ts`'s
`spawnSync` usage, which is proven on this Windows host) and applies an optional timeout.

### 2. Change Summary
`create` — `src/lms.ts`.

### 3. Detailed Code Modifications
Create the file with this content:

```ts
import { spawnSync } from 'child_process';

export interface LoadedModel {
  identifier: string;
  [k: string]: unknown;
}

export interface RunOpts {
  timeoutMs?: number;
}

/** Type of the runLms seam — exported so tests can type their mocks without `typeof` gymnastics. */
export type RunLms = typeof runLms;

/** Strip ANSI escape sequences (lms human output may be colored on a TTY). */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * The single seam that spawns the `lms` binary. Async signature (callers await), but uses
 * spawnSync internally to match the proven approach in src/claude-cli.ts on this Windows host.
 * `shell: true` lets Windows resolve `lms` whether it is an .exe or a .cmd shim.
 * Throws a labeled Error on missing binary, timeout, or non-zero exit.
 */
export async function runLms(args: string[], opts: RunOpts = {}): Promise<string> {
  const res = spawnSync('lms', args, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: true,
    timeout: opts.timeoutMs,
  });
  if (res.error) {
    const e = res.error as NodeJS.ErrnoException;
    if (e.code === 'ETIMEDOUT') {
      throw new Error(`lms ${args[0] ?? ''} timed out after ${(opts.timeoutMs ?? 0) / 1000}s`);
    }
    if (e.code === 'ENOENT') {
      throw new Error('lms binary not found on PATH — is LM Studio CLI installed?');
    }
    throw new Error(`lms ${args[0] ?? ''} failed: ${e.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`lms ${args.join(' ')} exited ${res.status}: ${(res.stderr || '').trim()}`);
  }
  return res.stdout ?? '';
}

/** Defensive JSON parse with a labeled error and a validator. */
function parseJson<T>(cmdLabel: string, raw: string, validate: (v: unknown) => v is T): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`lms ${cmdLabel} returned unparseable output: ${raw.slice(0, 200)}`);
  }
  if (!validate(parsed)) {
    throw new Error(`lms ${cmdLabel} returned unexpected shape: ${raw.slice(0, 200)}`);
  }
  return parsed;
}

export async function serverStatus(deps: { runLms: typeof runLms } = { runLms }): Promise<{ running: boolean; port: number }> {
  const raw = await deps.runLms(['server', 'status', '--json', '--quiet']);
  return parseJson('server status', raw, (v): v is { running: boolean; port: number } =>
    typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).running === 'boolean');
}

export async function startServer(
  deps: { runLms: typeof runLms; serverStatus: typeof serverStatus } = { runLms, serverStatus },
  pollBudgetMs = 30_000,
  pollIntervalMs = 1_000,
): Promise<void> {
  await deps.runLms(['server', 'start']);
  const deadline = Date.now() + pollBudgetMs;
  // Provisional ~30s budget: a cold start with ROCm runtime init can exceed 15s.
  while (Date.now() < deadline) {
    const s = await deps.serverStatus({ runLms: deps.runLms });
    if (s.running) return;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`lms server did not report running within ${pollBudgetMs / 1000}s`);
}

export async function listLoaded(deps: { runLms: typeof runLms } = { runLms }): Promise<LoadedModel[]> {
  const raw = await deps.runLms(['ps', '--json']);
  return parseJson('ps', raw, (v): v is LoadedModel[] =>
    Array.isArray(v) && v.every((e) => typeof e === 'object' && e !== null && typeof (e as Record<string, unknown>).identifier === 'string'));
}

export async function unloadAll(deps: { runLms: typeof runLms } = { runLms }): Promise<void> {
  await deps.runLms(['unload', '--all']);
}

/**
 * Returns the RAW parsed `Estimated Total Memory` in GiB (no margin/rounding — preflight
 * applies those). Throws a labeled error if the line is absent/unparseable. Used only for
 * unknown overrides (F4).
 */
export async function estimateTotalGB(
  loadKey: string,
  contextLength: number,
  deps: { runLms: typeof runLms } = { runLms },
): Promise<number> {
  const raw = stripAnsi(await deps.runLms([
    'load', loadKey, '--parallel', '1', '--context-length', String(contextLength), '--estimate-only',
  ]));
  // Example line: "Estimated Total Memory: 18.52 GiB" (tolerant of ANSI/spacing, stripped above)
  const m = raw.match(/Estimated Total Memory:[^\d]*?([\d.]+)\s*GiB/i);
  if (!m) {
    throw new Error(`lms estimate-only: could not parse Estimated Total Memory from: ${raw.slice(0, 200)}`);
  }
  return parseFloat(m[1]);
}

export interface LoadOpts {
  contextLength: number;
  parallel?: number;
  timeoutMs?: number;
}

const DEFAULT_LOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Loads a model with auto-fit (NO --gpu flag — `--gpu max` would disable auto-fit and OOM-crash
 * >12GB models on this APU). Bounded timeout so a hung load fails with a labeled error.
 */
export async function load(
  loadKey: string,
  opts: LoadOpts,
  deps: { runLms: typeof runLms } = { runLms },
): Promise<void> {
  const parallel = opts.parallel ?? 1;
  await deps.runLms(
    ['load', loadKey, '--parallel', String(parallel), '--context-length', String(opts.contextLength), '--yes'],
    { timeoutMs: opts.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS },
  );
}

/** Bundle type so preflight can accept an injectable `lms` dependency. */
export interface Lms {
  serverStatus: typeof serverStatus;
  startServer: typeof startServer;
  listLoaded: typeof listLoaded;
  unloadAll: typeof unloadAll;
  estimateTotalGB: typeof estimateTotalGB;
  load: typeof load;
}

export const lms: Lms = { serverStatus, startServer, listLoaded, unloadAll, estimateTotalGB, load };
```

### 4. Implementation Notes
- **Why `spawnSync` + `shell:true`:** matches the proven `src/claude-cli.ts` pattern on this
  Windows host; `shell:true` ensures `lms` resolves whether installed as `.exe` or `.cmd`.
  The async signature is preserved so the orchestrator can `await`; the body is synchronous,
  which is acceptable because `runLms` is the mocked seam in tests.
- **Dependency injection:** each wrapper takes an optional `deps` last arg defaulting to the
  real `runLms`/`serverStatus`. Tests inject a fake `runLms`. The exported `lms` bundle is what
  `preflight.ts` consumes by default.
- **No `--gpu` anywhere.** This is load-bearing (see Host context in the spec). Do not add it.
- `--estimate-only` parses human (non-`--json`) output. `estimateTotalGB` **strips ANSI first**
  (`stripAnsi`) and uses the tolerant regex `/Estimated Total Memory:[^\d]*?([\d.]+)\s*GiB/i`,
  so colored TTY output is handled. This is committed, not conditional.
- `LoadedModel` is intentionally open (`[k: string]: unknown`) — we only depend on `identifier`.

### 5. Validation & Testing
- `npx tsc --noEmit` passes (covers `src/`; `lms.ts` lives there).
- These wrappers are unit-tested in `tests/lms.test.ts` (Phase 3) via a mocked `runLms`,
  including the defensive-parse scenarios (malformed/zero-exit non-JSON → labeled error) and the
  ANSI estimate-parse fixture. Type-check the tests with `npm run typecheck:tests` (Phase 4).
- Manual smoke (optional, requires LM Studio): `node -e "import('./dist/lms.js').then(async m=>console.log(await m.serverStatus()))"` prints `{ running: ..., port: 1234 }`.

### 6. Idempotency & Safety Checks
- `serverStatus`, `listLoaded`, `estimateTotalGB` are read-only.
- `unloadAll` is only invoked by preflight when a load is actually required (see Phase 3); on
  its own it is safe to call repeatedly (unloading nothing is a no-op for `lms`).
- `load` re-loading the same model is safe; preflight avoids redundant loads via its
  already-loaded short-circuit (Phase 3).
- No file writes; the only side effects are LM Studio lifecycle calls.
