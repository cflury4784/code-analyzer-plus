# Plan 04 — `src/index.ts` wiring + `src/run-plan.ts` + tests + `README.md`

**Phase:** P4 of the LM Studio Preflight feature.
**Provides:** `index.ts:preflight-integration`, `run-plan.ts:runUsesModel`, `run-plan.ts:MODEL_USING_PHASES`
**Requires:** `preflight.ts:ensureModelReady`, `preflight.ts:resolveLoadedIdentifier` (Phase 3); `models.ts:DEFAULT_MODEL` (Phase 1)

Executes last. Wires preflight into the CLI entry point, adds the phase-set gate as a testable
pure helper, documents the feature, and adds the model-free-phase-skip test (test 11).

---

## File: `tsconfig.tests.json` + `package.json` (tests typecheck)

### 1. File Overview
The base `tsconfig.json` excludes `tests/`, so `npx tsc --noEmit` never type-checks test files
and `vitest run` (esbuild) does not type-check at all. Add a tests-inclusive config + script so
test type errors are catchable.

### 2. Change Summary
`create` — `tsconfig.tests.json`; `modify` — `package.json` (add a script).

### 3. Detailed Code Modifications
Create `tsconfig.tests.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": "."
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
```
Add to `package.json` `scripts`:
```diff
   "scripts": {
     "build": "tsc",
     "dev": "tsx src/index.ts",
     "test": "vitest",
-    "test:run": "vitest run"
+    "test:run": "vitest run",
+    "typecheck:tests": "tsc --noEmit -p tsconfig.tests.json"
   },
```

### 4. Implementation Notes
- `rootDir: "."` is required because the tests-inclusive `include` spans both `src` and `tests`;
  without it `tsc` errors that files are outside `rootDir`. This config is type-check only
  (`noEmit`), so it does not affect the real build (`npm run build` still uses `tsconfig.json`).

### 5. Validation & Testing
- `npm run typecheck:tests` → clean (after Phases 1–4 land). This is the command that actually
  validates the test files' types.

### 6. Idempotency & Safety Checks
- New config file + additive script; does not change the production build.

---

## File: `src/run-plan.ts`

### 1. File Overview
A tiny pure helper extracting the "does this run use the model?" decision so it can be unit
tested without importing `index.ts` (which auto-executes `main()`).

### 2. Change Summary
`create` — `src/run-plan.ts`.

### 3. Detailed Code Modifications
```ts
/** Phases that call the local model via LM Studio. `aggregate` uses the Claude CLI, not LM Studio. */
export const MODEL_USING_PHASES = ['index', 'analyze', 'dedup', 'refactor'] as const;

/**
 * Whether a run uses the local model. `phase === undefined` means "run all phases" (which
 * includes model-using ones). A single named phase uses the model only if it is in the set.
 */
export function runUsesModel(phase?: string): boolean {
  if (!phase) return true;
  return (MODEL_USING_PHASES as readonly string[]).includes(phase);
}
```

### 4. Implementation Notes
- Pure, dependency-free. Keeps the gate logic out of `index.ts`'s side-effecting module body.

### 5. Validation & Testing
- Covered by `tests/run-plan.test.ts` (below).

### 6. Idempotency & Safety Checks
- Pure function, no side effects.

---

## File: `src/index.ts`

### 1. File Overview
The CLI entry point. Add the new default model, the `--skip-preflight` flag, `numCtx`
validation, and the preflight + per-phase-revalidation wiring; pass the **resolved identifier**
(never the logical name) into model-using phases.

### 2. Change Summary
`modify` — `src/index.ts`.

### 3. Detailed Code Modifications

**(a) Imports** — add after the existing phase imports (near line 11):
```diff
 import { runRefactorPhase } from './phases/refactor.js';
+import { DEFAULT_MODEL } from './models.js';
+import { ensureModelReady, resolveLoadedIdentifier } from './preflight.js';
+import { runUsesModel } from './run-plan.js';
 import { join } from 'path';
```

**(b) Arg parsing** — register the new boolean flag:
```diff
 const args = minimist(process.argv.slice(2), {
   string: ['phase', 'model-override'],
-  boolean: ['resume'],
+  boolean: ['resume', 'skip-preflight'],
 });
```

**(c) Default model** — replace the hardcoded default:
```diff
-const model: string = (args['model-override'] as string | undefined) ?? 'qwen/qwen3.5-9b';
+const model: string = (args['model-override'] as string | undefined) ?? DEFAULT_MODEL;
```

**(d) Read the flag + validate numCtx** — after the existing `numCtx` line (line 25):
```diff
 const numCtx: number = args['num-ctx'] !== undefined ? Number(args['num-ctx']) : 64000;
+const skipPreflight: boolean = (args['skip-preflight'] as boolean | undefined) ?? false;
+
+if (!Number.isInteger(numCtx) || numCtx <= 0) {
+  console.error(`Invalid --num-ctx: must be a positive integer (got ${args['num-ctx']})`);
+  process.exit(1);
+}
```

**(e) Preflight before the phase block** — insert at the top of `main()`, immediately after
the manifest/discovery setup and before the `if (!phase || phase === 'index')` block:
```diff
   } else if (phase && !resume) {
     resetPhase(projectRoot, phase as 'index' | 'analyze' | 'dedup' | 'aggregate' | 'refactor');
     logger.info(`Phase ${phase} reset`);
   }

+  // LM Studio preflight — only when the run actually uses the model (skips aggregate-only runs).
+  if (runUsesModel(phase) && !skipPreflight) {
+    await ensureModelReady(model, numCtx, logger);
+  }
+
   if (!phase || phase === 'index') {
```

