# Plan 03 — `src/preflight.ts` + `tests/preflight.test.ts` (orchestrator + unit tests)

**Phase:** P3 of the LM Studio Preflight feature.
**Provides:** `preflight.ts:ensureModelReady`, `preflight.ts:resolveLoadedIdentifier`, `preflight.ts:InsufficientResourcesError`, `preflight.ts:PreflightDeps`
**Requires:** `models.ts:*` (Phase 1), `lms.ts:*` (Phase 2)

Executes after Phases 1 and 2 exist. Creates the orchestrator and its unit tests. Subagents
never wrote files — the orchestrator persists this.

---

## File: `src/preflight.ts`

### 1. File Overview
The orchestrator. `ensureModelReady` brings LM Studio to a ready state (server up, desired
model loaded) and returns the **live identifier** for the API `model` field.
`resolveLoadedIdentifier` is the lightweight per-phase revalidation helper.
`InsufficientResourcesError` is the distinct abort type. All `lms`/OS access goes through an
injectable `PreflightDeps` so tests never touch real hardware.

### 2. Change Summary
`create` — `src/preflight.ts`.

### 3. Detailed Code Modifications
Create the file:

```ts
import { totalmem as osTotalmem, freemem as osFreemem } from 'os';
import { MODEL_REGISTRY, type ModelSpec, FREE_FLOOR_GB, ESTIMATE_MARGIN_GB } from './models.js';
import { lms as defaultLms, type Lms } from './lms.js';
import type { Logger } from './logger.js';

export class InsufficientResourcesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientResourcesError';
  }
}

export interface PreflightDeps {
  lms: Lms;
  totalmem: () => number;
  freemem: () => number;
}

const defaultDeps: PreflightDeps = { lms: defaultLms, totalmem: osTotalmem, freemem: osFreemem };

const toGiB = (bytes: number): number => bytes / 1024 ** 3;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Registry lookup, or an ad-hoc spec for an unknown --model-override (F4). */
function resolveSpec(modelName: string): { spec: ModelSpec; known: boolean } {
  const known = MODEL_REGISTRY[modelName];
  if (known) return { spec: known, known: true };
  return {
    spec: {
      loadKey: modelName,
      identifierMatch: new RegExp(escapeRegex(modelName), 'i'),
      requiredTotalGB: 0, // computed at the resource-check step for unknown overrides
    },
    known: false,
  };
}

/**
 * Ensure the server is up and `modelName` is loaded; return the live identifier `lms ps`
 * reports (the value to send as the API `model` field). Throws InsufficientResourcesError
 * if the box cannot hold the model, or a labeled Error on lms/lifecycle failures.
 */
export async function ensureModelReady(
  modelName: string,
  numCtx: number,
  logger: Logger,
  deps: PreflightDeps = defaultDeps,
): Promise<string> {
  const { spec, known } = resolveSpec(modelName);

  // 1. Server up?
  const status = await deps.lms.serverStatus();
  if (!status.running) {
    logger.info('LM Studio server not running — starting');
    await deps.lms.startServer();
  }

  // 2. Desired already loaded? -> short-circuit (no unload, no resource check, no reload)
  let loaded = await deps.lms.listLoaded();
  let match = loaded.find((m) => spec.identifierMatch.test(m.identifier));
  if (match) {
    logger.info('model already loaded', { model: match.identifier });
    return match.identifier;
  }

  // 3. Unload first — before the resource check so it reflects a clean slate.
  logger.info('unloading current model(s) before load');
  await deps.lms.unloadAll();

  // 4. Resource check (os.totalmem is true capacity here — no carveout).
  let requiredTotalGB = spec.requiredTotalGB;
  let skipCapacityGate = false;
  if (!known) {
    try {
      const est = await deps.lms.estimateTotalGB(spec.loadKey, numCtx);
      requiredTotalGB = Math.ceil(est + ESTIMATE_MARGIN_GB);
    } catch (err) {
      logger.warn('estimate-only failed; skipping capacity gate for override', { err: String(err) });
      skipCapacityGate = true; // backstop = labeled load failure at step 5
    }
  }
  const totalGiB = round1(toGiB(deps.totalmem()));
  if (!skipCapacityGate && totalGiB < requiredTotalGB) {
    throw new InsufficientResourcesError(
      `Cannot load ${modelName}: needs ~${requiredTotalGB} GB total memory, machine has ${totalGiB} GB`,
    );
  }
  const freeGiB = round1(toGiB(deps.freemem()));
  if (freeGiB < FREE_FLOOR_GB) {
    throw new InsufficientResourcesError(
      `Cannot load ${modelName}: only ${freeGiB} GB free after unload — close other apps`,
    );
  }

  // 5. Load (auto-fit, no --gpu, parallel 1).
  logger.info('loading model', { model: spec.loadKey, ctx: numCtx });
  await deps.lms.load(spec.loadKey, { contextLength: numCtx, parallel: 1 });

  // 6. Read back the live identifier.
  loaded = await deps.lms.listLoaded();
  match = loaded.find((m) => spec.identifierMatch.test(m.identifier));
  if (!match) {
    throw new Error(`load reported success but ${modelName} is not visible in lms ps`);
  }
  logger.info('model ready', { model: match.identifier });
  return match.identifier;
}

/**
 * Lightweight per-phase revalidation (F3). Returns the live identifier if the model is still
 * loaded. On no match:
 *  - readOnly:true  (used under --skip-preflight) -> throw; never unload/reload.
 *  - readOnly:false (normal path) -> recover via a full ensureModelReady.
 * `numCtx` is needed for the readOnly:false recovery path's load.
 */
export async function resolveLoadedIdentifier(
  modelName: string,
  numCtx: number,
  logger: Logger,
  opts: { readOnly: boolean },
  deps: PreflightDeps = defaultDeps,
): Promise<string> {
  const { spec } = resolveSpec(modelName);
  const status = await deps.lms.serverStatus();
  if (status.running) {
    const loaded = await deps.lms.listLoaded();
    const match = loaded.find((m) => spec.identifierMatch.test(m.identifier));
    if (match) return match.identifier;
  }
  if (opts.readOnly) {
    throw new Error(`model ${modelName} is no longer loaded (server down or model evicted)`);
  }
  logger.warn('model not loaded on revalidation — recovering', { model: modelName });
  return ensureModelReady(modelName, numCtx, logger, deps);
}
```

