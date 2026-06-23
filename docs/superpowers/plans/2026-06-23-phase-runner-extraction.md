# PhaseRunner Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the duplicated per-batch retry/status/logging loop shared by `index.ts`, `analyze.ts`, and `dedup.ts` (Pass A) into a single `runPhaseBatches` helper, and close the missing `runAnalyzePhase` test gap.

**Architecture:** Add one new module `src/phases/phase-runner.ts` exporting a generic `runPhaseBatches<T>()` that owns the batch-iteration bookkeeping (skip-completed, retry invocation, `updateBatchStatus`, done/failed counting, standard log lines). Each phase keeps its own pre/post logic (phase headers, `updatePhaseStatus`, dedup's Pass B, the missing-files skip) and supplies a `work` callback plus optional `trySkip`/`successMeta` hooks. Public phase-function signatures are unchanged, so the orchestrator and existing tests are untouched.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, MSW for LM HTTP mocking.

---

## Scope

**In scope** — the per-batch loop appears in exactly these three places, with identical bookkeeping:
- `src/phases/index.ts` — `runIndexPhase` batch loop (has a missing-files pre-skip + one-time token warn → uses `trySkip`).
- `src/phases/analyze.ts` — `runAnalyzePhase` batch loop (uses group items by index).
- `src/phases/dedup.ts` — `runDedupPhase` **Pass A** loop only.

**Explicitly OUT of scope** (do not touch their control flow):
- `src/phases/aggregate.ts` — single `runWithRetry`, no batch loop. Nothing to extract.
- `src/phases/dedup.ts` **Pass B** — hierarchical pairwise tree-merge, a different shape. Leave inline.
- `src/batcher.ts` — `createBatches` packs *files* into batches; unrelated to the loop. The original finding named it incorrectly; it is not in scope.

**Risk:** LOW. GitNexus `impact(upstream)` on both functions returns LOW/exact: `runIndexPhase` → 1 caller (`phase1.test.ts`), `runAnalyzePhase` → 1 caller (`PhaseOrchestrator.runPipeline`). The extraction preserves both signatures, so neither caller changes.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/phases/phase-runner.ts` | Generic per-batch loop: skip-completed, retry, status writes, counting, standard logs. | **Create** |
| `tests/unit/phase-runner.test.ts` | Unit tests for `runPhaseBatches` (success / failure / skip-completed / trySkip). | **Create** |
| `src/phases/index.ts` | `runIndexPhase` delegates its loop to `runPhaseBatches` via `trySkip` + `successMeta`. | **Modify** |
| `src/phases/analyze.ts` | `runAnalyzePhase` delegates its loop to `runPhaseBatches`. | **Modify** |
| `src/phases/dedup.ts` | `runDedupPhase` Pass A delegates to `runPhaseBatches`; Pass B unchanged. | **Modify** |
| `tests/integration/phase2.test.ts` | New integration coverage for `runAnalyzePhase` (current gap). | **Create** |

### Behavioral invariants the helper MUST preserve (verified against current source)

1. `total = batches.length`; `pending = batches.filter(b => b.status !== 'completed').length`; `doneCount` starts at `total - pending`.
2. Already-`completed` batches are skipped (no LM call, no status write).
3. Per-attempt error log is exactly: `` `${batch.id} failed (attempt ${attempt}/${orchestrator.maxAttempts})` `` with meta `{ error: msg }`, where `msg = err instanceof Error ? err.message : String(err)`.
4. On success: `doneCount++`, then `updateBatchStatus(projectRoot, phase, batch.id, 'completed', result.attempts)`, then info log `` `${batch.id} done (${doneCount}/${total})` `` (index adds meta `{ files: batch.files.length }`).
5. On failure: `updateBatchStatus(projectRoot, phase, batch.id, 'failed', orchestrator.maxAttempts)`, `failedCount++`. No throw — the loop continues.
6. `updateBatchStatus` reads+writes the manifest on disk per call (the helper iterates the in-memory `batches` snapshot — identical to current code).
7. The helper does NOT call `updatePhaseStatus` and does NOT compute `finalStatus` — each phase keeps that.

---

## Task 1: Create `runPhaseBatches` helper (TDD)

**Files:**
- Create: `src/phases/phase-runner.ts`
- Test: `tests/unit/phase-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/phase-runner.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import { createManifest, writeManifest, readManifest } from '../../src/manifest.js';
import { createLogger } from '../../src/logger.js';
import { runPhaseBatches } from '../../src/phases/phase-runner.js';
import { setupTempFs, type TempFsResult } from '../utils/TestEnvironmentManager.js';
import type { BatchEntry } from '../../src/types.js';
import type { PhaseOrchestrator } from '../../src/phase-orchestrator-types.js';

let tempFs: TempFsResult | undefined;
let testRoot: string;

function makeBatch(id: string, status: BatchEntry['status']): BatchEntry {
  return {
    id,
    files: [`src/${id}.ts`],
    size_bytes: 10,
    status,
    attempts: 0,
    completed_at: null,
    output_file: `code-analysis/analyze/${id}.json`,
  };
}

function seed(batches: BatchEntry[]) {
  tempFs = setupTempFs('phase-runner-test');
  testRoot = tempFs.root;
  const manifest = createManifest(testRoot, []);
  manifest.batches.analyze = batches;
  writeManifest(testRoot, manifest);
}

const okOrchestrator: PhaseOrchestrator = {
  maxAttempts: 3,
  runWithRetry: async (fn) => ({ value: await fn(), attempts: 1 }),
  readPhaseStatus: () => 'pending',
  writePhaseStatus: () => {},
};

const failOrchestrator: PhaseOrchestrator = {
  maxAttempts: 3,
  runWithRetry: async (_fn, onAttemptError) => {
    onAttemptError(3, new Error('boom'));
    return null;
  },
  readPhaseStatus: () => 'pending',
  writePhaseStatus: () => {},
};

afterEach(() => {
  if (tempFs) tempFs.cleanup();
});

describe('runPhaseBatches', () => {
  it('runs work for each pending batch and marks them completed', async () => {
    seed([makeBatch('a', 'pending'), makeBatch('b', 'pending')]);
    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
    const seen: string[] = [];

    const result = await runPhaseBatches({
      orchestrator: okOrchestrator,
      projectRoot: testRoot,
      phase: 'analyze',
      batches: readManifest(testRoot).batches.analyze,
      logger,
      work: async (batch) => { seen.push(batch.id); return 1; },
    });

    expect(seen).toEqual(['a', 'b']);
    expect(result).toEqual({ total: 2, doneCount: 2, failedCount: 0 });
    const m = readManifest(testRoot);
    expect(m.batches.analyze.every(b => b.status === 'completed')).toBe(true);
    expect(m.batches.analyze[0].attempts).toBe(1);
  });

  it('skips already-completed batches', async () => {
    seed([makeBatch('a', 'completed'), makeBatch('b', 'pending')]);
    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
    const seen: string[] = [];

    const result = await runPhaseBatches({
      orchestrator: okOrchestrator,
      projectRoot: testRoot,
      phase: 'analyze',
      batches: readManifest(testRoot).batches.analyze,
      logger,
      work: async (batch) => { seen.push(batch.id); return 1; },
    });

    expect(seen).toEqual(['b']);
    expect(result).toEqual({ total: 2, doneCount: 2, failedCount: 0 });
  });

  it('marks failed batches and counts them without throwing', async () => {
    seed([makeBatch('a', 'pending')]);
    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));

    const result = await runPhaseBatches({
      orchestrator: failOrchestrator,
      projectRoot: testRoot,
      phase: 'analyze',
      batches: readManifest(testRoot).batches.analyze,
      logger,
      work: async () => 1,
    });

    expect(result).toEqual({ total: 1, doneCount: 0, failedCount: 1 });
    const m = readManifest(testRoot);
    expect(m.batches.analyze[0].status).toBe('failed');
    expect(m.batches.analyze[0].attempts).toBe(3);
  });

  it('honors trySkip: marks completed with 0 attempts and never calls work', async () => {
    seed([makeBatch('a', 'pending')]);
    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
    let workCalls = 0;

    const result = await runPhaseBatches({
      orchestrator: okOrchestrator,
      projectRoot: testRoot,
      phase: 'analyze',
      batches: readManifest(testRoot).batches.analyze,
      logger,
      trySkip: () => ({ logSuffix: ' — skipped' }),
      work: async () => { workCalls++; return 1; },
    });

    expect(workCalls).toBe(0);
    expect(result).toEqual({ total: 1, doneCount: 1, failedCount: 0 });
    const m = readManifest(testRoot);
    expect(m.batches.analyze[0].status).toBe('completed');
    expect(m.batches.analyze[0].attempts).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/phase-runner.test.ts`
Expected: FAIL — `Cannot find module '../../src/phases/phase-runner.js'` (or "runPhaseBatches is not a function").

- [ ] **Step 3: Write the helper**

Create `src/phases/phase-runner.ts`:

```ts
import { updateBatchStatus } from '../manifest.js';
import type { BatchEntry, BatchPhase } from '../types.js';
import type { Logger } from '../logger.js';
import type { PhaseOrchestrator } from '../phase-orchestrator-types.js';

export interface PhaseBatchLoopResult {
  total: number;
  doneCount: number;
  failedCount: number;
}

export interface PhaseBatchLoopOptions<T> {
  orchestrator: PhaseOrchestrator;
  projectRoot: string;
  phase: BatchPhase;
  /** In-memory snapshot of the batch list to iterate (status writes go to disk). */
  batches: BatchEntry[];
  logger: Logger;
  /** Per-batch work: build prompt, call the model, parse, write output, return the parsed result. */
  work: (batch: BatchEntry, index: number) => Promise<T>;
  /**
   * Optional pre-check run before `work`. May be async and may stash prepared
   * state via closure. Return a non-null object to mark the batch completed with
   * 0 attempts (no model call); `logSuffix` is appended to the standard done line.
   * Return null to proceed to `work`.
   */
  trySkip?: (batch: BatchEntry) => Promise<{ logSuffix: string } | null> | { logSuffix: string } | null;
  /** Optional extra meta for the success log line (e.g. index adds `{ files }`). */
  successMeta?: (batch: BatchEntry) => Record<string, unknown> | undefined;
}

/**
 * Shared per-batch execution loop for index/analyze/dedup-PassA phases.
 * Owns: skip-completed, retry invocation, manifest status writes, done/failed
 * counting, and the standard info/error log lines. Does NOT touch phase status —
 * callers keep their own `updatePhaseStatus`/`finalStatus` logic.
 */
export async function runPhaseBatches<T>(opts: PhaseBatchLoopOptions<T>): Promise<PhaseBatchLoopResult> {
  const { orchestrator, projectRoot, phase, batches, logger, work, trySkip, successMeta } = opts;

  const total = batches.length;
  const pending = batches.filter(b => b.status !== 'completed').length;
  let failedCount = 0;
  let doneCount = total - pending;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    if (batch.status === 'completed') continue;

    if (trySkip) {
      const skip = await trySkip(batch);
      if (skip) {
        doneCount++;
        updateBatchStatus(projectRoot, phase, batch.id, 'completed', 0);
        logger.info(`${batch.id} done (${doneCount}/${total})${skip.logSuffix}`);
        continue;
      }
    }

    const result = await orchestrator.runWithRetry(
      () => work(batch, i),
      (attempt, err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`${batch.id} failed (attempt ${attempt}/${orchestrator.maxAttempts})`, { error: msg });
      },
    );

    if (result) {
      doneCount++;
      updateBatchStatus(projectRoot, phase, batch.id, 'completed', result.attempts);
      const meta = successMeta ? successMeta(batch) : undefined;
      if (meta) logger.info(`${batch.id} done (${doneCount}/${total})`, meta);
      else logger.info(`${batch.id} done (${doneCount}/${total})`);
    } else {
      updateBatchStatus(projectRoot, phase, batch.id, 'failed', orchestrator.maxAttempts);
      failedCount++;
    }
  }

  return { total, doneCount, failedCount };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/phase-runner.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.
> NOTE: `tsconfig.json` excludes `tests/**`, so `tsc` does NOT typecheck this test file. Its type-correctness is only validated implicitly by vitest at runtime (esbuild strips types without checking). `tsc` remains a valid gate for the `src/**` edits in Tasks 2–4.

- [ ] **Step 6: Commit**

```bash
git add src/phases/phase-runner.ts tests/unit/phase-runner.test.ts
git commit -m "feat: add runPhaseBatches shared phase loop helper"
```

---

## Task 2: Refactor `runAnalyzePhase` to use the helper

Start with analyze — it is the cleanest case (no `trySkip`, no `successMeta`).

**Files:**
- Modify: `src/phases/analyze.ts:107-173` (the `runAnalyzePhase` body)
- Test: `tests/unit/phase-runner.test.ts` (already green), plus full suite

- [ ] **Step 1: Add the import**

At the top of `src/phases/analyze.ts`, add after the existing imports (e.g. after the `PhaseOrchestrator` type import on line 11):

```ts
import { runPhaseBatches } from './phase-runner.js';
```

- [ ] **Step 2: Replace the batch loop**

In `runAnalyzePhase`, replace the loop block (current lines 135–172, from `let failedCount = 0;` through the final `logger.info(\`Phase 2 ${finalStatus}\`, ...)`) with:

```ts
  const { failedCount } = await runPhaseBatches<AnalysisOutput>({
    orchestrator,
    projectRoot,
    phase: 'analyze',
    batches: manifest.batches.analyze,
    logger,
    work: async (batch, i) => {
      const groupItems = groups[i] ?? [];
      const prompt = analyzePrompt(groupItems);
      const maxTokens = calculateSafeMaxTokens(prompt.length, numCtx ?? DEFAULT_NUM_CTX, 3000);
      const raw = await callLMStudio(model, prompt, lmUrl, timeoutMs, numCtx, signal, maxTokens);
      const parsed = extractJson(raw) as AnalysisOutput;
      fs.mkdirSync(fs.join(projectRoot, 'code-analysis', 'analyzer'));
      fs.writeFileSync(fs.join(projectRoot, batch.output_file), JSON.stringify(parsed, null, 2));
      return parsed;
    },
  });

  const finalStatus = failedCount > 0 ? 'failed' : 'completed';
  updatePhaseStatus(projectRoot, 'analyze', finalStatus);
  logger.info(`Phase 2 ${finalStatus}`, { groups: total, failed: failedCount });
}
```

Leave lines 119–134 (manifest read, `noAnalyzeProgress`, `groupIndexOutputs`, the `logger.info('Phase 2 — Analysis', ...)` header, and `total`) unchanged. Delete the now-unused `doneCount` line (old line 136) — the helper owns counting.

> NOTE: `total` is still referenced in the final log line, so keep its declaration (old line 132). `pending` (old line 133) is only used in the phase header — keep it.

- [ ] **Step 3: Run the unit + integration suite**

Run: `npx vitest run tests/unit/phase-runner.test.ts tests/integration/phase1.test.ts`
Expected: PASS (phase1 still green — analyze refactor must not regress index).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.
> NOTE: tsconfig does NOT set `noUnusedLocals`, so `tsc` will NOT flag a leftover `doneCount`. Instead grep the `runAnalyzePhase` body — `doneCount` must appear 0× (the helper owns counting). Delete the old `let doneCount = …` line.

- [ ] **Step 5: Commit**

```bash
git add src/phases/analyze.ts
git commit -m "refactor: runAnalyzePhase uses runPhaseBatches"
```

---

## Task 3: Refactor `runDedupPhase` Pass A to use the helper

Only Pass A. Pass B (the `while (pool.length > 1)` tree-merge) stays exactly as-is.

**Files:**
- Modify: `src/phases/dedup.ts:88-127` (Pass A loop only)
- Test: full suite

- [ ] **Step 1: Add the import**

At the top of `src/phases/dedup.ts`, add after the `PhaseOrchestrator` type import (line 9):

```ts
import { runPhaseBatches } from './phase-runner.js';
```

- [ ] **Step 2: Replace the Pass A loop**

In `runDedupPhase`, replace the Pass A loop block (current lines 88–127, from `let passAFailed = 0;` through the `if (passAFailed > 0) { ... return; }` block) with:

```ts
  const { failedCount: passAFailed } = await runPhaseBatches<DedupOutput>({
    orchestrator,
    projectRoot,
    phase: 'dedup',
    batches: m.batches.dedup,
    logger,
    work: async (batch, i) => {
      const groupItems = passAGroups[i] ?? [];
      const prompt = deduplicatePromptPassA(groupItems);
      const maxTokens = calculateSafeMaxTokens(prompt.length, numCtx ?? DEFAULT_NUM_CTX, MAX_OUTPUT_TOKENS);
      const raw = await callLMStudio(model, prompt, lmUrl, timeoutMs, numCtx, signal, maxTokens);
      const parsed = extractJson(raw) as DedupOutput;
      fs.mkdirSync(fs.join(projectRoot, 'code-analysis', 'dedup'));
      fs.writeFileSync(fs.join(projectRoot, batch.output_file), JSON.stringify(parsed, null, 2));
      return parsed;
    },
  });

  if (passAFailed > 0) {
    logger.error('Phase 2.5 Pass A had failures — cannot proceed to Pass B', { failed: passAFailed });
    updatePhaseStatus(projectRoot, 'dedup', 'failed');
    return;
  }
```

Leave lines 75–86 (manifest read, `buildDedupBatches`, `noDedupProgress`, the `logger.info('Phase 2.5 Pass A', ...)` header, `total`/`pending`) unchanged. Delete the old `doneCount` line (old line 89) — the helper owns counting. Pass B (old line 129 onward) is unchanged.

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: PASS. No dedup behavior change.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.
> NOTE: `tsc` will NOT flag a leftover `doneCount` (no `noUnusedLocals`). Grep the `runDedupPhase` body — the old `let doneCount = …` (Pass A) must be deleted.

- [ ] **Step 5: Commit**

```bash
git add src/phases/dedup.ts
git commit -m "refactor: runDedupPhase Pass A uses runPhaseBatches"
```

---

## Task 4: Refactor `runIndexPhase` to use the helper

Index is the special case: it has a missing-files pre-skip and a one-time token-estimate warn that must fire BEFORE the retry loop (not once per attempt). Both go into an async `trySkip` that stashes prepared state for `work`.

**Files:**
- Modify: `src/phases/index.ts:12-113` (the `runIndexPhase` body)
- Test: `tests/integration/phase1.test.ts` (must stay green — it exercises all three index paths)

- [ ] **Step 1: Add the import**

At the top of `src/phases/index.ts`, add after the `PhaseOrchestrator` type import (line 10):

```ts
import { runPhaseBatches } from './phase-runner.js';
```

- [ ] **Step 2: Replace the loop with a prepared-state + trySkip design**

In `runIndexPhase`, replace the loop block (current lines 30–112, from `let failedCount = 0;` through the final `logger.info(\`Phase 1 ${finalStatus}\`, ...)`) with:

```ts
  // Prepared per-batch state computed once in trySkip (graph prefetch + prompt
  // build + token warn happen before retries, matching the original behavior).
  // fileContents only exists to build the prompt inside trySkip; once prompt is
  // built it is dead weight, so it is NOT carried in the map.
  type IndexPrep = {
    graphData: Awaited<ReturnType<typeof getFileStructure>> | null;
    prompt: string;
  };
  const prepared = new Map<string, IndexPrep>();

  const { failedCount } = await runPhaseBatches<IndexOutput[]>({
    orchestrator,
    projectRoot,
    phase: 'index',
    batches: manifest.batches.index,
    logger,
    successMeta: (batch) => ({ files: batch.files.length }),
    trySkip: async (batch) => {
      const fileContents = batch.files
        .filter(filePath => {
          if (fs.existsSync(fs.join(projectRoot, filePath))) return true;
          logger.warn(`${batch.id} skipping missing file`, { path: filePath });
          return false;
        })
        .map(filePath => ({
          path: filePath,
          content: fs.readFileSync(fs.join(projectRoot, filePath)),
        }));

      if (fileContents.length === 0) {
        return { logSuffix: ' — all files missing, skipped' };
      }

      const graphData = gitNexusCtx
        ? await getFileStructure(gitNexusCtx, batch.files)
        : null;

      const prompt = indexPrompt(fileContents, graphData);
      const estTokens = Math.ceil(prompt.length / 3.5);
      const ctxForEstimate = numCtx ?? 32000;
      if (estTokens > ctxForEstimate * 0.75) {
        logger.warn(`${batch.id} prompt estimate ~${estTokens} tokens exceeds 75% of ctx=${ctxForEstimate} — consider splitting`, { files: batch.files.length, size_bytes: batch.size_bytes });
      }

      prepared.set(batch.id, { graphData, prompt });
      return null;
    },
    work: async (batch) => {
      // trySkip always populates this for non-skipped batches (it runs first).
      const { graphData, prompt } = prepared.get(batch.id)!;
      const raw = await callLMStudio(model, prompt, lmUrl, timeoutMs, numCtx, signal, 1500);
      const parsed = extractJson(raw) as Partial<IndexOutput>[];

      // Guard: model sometimes returns a flat string[] (e.g. just the responsibilities
      // array) instead of an IndexOutput[]. Throwing here lets the orchestrator retry the batch.
      if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'object' || item === null || !('module' in item))) {
        throw new Error(`model returned invalid schema: expected IndexOutput[], got ${JSON.stringify(parsed).slice(0, 120)}`);
      }

      // Merge graph-sourced structural fields back into each item
      // data_flow is intentionally omitted — import paths are not data flow descriptions;
      // leave it for the LLM to infer from file contents
      const enriched: IndexOutput[] = parsed.map(item => {
        const posixModule = (item.module ?? '').replace(/\\/g, '/');
        const structure = graphData?.get(posixModule);
        if (!structure) return item as IndexOutput;
        return {
          ...item,
          dependencies: structure.imports,
        } as IndexOutput;
      });

      fs.mkdirSync(fs.join(projectRoot, 'code-analysis', 'index'));
      fs.writeFileSync(fs.join(projectRoot, batch.output_file), JSON.stringify(enriched, null, 2));
      return enriched;
    },
  });

  const finalStatus = failedCount > 0 ? 'failed' : 'completed';
  updatePhaseStatus(projectRoot, 'index', finalStatus);
  logger.info(`Phase 1 ${finalStatus}`, { batches: total, failed: failedCount });
}
```

Leave lines 24–29 (the `updatePhaseStatus(projectRoot, 'index', 'pending')`, manifest read, the `logger.info('Phase 1 — Indexing', ...)` header, `total`/`pending`) unchanged. Delete the old `doneCount` line (old line 31) — the helper owns counting.

> WHY `trySkip` does the prep: in the original code the missing-files filter, `getFileStructure` prefetch, prompt build, and the token-estimate `logger.warn` all run ONCE per batch *outside* `runWithRetry`. Putting them in `work` would re-run them on every retry attempt and would log the warn up to `maxAttempts` times. Stashing in `trySkip` preserves the original once-per-batch semantics.

- [ ] **Step 3: Run the index integration tests**

Run: `npx vitest run tests/integration/phase1.test.ts`
Expected: PASS — all three cases (writes output + marks completed; skips completed on re-run; marks phase failed when all batches fail).

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, no new type errors.

- [ ] **Step 5: Commit**

```bash
git add src/phases/index.ts
git commit -m "refactor: runIndexPhase uses runPhaseBatches"
```

---

## Task 5: Close the `runAnalyzePhase` test gap

`runAnalyzePhase` has no direct test (GitNexus + grep confirm: only the orchestrator calls it). Add focused integration coverage now that its loop is shared.

**Files:**
- Create: `tests/integration/phase2.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/integration/phase2.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createManifest, writeManifest, readManifest } from '../../src/manifest.js';
import { runAnalyzePhase } from '../../src/phases/analyze.js';
import { NodeFileSystemService } from '../../src/fs-service.js';
import { PhaseOrchestrator } from '../../src/phase-orchestrator.js';
import { createLogger } from '../../src/logger.js';
import { setupTempFs, type TempFsResult } from '../utils/TestEnvironmentManager.js';
import { generatePromptFixture } from '../utils/fixtures.js';

const MOCK_INDEX_ITEM = {
  module: 'src/utils/helper.ts',
  responsibilities: ['format date'],
  ui_patterns: [],
  data_flow: [],
  dependencies: [],
  duplicated_logic_candidates: [],
  inconsistencies: [],
};

const MOCK_ANALYSIS = { module_groups: [], cross_cutting: [] };

const LM_URL = 'http://localhost:1234/v1/chat/completions';
const server = setupServer();
let testRoot: string;
let tempFs: TempFsResult | undefined;

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function setupProjectWithCompletedIndex() {
  tempFs = setupTempFs('phase2-test');
  testRoot = tempFs.root;

  const manifest = createManifest(testRoot, []);
  manifest.batches.index = [{
    id: 'batch-001',
    files: ['src/utils/helper.ts'],
    size_bytes: 20,
    status: 'completed',
    attempts: 1,
    completed_at: new Date().toISOString(),
    output_file: 'code-analysis/index/batch-001.json',
  }];
  manifest.phases.index = 'completed';
  writeManifest(testRoot, manifest);

  mkdirSync(join(testRoot, 'code-analysis', 'index'), { recursive: true });
  writeFileSync(
    join(testRoot, 'code-analysis', 'index', 'batch-001.json'),
    JSON.stringify([MOCK_INDEX_ITEM]),
  );

  server.use(http.post(LM_URL, () => generatePromptFixture(JSON.stringify(MOCK_ANALYSIS))));
}

afterEach(() => {
  if (tempFs) tempFs.cleanup();
});

describe('runAnalyzePhase', () => {
  it('groups completed index output, writes a group file, and marks phase completed', async () => {
    setupProjectWithCompletedIndex();
    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
    const orchestrator = new PhaseOrchestrator(testRoot, logger);
    const fsService = new NodeFileSystemService();

    await runAnalyzePhase(orchestrator, testRoot, 'qwen/qwen3.5-9b', logger, fsService, LM_URL);

    const manifest = readManifest(testRoot);
    expect(manifest.phases.analyze).toBe('completed');
    expect(manifest.batches.analyze.length).toBeGreaterThan(0);
    expect(manifest.batches.analyze.every(b => b.status === 'completed')).toBe(true);
    expect(existsSync(join(testRoot, 'code-analysis', 'analyzer', 'group-001.json'))).toBe(true);
  });

  it('marks phase failed when the model call fails', async () => {
    setupProjectWithCompletedIndex();
    server.use(http.post(LM_URL, () => new HttpResponse('error', { status: 500 })));

    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
    const orchestrator = new PhaseOrchestrator(testRoot, logger);
    const fsService = new NodeFileSystemService();

    await runAnalyzePhase(orchestrator, testRoot, 'qwen/qwen3.5-9b', logger, fsService, LM_URL);

    expect(readManifest(testRoot).phases.analyze).toBe('failed');
  }, 15000);
});
```

- [ ] **Step 2: Run the new test**

Run: `npx vitest run tests/integration/phase2.test.ts`
Expected: PASS (2 tests). If the success test fails on the output filename, inspect `byteGroupIndexOutputs` in `analyze.ts` — group ids are `group-001`, `group-002`, … under `code-analysis/analyzer/`.

> NOTE: `MOCK_ANALYSIS` shape only needs to be valid JSON — `runAnalyzePhase` casts via `extractJson` with no schema guard (unlike index). If `AnalysisOutput` in `src/types.ts` has required fields the cast complains about at compile time, widen `MOCK_ANALYSIS` to match, or keep it untyped (it is passed as a JSON string to the mock, so no compile-time check applies).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/phase2.test.ts
git commit -m "test: add runAnalyzePhase integration coverage"
```

---

## Task 6: Final verification and impact confirmation

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: PASS — all suites green, including the new `phase-runner` unit tests and `phase2` integration tests.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Security audit (per global pre-push policy)**

Run: `npm audit --audit-level=high`
Expected: no new high/critical advisories vs. baseline.

- [ ] **Step 4: Confirm the change surface with GitNexus**

Re-index and verify only the expected symbols/flows changed:

```
node .gitnexus/run.cjs analyze
```

Then via the GitNexus MCP: `detect_changes({ scope: "compare", base_ref: "master" })`.
Expected affected symbols: `runPhaseBatches` (new), `runIndexPhase`, `runAnalyzePhase`, `runDedupPhase`. No change to `PhaseOrchestrator.runPipeline`, `aggregate.ts`, or `batcher.ts`. If `detect_changes` reports anything outside this set, stop and investigate before merging.

- [ ] **Step 5: Final commit (if re-index produced index artifacts)**

```bash
git add -A
git commit -m "chore: reindex after phase-runner extraction"
```

---

## Summary of Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Index's once-per-batch warn/prefetch becomes per-retry, changing log volume | Low | `trySkip` runs prep before `runWithRetry`; Task 4 Step 3 verifies phase1 tests stay green |
| Success-log meta divergence (index `{ files }` vs analyze/dedup none) | Low | `successMeta` hook; helper omits the 2nd arg entirely when meta is undefined |
| dedup Pass B accidentally folded in | Low | Task 3 explicitly scopes to Pass A; Pass B block left byte-for-byte |
| `doneCount` left declared-but-unused after extraction | Low | tsconfig does NOT set `noUnusedLocals`, so `tsc` will NOT flag it. Each refactor task instead requires grepping the function body: `doneCount` must appear 0×. The helper owns counting. |
| Generic helper grows new responsibilities later | Low | Helper deliberately excludes phase-status/finalStatus; keep callers owning that |

## Self-Review (completed by author)

- **Coverage:** Each in-scope loop (index/analyze/dedup-PassA) has a refactor task; the analyze test gap has Task 5; out-of-scope files (aggregate, dedup Pass B, batcher) are explicitly excluded with rationale.
- **No placeholders:** Every code step contains full code; no "TBD"/"add error handling".
- **Type consistency:** `runPhaseBatches` / `PhaseBatchLoopOptions` / `PhaseBatchLoopResult` names match across Tasks 1–4; `phase` values (`'index'|'analyze'|'dedup'`) match `BatchPhase`; `updateBatchStatus` argument order matches `src/manifest.ts:44`.

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
2. **Inline Execution** — execute tasks in this session with checkpoints. REQUIRED SUB-SKILL: superpowers:executing-plans.