**(f) Per-phase revalidation + resolved identifier** — for EACH model-using phase block
(`index`, `analyze`, `dedup`, `refactor`), resolve the live identifier immediately before the
`run*Phase` call and pass it instead of `model`. Pattern for the `index` block:
```diff
   if (!phase || phase === 'index') {
     const m = readManifest(projectRoot);
     if (m.phases.index !== 'completed') {
-      await runIndexPhase(projectRoot, model, logger, undefined, timeoutMs, numCtx);
+      const resolvedModel = await resolveLoadedIdentifier(model, numCtx, logger, { readOnly: skipPreflight });
+      await runIndexPhase(projectRoot, resolvedModel, logger, undefined, timeoutMs, numCtx);
     }
     if (readManifest(projectRoot).phases.index === 'failed') {
```
Apply the identical 2-line change (resolve, then pass `resolvedModel`) to the `analyze`,
`dedup`, and `refactor` phase blocks. **Do NOT change the `aggregate` block** — it calls
`runAggregatePhase(projectRoot, logger)` with no model and must not touch LM Studio.

### 4. Implementation Notes
- `main()` is already `async`; the new `await`s are fine.
- The preflight call at (e) primes LM Studio once; the per-phase `resolveLoadedIdentifier`
  calls (f) then return quickly (model already loaded) and self-heal on mid-run eviction
  (`readOnly: false` when not skipping). Under `--skip-preflight`, (e) is skipped and (f) runs
  read-only (throws if the model vanished — never reloads).
- The first phase's revalidation right after (e) is intentionally allowed (a cheap `lms ps`);
  it keeps the "resolve before every phase" invariant uniform.
- Errors (`InsufficientResourcesError`, labeled `lms` failures) propagate to the existing
  top-level `main().catch` (line ~97), which prints the message and exits non-zero.

### 5. Validation & Testing
- `npx tsc --noEmit` clean.
- `tests/run-plan.test.ts` (below) covers test 11 (model-free phase skip logic).
- Manual: per the spec's Manual check — stopped LM Studio → run prints "server not running —
  starting", loads `qwen3.6-35b-a3b@q3_k_s` via auto-fit, proceeds to Phase 1; re-run →
  "model already loaded" short-circuit; `--phase aggregate` → no preflight log lines;
  `--skip-preflight` with model loaded → uses the live identifier.

### 6. Idempotency & Safety Checks
- The phase-set gate ensures aggregate-only runs never touch LM Studio.
- Re-running a completed pipeline still short-circuits inside preflight (already-loaded) and
  inside each phase (`!== 'completed'` guards remain unchanged).
- Only wiring changes; no change to phase internals or manifest semantics.

---

## File: `tests/run-plan.test.ts`

### 3. Detailed Code Modifications
```ts
import { describe, it, expect } from 'vitest';
import { runUsesModel } from '../src/run-plan.js';

describe('runUsesModel (F2 phase-set gate)', () => {
  it('11a. returns true for a full run (no phase given)', () => {
    expect(runUsesModel(undefined)).toBe(true);
  });
  it('11b. returns true for model-using phases', () => {
    for (const p of ['index', 'analyze', 'dedup', 'refactor']) expect(runUsesModel(p)).toBe(true);
  });
  it('11c. returns false for the model-free aggregate phase', () => {
    expect(runUsesModel('aggregate')).toBe(false);
  });
});
```

### 5. Validation & Testing
- `npm run test:run` → green. Combined with Phase 3 tests, this asserts preflight is *gated*
  (helper) and *behaves* (orchestration).

---

## File: `README.md`

### 2. Change Summary
`modify` — document the preflight, the `--skip-preflight` flag, the new default model, and the
`--gpu max` caveat.

### 3. Detailed Code Modifications
Add a new section (place after the existing usage/flags section; adapt heading depth to the
file). If a flags table/list exists, add the `--skip-preflight` row there too.

```markdown
## LM Studio preflight

Before any model-using phase (`index`, `analyze`, `dedup`, `refactor`), `code-analyzer`
automatically ensures LM Studio is ready:

1. Starts the `lms` server if it is not running.
2. If the intended model is already loaded, uses it as-is (no churn).
3. Otherwise unloads any loaded model, checks the machine has enough memory, then loads the
   model with **auto-fit** (`--parallel 1`, no `--gpu max`).

If the machine lacks the memory to load the model, the run aborts with a clear
required-vs-available message rather than failing mid-pipeline.

**Default model:** `qwen3.6-35b-a3b` (Qwen3.6-35B-A3B Q3_K_S, load key
`qwen3.6-35b-a3b@q3_k_s`). Override with `--model-override <key>`.

**`--skip-preflight`** — do not manage the LM Studio lifecycle. The tool still resolves the
live identifier of the already-loaded model (and errors if nothing matching is loaded), but
never starts the server, unloads, or loads. The identifier is resolved — and the error, if
any, raised — immediately before the first model-using phase runs, not at startup. Use this
when LM Studio is managed externally.

> **Strix Halo / unified-memory APU note:** do **not** load with `--gpu max`. It pins all
> layers to the ~12 GB ROCm VRAM heap and disables llama.cpp auto-fit, OOM-crashing larger
> models. Preflight deliberately omits `--gpu` so auto-fit spills into the unified pool.

The `aggregate` phase uses the Claude CLI, not LM Studio, so preflight is skipped for
`--phase aggregate`.
```

### 4. Implementation Notes
- Match the README's existing heading style and flag-documentation format; the block above is
  content, not a verbatim layout mandate.

### 5. Validation & Testing
- Doc-only; no automated test. Verify the rendered Markdown reads correctly and the
  `--skip-preflight` flag appears wherever other flags are listed.

### 6. Idempotency & Safety Checks
- Documentation change only; no runtime impact.