### 4. Implementation Notes
- **Signature refinement vs spec:** `resolveLoadedIdentifier` takes `numCtx` (the spec listed
  it without). This is required because the `readOnly:false` recovery calls `ensureModelReady`,
  which needs `numCtx` to load. `index.ts` (Phase 4) has `numCtx` in scope at the call sites.
- **Calling the lms bundle:** preflight calls `deps.lms.serverStatus()` etc. with no args; the
  real wrappers fall back to their own default `runLms`. Tests pass a fake `lms` bundle.
- **`known` flag** drives whether the estimate-only path runs (unknown overrides only).
  Registry models use their static `requiredTotalGB`.
- **Skip-capacity-gate** only suppresses the `totalmem` gate; the `freemem` floor still applies.
- **Ordering guarantee:** unload (step 3) precedes the resource check (step 4) precedes load
  (step 5) by construction; the cold-load test asserts this.
- All GiB math via `toGiB`/`round1`; messages show one decimal.

### 5. Validation & Testing
Covered by `tests/preflight.test.ts` below; `npx tsc --noEmit` and `npm run test:run` pass.

### 6. Idempotency & Safety Checks
- Already-loaded short-circuit (step 2) makes a correct, already-ready state a no-op.
- `unloadAll` runs only when a load is required.
- No file writes; only LM Studio lifecycle side effects.

---

## File: `tests/preflight.test.ts`

### 1. File Overview
Vitest unit tests. Two layers: (a) the real `lms.ts` wrappers with a mocked `runLms` (parsing,
defensive errors, arg construction — including "no `--gpu`, `--parallel 1`"); (b) the
`preflight.ts` orchestration with a fully faked `lms` bundle and injected `totalmem`/`freemem`.

### 2. Change Summary
`create` — `tests/preflight.test.ts`.

### 3. Detailed Code Modifications
Create the file:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  ensureModelReady,
  resolveLoadedIdentifier,
  InsufficientResourcesError,
  type PreflightDeps,
} from '../src/preflight.js';
import { type Lms } from '../src/lms.js';
import type { Logger } from '../src/logger.js';

const GiB = 1024 ** 3;
const noopLogger: Logger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };

/** Build a fake lms bundle; `calls` records invocation order. */
function makeLms(overrides: Partial<Lms> = {}, calls: string[] = []): Lms {
  return {
    serverStatus: vi.fn(async () => { calls.push('serverStatus'); return { running: true, port: 1234 }; }),
    startServer: vi.fn(async () => { calls.push('startServer'); }),
    listLoaded: vi.fn(async () => { calls.push('listLoaded'); return []; }),
    unloadAll: vi.fn(async () => { calls.push('unloadAll'); }),
    estimateTotalGB: vi.fn(async () => { calls.push('estimateTotalGB'); return 18.5; }),
    load: vi.fn(async () => { calls.push('load'); }),
    ...overrides,
  } as Lms;
}

function makeDeps(lms: Lms, totalGiB = 31.15, freeGiB = 21.6): PreflightDeps {
  return { lms, totalmem: () => totalGiB * GiB, freemem: () => freeGiB * GiB };
}

