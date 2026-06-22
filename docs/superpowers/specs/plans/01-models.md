# Plan 01 — `src/models.ts` (model registry + constants)

**Phase:** P1 of the LM Studio Preflight feature.
**Provides:** `models.ts:ModelSpec`, `models.ts:MODEL_REGISTRY`, `models.ts:DEFAULT_MODEL`, `models.ts:FREE_FLOOR_GB`, `models.ts:ESTIMATE_MARGIN_GB`
**Requires:** (none — leaf module)

This plan is self-contained. It creates one new pure-data TypeScript ESM module. No other
phase's work is needed to execute it.

---

## File: `src/models.ts`

### 1. File Overview
A pure-data registry that maps the analyzer's **logical** model name to the facts the
preflight needs: the `lms` load key, a regex that matches the identifier `lms ps` reports
when the model is loaded, and the minimum total unified memory (GiB) required to load it.
Also exports the default model name and two tuning constants used by the resource check and
the unknown-override estimate path. No runtime dependencies, no I/O — kept separate so it can
be imported by both `preflight.ts` and tests without pulling in `child_process`.

### 2. Change Summary
`create` — `src/models.ts`.

### 3. Detailed Code Modifications
Create the file with exactly this content:

```ts
export interface ModelSpec {
  loadKey: string;         // model key passed to `lms load` (NOT a .gguf path — see note below)
  identifierMatch: RegExp; // matches the identifier `lms ps` reports when the model is loaded
  requiredTotalGB: number; // min total unified memory (os.totalmem, GiB) to load at default ctx
}

/**
 * Keyed by the analyzer's *logical* model name (the value of --model-override or DEFAULT_MODEL).
 *
 * Why `loadKey` is a model key and NOT a .gguf path: loading by the full relative .gguf path
 * (e.g. `unsloth/Qwen3.6-35B-A3B-GGUF/...-Q3_K_S.gguf`) fails with `--yes` ("select a model
 * interactively") because multiple quants share the model folder. The disambiguated model key
 * (`qwen3.6-35b-a3b@q3_k_s`, as reported by `lms ls --json`'s `modelKey`) is the correct load
 * identifier and is also what the loaded model reports as its API identifier.
 *
 * requiredTotalGB is the total unified-memory footprint (weights + KV + runtime). On the target
 * host os.totalmem() === 31.15 GiB (the full box — memory is unified, no boot carveout), so 30
 * passes for the 35B and rejects sub-32 GB machines.
 */
export const MODEL_REGISTRY: Record<string, ModelSpec> = {
  'qwen3.6-35b-a3b': {
    loadKey: 'qwen3.6-35b-a3b@q3_k_s',
    identifierMatch: /qwen3\.6-35b-a3b@q3_k_s/i,
    requiredTotalGB: 30,
  },
  'qwen/qwen3.5-9b': {
    loadKey: 'qwen/qwen3.5-9b',
    identifierMatch: /qwen3\.5-9b/i,
    requiredTotalGB: 18,
  },
};

export const DEFAULT_MODEL = 'qwen3.6-35b-a3b';

/**
 * Coarse sanity floor for the resource check. Sampled post-unload/pre-load. Well below the
 * ~21.6 GiB idle freemem on the target host, so it never fires in normal use, but catches a box
 * already heavily consumed by other processes. Precise fit is delegated to llama.cpp auto-fit +
 * the labeled load-failure path, NOT to this floor. Provisional — tune against real usage.
 */
export const FREE_FLOOR_GB = 4.0;

/** Margin (GiB) added to a parsed `--estimate-only` total for unknown overrides (F4). */
export const ESTIMATE_MARGIN_GB = 1.0;
```

### 4. Implementation Notes
- ESM module (`package.json` has `"type": "module"`); no imports needed, so no `.js` extension
  concerns here. Consumers import via `./models.js`.
- `identifierMatch` regexes escape the literal `.` (`\.`); the `@` and `-` need no escaping.
  They are intentionally loose (match a substring of the `lms ps` `identifier`) and
  case-insensitive.
- Keep `MODEL_REGISTRY` a plain `Record` (not a `Map`) so it is trivially serializable and
  matches the spec's code block verbatim.
- Do not add behavior here (no functions that read memory or call `lms`) — this module must
  stay dependency-free and import-safe from tests.

### 5. Validation & Testing
- `npx tsc --noEmit` compiles with no errors (the interface and constant types are inferred).
- Quick import smoke check: `node -e "import('./dist/models.js').then(m=>console.log(m.DEFAULT_MODEL, m.MODEL_REGISTRY[m.DEFAULT_MODEL].loadKey))"` after `npm run build` prints
  `qwen3.6-35b-a3b qwen3.6-35b-a3b@q3_k_s`.
- No dedicated unit test file for this phase; the registry is exercised by `tests/preflight.test.ts` (Phase 3).

### 6. Idempotency & Safety Checks
- Pure data, no side effects — safe to import any number of times.
- Re-running the create step overwrites the file with identical content; nothing external is
  clobbered. If the file already exists with these exports, the implementer should diff rather
  than blindly overwrite, but there is no runtime state to protect.
