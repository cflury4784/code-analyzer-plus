# LM Studio Preflight — Design

**Date:** 2026-06-17
**Status:** Approved (brainstorming), pending plan generation
**Component:** `code-analyzer` CLI

## Problem

`code-analyzer` calls LM Studio over HTTP (`src/lm-studio.ts`) but never verifies that
the server is running or that the intended model is loaded. When the server is down or no
model is loaded, the run fails on the first batch with a connection error
(`LM Studio connection failed … is LM Studio running on http://localhost:1234/...`) after
discovery has already completed. The user must manually start the server and load a model,
then re-run.

This design adds an automatic **preflight** that validates LM Studio state and brings it
to a ready state before any phase runs, and switches the default model to one better
suited to the host hardware.

## Host context (drives several decisions)

- **Machine:** AMD Ryzen AI Max "Strix Halo" class APU. Integrated **Radeon 8060S** GPU,
  **32 GB unified memory** (VRAM and system RAM share one pool). LM Studio uses the
  **ROCm** llama.cpp runtime.
- **Consequences:**
  - `nvidia-smi` does not exist; WMI reports a bogus `0.5 GB` adapter RAM for the iGPU.
    Resource validation therefore reasons about the **shared system-memory pool**, read via
    Node's `os.freemem()` / `os.totalmem()`, **not** a discrete VRAM figure.
  - Models load into the unified pool, so free system RAM is the binding constraint.

## Goals

1. Before phases run, ensure: LM Studio server is up **and** the intended model is loaded.
2. If the intended model is not already loaded, **unload any currently-loaded model first**,
   **then** validate that the machine has enough free memory to load the intended model.
3. If resources are insufficient, **abort with a clear required-vs-available message** —
   no silent downgrade, no blind load attempt.
4. Start the server and load the model when needed.
5. Switch the default model from `qwen/qwen3.5-9b` to **Qwen3.6-35B-A3B (Q3_K_S)**.

## Non-goals

- No live GGUF-size stat + KV-cache computation; `requiredFreeGB` is a static per-model
  estimate (refine later if needed).
- No automatic model download (assumes the model is present locally).
- No fallback/auto-downgrade to a smaller model on low resources (explicitly rejected).
- No change to the HTTP call path beyond which `model` identifier is passed.

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Default model | **Qwen3.6-35B-A3B Q3_K_S** (MoE, 3B active/token — best quality/throughput on this APU) |
| Preflight trigger | **Always runs**, with a `--skip-preflight` opt-out flag |
| Insufficient resources | **Abort** with required-vs-available message |
| Correct model already loaded | **Skip** unload/reload entirely (no churn) |
| Resource basis | Static per-model `requiredFreeGB` vs `os.freemem()` |
| API `model` value | The **live identifier read back from `lms ps`** after load, not the logical name |

## Architecture

Three new modules plus wiring in the existing entry point. All `lms`/OS interaction is
funneled through injectable seams so unit tests never touch real hardware.

### `src/models.ts` — model registry

A table keyed by the analyzer's **logical** model name:

```ts
export interface ModelSpec {
  loadPath: string;        // identifier/path passed to `lms load`
  identifierMatch: RegExp; // matches the identifier `lms ps` reports when loaded
  requiredFreeGB: number;  // min free unified memory to load at the default ctx
}

export const MODEL_REGISTRY: Record<string, ModelSpec> = {
  'qwen3.6-35b-a3b': {
    loadPath: 'unsloth/Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q3_K_S.gguf',
    identifierMatch: /35B-A3B.*Q3_K_S/i,
    requiredFreeGB: 20, // ~16 GB weights + KV/headroom at 64k ctx
  },
  'qwen/qwen3.5-9b': {
    loadPath: 'qwen/qwen3.5-9b',
    identifierMatch: /qwen3\.5-9b/i,
    requiredFreeGB: 11, // ~8.3 GB weights + headroom
  },
};

export const DEFAULT_MODEL = 'qwen3.6-35b-a3b';
```

If a user passes `--model-override` with a value **not** in the registry, preflight treats
it as a raw load path/identifier with a conservative default `requiredFreeGB` and an
`identifierMatch` derived from the string (see Implementation Notes in the plan).

### `src/lms.ts` — `lms` CLI runner

Thin, single-purpose wrappers; each parses `--json` output where available:

- `runLms(args: string[]): Promise<string>` — the one place that spawns the `lms` binary.
  Throws a labeled error if the binary is missing or exits non-zero.
- `serverStatus(): Promise<{ running: boolean; port: number }>` — `lms server status --json --quiet`
- `startServer(): Promise<void>` — `lms server start`, then re-poll `serverStatus` until running
  (bounded retries) or throw.
- `listLoaded(): Promise<LoadedModel[]>` — `lms ps --json`
- `unloadAll(): Promise<void>` — `lms unload --all`
- `load(loadPath, { gpu, contextLength, yes }): Promise<void>` — `lms load <path> --gpu max --yes --context-length <n>`

