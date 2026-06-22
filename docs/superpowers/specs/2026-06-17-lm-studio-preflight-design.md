# LM Studio Preflight — Design

**Date:** 2026-06-17
**Status:** Approved (brainstorming + Stage-A gate); empirically re-benchmarked
**Component:** `code-analyzer` CLI

## Problem

`code-analyzer` calls LM Studio over HTTP (`src/lm-studio.ts`) but never verifies that
the server is running or that the intended model is loaded. When the server is down or no
model is loaded, the run fails on the first batch with a connection error
(`LM Studio connection failed … is LM Studio running on http://localhost:1234/...`) after
discovery has already completed. The user must manually start the server and load a model,
then re-run.

This design adds an automatic **preflight** that validates LM Studio state and brings it
to a ready state before any model-using phase runs, and switches the default model to a
stronger one that the host can actually run.

## Host context (drives several decisions)

- **Machine:** AMD Ryzen AI Max "Strix Halo" class APU. Integrated **Radeon 8060S** GPU,
  **32 GB unified memory**. LM Studio uses the **ROCm** llama.cpp runtime.
- **Memory model (measured, not assumed):** memory is **genuinely unified and dynamically
  allocated** — there is **no fixed boot carveout** reducing what the OS sees. On this host
  `os.totalmem()` = **31.15 GiB** (the full box) and `os.freemem()` ≈ **21.6 GiB** when idle
  (the rest is normal OS/app usage of the shared pool). The resource gate can therefore trust
  `os.totalmem()` as true capacity. `nvidia-smi` does not exist; WMI reports a bogus `0.5 GB`
  adapter RAM for the iGPU.
- **`--gpu max` is harmful here (measured).** The ~12 GB ceiling is a **HIP/ROCm VRAM-heap
  runtime limit**, *not* a reduction of `totalmem`. Passing `--gpu max` pins all layers to
  that ~12 GB VRAM heap and **disables llama.cpp's auto-fit**, so any model larger than it
  (the 35B, the 27B) **OOM-crashes on load** despite plenty of free unified memory. **Omitting
  `--gpu`** lets auto-fit place what fits in the VRAM heap and spill the remainder into the
  rest of the unified pool — the larger models then load successfully.
- **Benchmarks (auto-fit, `--parallel 1`, ctx 64000):**
  - `qwen3.6-35b-a3b@q3_k_s` (MoE, 3B active/token): **loads at full 64k**, **~8.9 tok/s**.
  - `qwen/qwen3.5-9b` (dense): loads, **~8.7 tok/s**.
  - The 35B-A3B MoE runs at the **same speed as the 9B** (only 3B params active) while being
    a much stronger model — so it is the right default once `--gpu max` is removed.
  - Footprint is roughly **flat across context** at `--parallel 1` (weights dominate; KV is
    small), so the 64k default is kept.
- **Headroom is thin:** with the 35B-A3B loaded, the system partition has on the order of
  ~1 GB free while other heavy apps run. Acceptable standalone; the resource check below
  guards against running when memory is genuinely exhausted.

## Goals

1. Before any **model-using** phase runs, ensure: LM Studio server is up **and** the
   intended model is loaded.
2. If the intended model is not already loaded, **unload any currently-loaded model first**,
   **then** validate the machine has enough memory to load the intended model.
3. If resources are insufficient, **abort with a clear required-vs-available message** — no
   silent downgrade, no blind load attempt.
4. Start the server and load the model (auto-fit, no `--gpu max`, `--parallel 1`) when needed.
5. Switch the default model from `qwen/qwen3.5-9b` to **Qwen3.6-35B-A3B Q3_K_S**.

## Non-goals

- No automatic model download (assumes the model is present locally).
- No fallback/auto-downgrade to a smaller model on low resources (explicitly rejected).
- No change to the HTTP call path beyond which `model` identifier is passed.
- No attempt to raise the BIOS/Adrenalin VRAM carveout from code (a hardware/config action).

## Decisions