const M = 'qwen3.6-35b-a3b';
const ID = 'qwen3.6-35b-a3b@q3_k_s';

describe('ensureModelReady', () => {
  it('1. short-circuits when the desired model is already loaded', async () => {
    const calls: string[] = [];
    const lms = makeLms({ listLoaded: vi.fn(async () => { calls.push('listLoaded'); return [{ identifier: ID }]; }) }, calls);
    const id = await ensureModelReady(M, 64000, noopLogger, makeDeps(lms));
    expect(id).toBe(ID);
    expect(lms.unloadAll).not.toHaveBeenCalled();
    expect(lms.load).not.toHaveBeenCalled();
  });

  it('2. cold load: unload -> resource check -> load, with parallel 1 and no --gpu', async () => {
    const calls: string[] = [];
    let psCall = 0;
    const lms = makeLms({
      listLoaded: vi.fn(async () => { calls.push('listLoaded'); return psCall++ === 0 ? [] : [{ identifier: ID }]; }),
    }, calls);
    const id = await ensureModelReady(M, 64000, noopLogger, makeDeps(lms));
    expect(id).toBe(ID);
    // ordering: unloadAll before load
    expect(calls.indexOf('unloadAll')).toBeLessThan(calls.indexOf('load'));
    // load called with parallel 1 and contextLength; the wrapper omits --gpu (asserted in wrapper tests)
    expect(lms.load).toHaveBeenCalledWith(ID, { contextLength: 64000, parallel: 1 });
  });

  it('3. throws InsufficientResourcesError when totalmem < requiredTotalGB; no load', async () => {
    const lms = makeLms();
    await expect(ensureModelReady(M, 64000, noopLogger, makeDeps(lms, 16))).rejects.toBeInstanceOf(InsufficientResourcesError);
    expect(lms.unloadAll).toHaveBeenCalled();
    expect(lms.load).not.toHaveBeenCalled();
  });

  it('4. throws on free-floor breach even when totalmem is OK; no load', async () => {
    const lms = makeLms();
    await expect(ensureModelReady(M, 64000, noopLogger, makeDeps(lms, 31.15, 1.0))).rejects.toBeInstanceOf(InsufficientResourcesError);
    expect(lms.load).not.toHaveBeenCalled();
  });

  it('5. starts the server when it is down, then proceeds', async () => {
    const calls: string[] = [];
    let psCall = 0;
    const lms = makeLms({
      serverStatus: vi.fn(async () => { calls.push('serverStatus'); return { running: false, port: 1234 }; }),
      listLoaded: vi.fn(async () => { calls.push('listLoaded'); return psCall++ === 0 ? [] : [{ identifier: ID }]; }),
    }, calls);
    await ensureModelReady(M, 64000, noopLogger, makeDeps(lms));
    expect(lms.startServer).toHaveBeenCalled();
  });

  it('6. throws when load succeeds but the model is not visible afterward', async () => {
    const lms = makeLms({ listLoaded: vi.fn(async () => []) }); // never matches
    await expect(ensureModelReady(M, 64000, noopLogger, makeDeps(lms))).rejects.toThrow(/not visible/);
  });

  it('7a. unknown override: uses estimateTotalGB + margin for the requirement', async () => {
    const calls: string[] = [];
    let psCall = 0;
    const lms = makeLms({
      estimateTotalGB: vi.fn(async () => { calls.push('estimateTotalGB'); return 18.5; }),
      listLoaded: vi.fn(async () => { calls.push('listLoaded'); return psCall++ === 0 ? [] : [{ identifier: 'some-custom-model' }]; }),
    }, calls);
    const id = await ensureModelReady('some-custom-model', 64000, noopLogger, makeDeps(lms, 31.15));
    expect(id).toBe('some-custom-model');
    expect(lms.estimateTotalGB).toHaveBeenCalled();
  });

  it('7b. unknown override with unparseable estimate: skips capacity gate, still loads', async () => {
    let psCall = 0;
    const lms = makeLms({
      estimateTotalGB: vi.fn(async () => { throw new Error('could not parse'); }),
      listLoaded: vi.fn(async () => psCall++ === 0 ? [] : [{ identifier: 'custom' }]),
    });
    // totalmem deliberately tiny — capacity gate must be skipped, so no throw
    const id = await ensureModelReady('custom', 64000, noopLogger, makeDeps(lms, 4));
    expect(id).toBe('custom');
    expect(lms.load).toHaveBeenCalled();
  });
});