`runLms` is the seam mocked in tests.

### `src/preflight.ts` — orchestrator

```
ensureModelReady(modelName, numCtx, logger, deps?) -> resolvedIdentifier
```

`deps` (optional) injects `{ lms, freemem }` for testing; defaults to the real `src/lms.ts`
and `os.freemem`.

Algorithm:

1. **Server up?** `serverStatus()`. If not running, `startServer()`.
2. **Desired already loaded?** `listLoaded()`; if any loaded model's identifier matches the
   spec's `identifierMatch`, log "model already loaded", **return that live identifier** —
   done.
3. **Unload first.** `unloadAll()` — performed *before* the resource check so the check
   reflects a clean slate.
4. **Resource check.** Read `freemem()` (bytes → GB). If `< requiredFreeGB`, **throw**
   `InsufficientResourcesError`: `"Cannot load <modelName>: requires ~<X> GB free, only <Y> GB available"`.
5. **Load.** `load(spec.loadPath, { gpu:'max', contextLength:numCtx, yes:true })`.
6. **Read back.** `listLoaded()` again; find the entry matching `identifierMatch`; return its
   `identifier`. If none matches, throw (load reported success but model not visible).

Return value is the **live identifier** the phases must pass as the API `model` field.

### `src/index.ts` — wiring

- Change default: `const model = args['model-override'] ?? DEFAULT_MODEL` (was `'qwen/qwen3.5-9b'`).
- Add `--skip-preflight` to the boolean args.
- After manifest setup and before the phase block: unless `--skip-preflight`, call
  `const resolvedModel = await ensureModelReady(model, numCtx, logger)`. Pass
  `resolvedModel` (not `model`) into every `run*Phase(...)` call.
- When `--skip-preflight` is set, pass `model` through unchanged (current behavior).

## Data flow

```
index.ts
  └─ ensureModelReady(logicalModel, numCtx, logger)
       ├─ lms.serverStatus / startServer
       ├─ lms.listLoaded ──(match?)──► return identifier (skip rest)
       ├─ lms.unloadAll
       ├─ os.freemem vs MODEL_REGISTRY[logical].requiredFreeGB ──(short)──► throw
       ├─ lms.load(spec.loadPath, …)
       └─ lms.listLoaded ──► resolvedIdentifier
  └─ run{Index,Analyze,Dedup,Aggregate,Refactor}Phase(…, resolvedIdentifier, …)
```

## Error handling

- Missing `lms` binary, server-won't-start, load timeout, or post-load model-not-visible:
  each throws a distinct labeled `Error`. `main()`'s existing top-level catch prints the
  message and exits non-zero.
- `InsufficientResourcesError` is a distinct error type with a required-vs-available message,
  so it reads clearly and can be asserted in tests.
- `startServer` uses bounded polling (e.g. up to ~15 s) before declaring failure.
- `load` relies on `lms load` blocking until loaded (as observed); the post-load
  `listLoaded` check guards against false success.

## Testing

Unit tests (`tests/`) with `runLms` mocked and `freemem` injected — no real LM Studio:

1. **Already-loaded short-circuit** — desired model present → no unload, no load, returns its
   identifier.
2. **Cold load path** — server up, wrong/no model loaded → unloadAll then load then returns
   read-back identifier; assert call order (unload before resource check before load).
3. **Insufficient resources** — `freemem` below `requiredFreeGB` → throws
   `InsufficientResourcesError`; assert **no `load` call** was made and unload happened first.
4. **Server down → start** — `serverStatus` running:false → `startServer` called, then proceeds.
5. **Post-load not visible** — `load` succeeds but `listLoaded` shows no match → throws.
6. **Unknown override model** — `--model-override` not in registry → uses conservative
   defaults without crashing.

Manual check: with LM Studio stopped, run `code-analyzer`; confirm it starts the server,
loads the 35B-A3B model, and proceeds into Phase 1. Run again with the model already loaded;
confirm the short-circuit (no reload). Run with `--skip-preflight`; confirm current behavior.

## Idempotency & safety

- Re-running with the correct model already loaded is a no-op for LM Studio state
  (short-circuit at step 2).
- Unload is only performed when a load is actually required, never when the desired model is
  already present.
- No file writes; the only side effects are LM Studio server/model lifecycle calls.
- `--skip-preflight` fully preserves today's behavior for externally-managed setups.

## Affected files

| File | Change |
|---|---|
| `src/models.ts` | **new** — registry + `DEFAULT_MODEL` |
| `src/lms.ts` | **new** — `lms` CLI runner wrappers |
| `src/preflight.ts` | **new** — `ensureModelReady` orchestrator + `InsufficientResourcesError` |
| `src/index.ts` | **modify** — default model, `--skip-preflight`, call preflight, pass resolved identifier |
| `tests/preflight.test.ts` | **new** — unit tests per scenarios above |
| `README.md` | **modify** — document preflight, `--skip-preflight`, new default model |