| Decision | Choice |
|---|---|
| Default model | **Qwen3.6-35B-A3B Q3_K_S** — load key `qwen3.6-35b-a3b@q3_k_s` |
| Load flags | **Omit `--gpu`** (auto-fit), `--parallel 1`, `--context-length <numCtx>`, `--yes` |
| Preflight trigger | **Always runs**, with a `--skip-preflight` opt-out flag |
| Preflight + model-free phases | **Skip preflight** when the resolved phase set has no model-using phase (`--phase aggregate`) — F2 |
| Insufficient resources | **Abort** with required-vs-available message |
| Correct model already loaded | **Skip** unload/reload entirely (no churn) |
| Resource basis | Static per-model `requiredTotalGB` vs `os.totalmem()`, plus a `freemem()` floor — GiB (1024³), one-decimal — F7 |
| `--skip-preflight` API model | Resolve via a **read-only `lms ps`** lookup; error if nothing is loaded — F1 |
| Identifier lifetime | **Re-validate per model-using phase** with a lightweight `listLoaded` match — F3 |
| Unknown `--model-override` | Derive `requiredTotalGB` from `lms load --estimate-only`; `identifierMatch` from the key; load as-is — F4 |
| API `model` value | The **live identifier read back from `lms ps`** after load, not the logical name |
| `lms load` timeout | Bounded (default ~10 min, mirrors the existing HTTP timeout) — F8 |

## Architecture

Three new modules plus wiring in the existing entry point. All `lms`/OS interaction is
funneled through injectable seams so unit tests never touch real hardware.

### `src/models.ts` — model registry

Keyed by the analyzer's **logical** model name:

```ts
export interface ModelSpec {
  loadKey: string;         // model key passed to `lms load` (NOT a .gguf path — see note)
  identifierMatch: RegExp; // matches the identifier `lms ps` reports when loaded
  requiredTotalGB: number; // min total unified memory (os.totalmem) to load at default ctx
}

export const MODEL_REGISTRY: Record<string, ModelSpec> = {
  'qwen3.6-35b-a3b': {
    loadKey: 'qwen3.6-35b-a3b@q3_k_s',
    identifierMatch: /qwen3\.6-35b-a3b@q3_k_s/i,
    requiredTotalGB: 30, // total unified footprint (weights+KV+runtime); passes on the 31.15 GiB box, rejects <32 GB machines
  },
  'qwen/qwen3.5-9b': {
    loadKey: 'qwen/qwen3.5-9b',
    identifierMatch: /qwen3\.5-9b/i,
    requiredTotalGB: 18,
  },
};

export const DEFAULT_MODEL = 'qwen3.6-35b-a3b';

// Coarse sanity floor (see Resource check). Sampled post-unload/pre-load. Well below the
// ~21.6 GiB idle freemem on this host, so it never fires in normal use, but catches a box
// already heavily consumed by other processes. Precise fit is delegated to auto-fit + the
// labeled load-failure path, not to this floor. Provisional.
export const FREE_FLOOR_GB = 4.0;

// Margin added to a parsed `--estimate-only` total for unknown overrides (F4).
export const ESTIMATE_MARGIN_GB = 1.0;
```