describe('resolveLoadedIdentifier (F3)', () => {
  it('10a. returns the live identifier when still loaded', async () => {
    const lms = makeLms({ listLoaded: vi.fn(async () => [{ identifier: ID }]) });
    const id = await resolveLoadedIdentifier(M, 64000, noopLogger, { readOnly: false }, makeDeps(lms));
    expect(id).toBe(ID);
    expect(lms.unloadAll).not.toHaveBeenCalled();
  });

  it('10b. readOnly:true throws when the model vanished (never reloads)', async () => {
    const lms = makeLms({ listLoaded: vi.fn(async () => []) });
    await expect(resolveLoadedIdentifier(M, 64000, noopLogger, { readOnly: true }, makeDeps(lms)))
      .rejects.toThrow(/no longer loaded/);
    expect(lms.unloadAll).not.toHaveBeenCalled();
    expect(lms.load).not.toHaveBeenCalled();
  });

  it('10c. readOnly:false self-heals via ensureModelReady when the match disappears', async () => {
    let psCall = 0;
    const lms = makeLms({
      // first listLoaded (revalidation) empty; subsequent (recovery) returns the model
      listLoaded: vi.fn(async () => psCall++ === 0 ? [] : [{ identifier: ID }]),
    });
    const id = await resolveLoadedIdentifier(M, 64000, noopLogger, { readOnly: false }, makeDeps(lms));
    expect(id).toBe(ID);
    expect(lms.load).toHaveBeenCalled();
  });
});
```

Add a second test file (or describe block) for the wrappers — see `tests/lms.test.ts` below
(kept separate so the `runLms` mock is isolated).

## File: `tests/lms.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { serverStatus, listLoaded, load, estimateTotalGB, type RunLms } from '../src/lms.js';

describe('lms wrappers (mocked runLms)', () => {
  it('8a. serverStatus throws a labeled error on non-JSON zero-exit output', async () => {
    const runLms: RunLms = (async () => 'not json at all') as unknown as RunLms;
    await expect(serverStatus({ runLms })).rejects.toThrow(/unparseable output/);
  });

  it('8b. listLoaded throws a labeled error on wrong shape', async () => {
    const runLms: RunLms = (async () => '{"foo":1}') as unknown as RunLms;
    await expect(listLoaded({ runLms })).rejects.toThrow(/unexpected shape/);
  });

  it('2b. load builds args with --parallel 1 and NO --gpu', async () => {
    const seen: string[][] = [];
    const runLms: RunLms = (async (args: string[]) => { seen.push(args); return ''; }) as unknown as RunLms;
    await load('qwen3.6-35b-a3b@q3_k_s', { contextLength: 64000, parallel: 1 }, { runLms });
    const args = seen[0];
    expect(args).toContain('--parallel');
    expect(args[args.indexOf('--parallel') + 1]).toBe('1');
    expect(args).toContain('--context-length');
    expect(args).toContain('--yes');
    expect(args).not.toContain('--gpu');
  });

  it('7c. estimateTotalGB parses the Estimated Total Memory line', async () => {
    const runLms: RunLms = (async () => 'Model: x\nEstimated Total Memory: 18.52 GiB\n') as unknown as RunLms;
    await expect(estimateTotalGB('x', 64000, { runLms })).resolves.toBeCloseTo(18.52, 2);
  });

  it('7d. estimateTotalGB throws when the line is absent', async () => {
    const runLms: RunLms = (async () => 'no estimate here') as unknown as RunLms;
    await expect(estimateTotalGB('x', 64000, { runLms })).rejects.toThrow(/Estimated Total Memory/);
  });

  it('7e. estimateTotalGB parses through ANSI color codes', async () => {
    const ansi = '\x1b[31mEstimated Total Memory:\x1b[0m \x1b[1m18.52\x1b[0m GiB\n';
    const runLms: RunLms = (async () => ansi) as unknown as RunLms;
    await expect(estimateTotalGB('x', 64000, { runLms })).resolves.toBeCloseTo(18.52, 2);
  });
});
```

### 4. Implementation Notes
- Two test files: `tests/preflight.test.ts` (orchestration, faked `lms` bundle) and
  `tests/lms.test.ts` (wrappers, mocked `runLms`). This isolates the seams cleanly.
- The fake `lms` bundle's methods accept being called with no args (matching how preflight
  calls them). The `as Lms` cast tolerates the optional-deps signatures.
- Test 11 (model-free phase skip) is **index-level** and is covered in Phase 4.
- `toBeCloseTo`, `toBeInstanceOf`, `rejects.toThrow` are all built into vitest.

### 5. Validation & Testing
- `npm run test:run` → all scenarios green.
- `npx tsc --noEmit` covers `src/` only (tsconfig excludes `tests/`). To type-check the tests,
  run the tests-inclusive command added in Phase 4 (`npm run typecheck:tests`). The test files
  import the explicit `RunLms` type exported by `lms.ts`, so they type-check cleanly.

### 6. Idempotency & Safety Checks
- Tests are hermetic — no real `lms`, no real OS memory reads, no network, no file writes.
- Re-running tests is deterministic (mocks return fixed values; `psCall` counters reset per test).