**Why `loadKey`, not a `.gguf` path:** loading by the full relative `.gguf` path
(`unsloth/Qwen3.6-35B-A3B-GGUF/…-Q3_K_S.gguf`) fails with `--yes` ("select a model
interactively") because multiple quants share the model folder. The disambiguated **model
key** (`qwen3.6-35b-a3b@q3_k_s`, as reported by `lms ls --json`'s `modelKey`) is the
correct load identifier and is also what the loaded model reports as its API identifier.

**Unknown `--model-override` (F4):** when the override key is **not** in the registry,
preflight treats the string as the `loadKey` verbatim and derives `identifierMatch` by
escaping the key and matching it case-insensitively. `requiredTotalGB` is computed at
runtime: call `estimateTotalGB(loadKey, numCtx)` (raw parsed GiB from `--estimate-only`),
then **preflight** applies `requiredTotalGB = Math.ceil(estimate + ESTIMATE_MARGIN_GB)` —
the margin/round-up lives in one place (preflight step 4), not in the wrapper. If the
estimate cannot be parsed, `estimateTotalGB` throws and preflight **skips the capacity gate**
for that override and proceeds to load — the labeled step-5 `load` failure is the backstop if
it genuinely cannot fit. (Feeding the gate `requiredTotalGB = os.totalmem()` would make it
`X < X` = false, a no-op, so the gate is explicitly skipped rather than given a meaningless
value.)

### `src/lms.ts` — `lms` CLI runner

Thin, single-purpose wrappers; each parses `--json` output where available. **Every JSON
parse is defensive** (see Error handling):

- `runLms(args, { timeoutMs? }): Promise<string>` — the one place that spawns the `lms`
  binary. Throws a labeled error if the binary is missing, exits non-zero, or exceeds the
  optional timeout. `runLms` is the seam mocked in tests.
- `serverStatus(): Promise<{ running: boolean; port: number }>` — `lms server status --json --quiet`
- `startServer(): Promise<void>` — `lms server start`, then re-poll `serverStatus` until
  running (bounded retries, **~30 s provisional** — a cold start with ROCm runtime init can
  exceed 15 s; tune against a measured cold start) or throw.
- `listLoaded(): Promise<LoadedModel[]>` — `lms ps --json` (array of `{ identifier, … }`)
- `unloadAll(): Promise<void>` — `lms unload --all`
- `estimateTotalGB(loadKey, contextLength): Promise<number>` —
  `lms load <key> --parallel 1 --context-length <n> --estimate-only`, parse and return the
  **raw** `Estimated Total Memory` in GiB (no margin/rounding — preflight applies those).
  Throws a labeled error if the line is absent/unparseable. (Used only for unknown overrides.)
- `load(loadKey, { contextLength, parallel, timeoutMs }): Promise<void>` —
  **`lms load <key> --parallel <p> --context-length <n> --yes`** (no `--gpu` flag → auto-fit),
  with a bounded `timeoutMs` (default ~10 min).

### `src/preflight.ts` — orchestrator

```
ensureModelReady(modelName, numCtx, logger, deps?) -> resolvedIdentifier
```

`deps` (optional) injects `{ lms, totalmem, freemem }` for testing; defaults to the real
`src/lms.ts` and `os.totalmem` / `os.freemem`. All GB math uses GiB (`/ 1024**3`), rounded
to one decimal for messages.

Algorithm:

1. **Server up?** `serverStatus()`. If not running, `startServer()`.
2. **Desired already loaded?** `listLoaded()`; if any loaded identifier matches the spec's
   `identifierMatch`, log "model already loaded" and **return that live identifier** — done
   (no unload, no resource check, no reload).
3. **Unload first.** `unloadAll()` — *before* the resource check so the check reflects a
   clean slate.
4. **Resource check.** (`os.totalmem()` is true capacity here — no carveout, see Host context.)
   - `requiredTotalGB` = registry value; or, for an unknown override,
     `Math.ceil(estimateTotalGB(loadKey, numCtx) + ESTIMATE_MARGIN_GB)`. If
     `estimateTotalGB` throws (unparseable), **skip the capacity gate** for that override and
     let the step-5 `load` failure be the backstop.
   - **Capacity gate:** if `os.totalmem()` GiB `< requiredTotalGB` → **throw**
     `InsufficientResourcesError`: `"Cannot load <modelName>: needs ~<X> GB total memory, machine has <Y> GB"`.
   - **Starvation floor:** else if `os.freemem()` GiB `< FREE_FLOOR_GB` (sampled here,
     post-unload/pre-load) → **throw** `InsufficientResourcesError`:
     `"Cannot load <modelName>: only <Y> GB free after unload — close other apps"`.
     This floor only catches a box already heavily consumed by other processes; it does **not**
     attempt to predict exact fit (auto-fit decides that, and a genuine over-allocation surfaces
     as a labeled `load` failure at step 5).
5. **Load.** `load(spec.loadKey, { contextLength: numCtx, parallel: 1 })` — auto-fit, no
   `--gpu`.
6. **Read back.** `listLoaded()` again; find the entry matching `identifierMatch`; return its
   `identifier`. If none matches, throw (load reported success but model not visible).

Return value is the **live identifier** the phases pass as the API `model` field.

A lightweight helper is also exported for per-phase revalidation (F3):

```
resolveLoadedIdentifier(modelName, logger, { readOnly }, deps?) -> resolvedIdentifier
```

It runs only steps 1–2 logic (server up + `listLoaded` match) and returns the live
identifier. On **no match**:
- `readOnly: true` (used under `--skip-preflight`) → **throw** a labeled error
  (`"model <name> is no longer loaded"`) — never unload/reload, honoring the opt-out's
  "don't touch lifecycle" contract.
- `readOnly: false` (normal path) → perform a full `ensureModelReady` to recover from a
  mid-run eviction/swap. This re-runs the resource gate; on this host the gate passes
  (`totalmem` = full capacity), so recovery does not spuriously abort.

### `src/index.ts` — wiring

- **Default model:** `const model = args['model-override'] ?? DEFAULT_MODEL` (was
  `'qwen/qwen3.5-9b'`).
- **New flag:** add `'skip-preflight'` to minimist's `boolean: [...]` array (currently
  `['resume']`), giving `boolean: ['resume', 'skip-preflight']`.
- **`numCtx` validation (F2-5):** after parsing, assert `numCtx` is a positive integer
  (`Number.isInteger(numCtx) && numCtx > 0`); otherwise exit with a clear error — preflight
  now passes `numCtx` into `lms` subprocess args, so a `NaN`/bad value must fail fast here,
  not inside a subprocess.
- **Phase-set gate (F2):** compute whether the resolved run includes a **model-using** phase
  (`index`, `analyze`, `dedup`, `refactor`; **not** `aggregate`, which uses the Claude CLI).
  Preflight only runs when at least one model-using phase will execute.
- **Preflight path:** unless `--skip-preflight`, call
  `let resolvedModel = await ensureModelReady(model, numCtx, logger)` before the phase block.
- **Skip-preflight path (F1):** when `--skip-preflight` is set, resolve the API model via
  `resolveLoadedIdentifier(model, logger, { readOnly: true })`. If nothing matching is loaded,
  it throws a clear error (don't send a bare logical name that fails on the first batch).
- **Per-phase revalidation (F3):** immediately before each model-using phase call,
  `resolvedModel = await resolveLoadedIdentifier(model, logger, { readOnly: skipPreflight })`
  so eviction/swap between phases is caught — read-only under `--skip-preflight` (throws if
  the model vanished), self-healing otherwise. Pass `resolvedModel` (never the logical name)
  into every `run*Phase(...)`.

## Data flow

```
index.ts
  ├─ phase set includes a model-using phase?  ──no──► run aggregate only, no preflight (F2)
  └─ yes:
       ├─ --skip-preflight? ──► resolveLoadedIdentifier (read-only) ──► identifier (F1)
       └─ else: ensureModelReady(logicalModel, numCtx, logger)
            ├─ lms.serverStatus / startServer
            ├─ lms.listLoaded ──(match?)──► return identifier (skip rest)
            ├─ lms.unloadAll
            ├─ os.totalmem < requiredTotalGB  OR  os.freemem < FREE_FLOOR_GB ──► throw
            ├─ lms.load(loadKey, { parallel:1, contextLength })   # no --gpu → auto-fit
            └─ lms.listLoaded ──► resolvedIdentifier
       └─ for each model-using phase:
            resolveLoadedIdentifier(...) ──► run<Phase>(…, resolvedIdentifier, …)   # F3
```

## Error handling

- Missing `lms` binary, server-won't-start, load timeout, or post-load model-not-visible:
  each throws a distinct labeled `Error`. `main()`'s existing top-level catch prints the
  message and exits non-zero.
- `InsufficientResourcesError` is a distinct error type with a required-vs-available message,
  asserted in tests.
- `startServer` uses bounded polling (~30 s provisional; cold ROCm init can exceed 15 s)
  before declaring failure.
- **`load` timeout (F8):** `runLms` applies a bounded timeout to `load` (default ~10 min,
  mirroring the existing HTTP timeout) so a hung load fails with a labeled error instead of
  blocking forever. The post-load `listLoaded` check guards against false success.
- **Malformed `lms` output.** Each wrapper that parses `--json` must not call `JSON.parse`
  bare. Wrap parsing and validate the expected shape (`serverStatus` → object with boolean
  `running`; `listLoaded` → array of objects with string `identifier`). On parse failure or
  shape mismatch — even when `lms` exits zero — throw a labeled `Error`
  (`"lms <cmd> returned unparseable output: <stdout snippet>"`). Protects against `lms`
  version drift, prepended warning lines, or empty stdout.

## Testing

Unit tests (`tests/`) with `runLms` mocked and `totalmem`/`freemem` injected — no real LM
Studio:

1. **Already-loaded short-circuit** — desired model present → no unload, no load, returns its
   identifier.
2. **Cold load path** — server up, wrong/no model loaded → unloadAll then load then returns
   read-back identifier; assert call order (unload before resource check before load) and
   that `load` is invoked **without** a `--gpu` argument and **with** `--parallel 1`.
3. **Insufficient total memory** — `totalmem` below `requiredTotalGB` → throws
   `InsufficientResourcesError`; assert **no `load` call** and unload happened first.
4. **Free-floor abort** — `totalmem` OK but `freemem` below `FREE_FLOOR_GB` → throws; no load.
5. **Server down → start** — `serverStatus` running:false → `startServer` called, then proceeds.
6. **Post-load not visible** — `load` succeeds but `listLoaded` shows no match → throws.
7. **Unknown override** — key not in registry → `estimateTotalGB` consulted; preflight
   applies `Math.ceil(estimate + ESTIMATE_MARGIN_GB)`; `identifierMatch` derived from the key;
   no crash. Estimate-unparseable (`estimateTotalGB` throws) → conservative fallback
   (`requiredTotalGB = os.totalmem()`).
8. **Malformed `lms` output** — `serverStatus`/`listLoaded` return non-JSON or wrong shape on
   a zero exit → labeled error, not a bare `SyntaxError`.
9. **Skip-preflight resolve (F1)** — `--skip-preflight` with a matching model loaded →
   returns its identifier via read-only `listLoaded`; with nothing loaded → throws.
10. **Per-phase revalidation (F3)** — `resolveLoadedIdentifier` returns the live identifier
    when still loaded; with `readOnly:false` triggers a recovery `ensureModelReady` when the
    match disappears; with `readOnly:true` (skip-preflight) **throws** instead of reloading.
11. **Model-free phase skip (F2)** — `--phase aggregate` → preflight not invoked.

Manual check: with LM Studio stopped, run `code-analyzer`; confirm it starts the server,
loads `qwen3.6-35b-a3b@q3_k_s` via auto-fit, and proceeds into Phase 1. Re-run with the model
already loaded → short-circuit (no reload). Run `--phase aggregate` → no preflight. Run
`--skip-preflight` with the model loaded → uses the live identifier.

## Idempotency & safety

- Re-running with the correct model already loaded is a no-op for LM Studio state
  (short-circuit at step 2).
- Unload is only performed when a load is actually required, never when the desired model is
  already present.
- No file writes; the only side effects are LM Studio server/model lifecycle calls.
- `--skip-preflight` preserves externally-managed setups but still resolves a real loaded
  identifier (never sends a bare logical name).
- Model-free phases (`aggregate`) never touch LM Studio.

## Affected files

| File | Change |
|---|---|
| `src/models.ts` | **new** — registry (`loadKey`, `identifierMatch`, `requiredTotalGB`), `DEFAULT_MODEL`, `FREE_FLOOR_GB` |
| `src/lms.ts` | **new** — `lms` CLI runner wrappers (auto-fit `load`, `estimateTotalGB`, defensive parsing, timeouts) |
| `src/preflight.ts` | **new** — `ensureModelReady` + `resolveLoadedIdentifier` + `InsufficientResourcesError` |
| `src/index.ts` | **modify** — default model, `--skip-preflight`, phase-set gate, preflight call, per-phase revalidation, pass resolved identifier |
| `tests/preflight.test.ts` | **new** — unit tests per scenarios above |
| `README.md` | **modify** — document preflight, `--skip-preflight`, new default model, the `--gpu max` caveat |
