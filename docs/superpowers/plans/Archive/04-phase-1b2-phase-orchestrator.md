# Phase 1b.2 — Centralize Phase Orchestration
## Implementation Plan

**Version**: 1.0 — 2026-06-22
**Requires**: Phase 1b.1 complete (`src/llm-client.ts` exists and exports `LLMClient`)
**Gate**: Run full integration test suite after this PR merges. Phase 2 does not start until green.

---

## Provides / Requires

**Provides:**
- `src/phase-orchestrator.ts` — new file; exports `PhaseOrchestrator`
- `src/process-helpers.ts` — new file; exports `spawnAsync`, `detectGitNexus`
- `src/index.ts` — modified; wiring-only, all business logic removed
- `src/phases/index.ts` — modified; `withRetry`/`MAX_ATTEMPTS` replaced by injected orchestrator
- `src/phases/analyze.ts` — modified; same
- `src/phases/dedup.ts` — modified; same
- `src/phases/aggregate.ts` — modified; same
- Standard T2 (`Orchestration Boundary`) now enforced

**Requires:**
- `src/llm-client.ts` (Phase 1b.1) present on branch
- `src/retry.ts` — already exists, unchanged
- `src/manifest.ts` — already exists, unchanged
- All four phase modules — modified in this PR

---

## Standards Checklist

| Standard | Applies | Disposition |
|---|---|---|
| C1 — No Hardcoded Runtime Values | Yes | `MAX_ATTEMPTS` externalized to `PhaseOrchestrator` constructor |
| C4 — Utility Extraction | Yes (blocker) | This PR touches phase files. No new inline JSON parsing may be added. Existing inline parsing (C4 violations) is pre-existing — deferred to Phase 2.2, not worsened here |
| T2 — Orchestration Boundary | Yes (this PR gates it) | `PhaseOrchestrator` owns loop, retry, manifest reads/writes after merge |
| E1 — Consistent Async/Await | Yes | All orchestrator methods are async |

---

## Pre-Work: Read Before Coding (MANDATORY)

Read the following files before writing any code. This phase makes structural changes across 8 files — incorrect assumptions about existing signatures will cause cascade failures.

1. `src/phases/index.ts` — confirm `withRetry` import, `MAX_ATTEMPTS = 3`, `runIndexPhase` signature
2. `src/phases/analyze.ts` — same
3. `src/phases/dedup.ts` — note TWO `withRetry` calls (Pass A and Pass B)
4. `src/phases/aggregate.ts` — one `withRetry` call
5. `src/index.ts` — identify `spawnAsync` (lines ~62–68), `detectGitNexus` (lines ~70–117), and `main()`
6. `src/retry.ts` — confirm `withRetry` signature
7. `src/manifest.ts` — confirm `readManifest`, `writeManifest`, `updatePhaseStatus`, `resetPhase` exports
8. `src/preflight.ts` — confirm both `ensureModelReady` AND `resolveLoadedIdentifier` are separate exports with distinct semantics

---

## File 1: `src/process-helpers.ts` (NEW)

### 1. File Overview

Receives `spawnAsync` and `detectGitNexus` from `src/index.ts`. Moving them here satisfies the wiring-only requirement for `src/index.ts` without adding process-management logic to `PhaseOrchestrator`.

### 2. Change Summary

New file. Copy both functions verbatim from `src/index.ts`. Export both.

### 3. Detailed Code

```typescript
import { existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
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
      logger.warn('npx gitnexus analyze exited non-zero — skipping GitNexus enrichment', {
        code: exitCode,
      });
      return null;
    }
  } catch {
    logger.warn('npx gitnexus analyze failed to spawn — skipping enrichment');
    return null;
  }

  const ctx = await openGitNexus(projectRoot);
  if (!ctx) {
    logger.warn('GitNexus schema probe failed or DB locked — skipping enrichment');
  }
  return ctx;
}
```

### 4. Implementation Notes

- `closeGitNexus` is NOT imported here — the cleanup registration (`process.once('exit', ...)`) stays in `src/index.ts` as lifecycle wiring.
- No logic changes from the original inline functions.

### 5. Validation & Testing

- `npx tsc --noEmit` must pass
- After full PR: `grep detectGitNexus src/` returns exactly two hits — export and one import

### 6. Idempotency & Safety Checks

- File does not exist — creation is safe
- Original inline functions in `src/index.ts` are removed in that file's section below

---

## File 2: `src/phase-orchestrator.ts` (NEW)

### 1. File Overview

`PhaseOrchestrator` owns: main execution loop, retry invocation, manifest state reads/writes. It does not own batch I/O or prompt logic. Constructor accepts `maxAttempts` via parameter (C1 compliance). Line-count target: ≤200 lines.

### 2. Change Summary

New file. ~130 lines.

### 3. Detailed Code

```typescript
import {
  readManifest, manifestExists, createManifest, writeManifest,
  resetPhase, updatePhaseStatus,
} from './manifest.js';
import { createBatches } from './batcher.js';
import { withRetry } from './retry.js';
import { ensureModelReady, resolveLoadedIdentifier } from './preflight.js';
import { runUsesModel } from './run-plan.js';
import { runIndexPhase } from './phases/index.js';
import { runAnalyzePhase } from './phases/analyze.js';
import { runDedupPhase } from './phases/dedup.js';
import { runAggregatePhase } from './phases/aggregate.js';
import { discoverFiles } from './discovery.js';
import type { Logger } from './logger.js';
import type { Phase, PhaseStatus } from './types.js';
import type { GitNexusContext } from './gitnexus.js';

export interface PipelineOptions {
  model: string;
  maxBatchSize: number;
  phase: string | undefined;
  resume: boolean;
  timeoutMs: number;
  numCtx: number;
  skipPreflight: boolean;
  gitNexusCtx: GitNexusContext | null;
}

export class PhaseOrchestrator {
  private readonly projectRoot: string;
  private readonly logger: Logger;
  public readonly maxAttempts: number;
  private readonly signal: AbortSignal | undefined;

  constructor(
    projectRoot: string,
    logger: Logger,
    maxAttempts = 3,
    signal?: AbortSignal,
  ) {
    this.projectRoot = projectRoot;
    this.logger = logger;
    this.maxAttempts = maxAttempts;
    this.signal = signal;
  }

  async runWithRetry<T>(
    fn: () => Promise<T>,
    onAttemptError: (attempt: number, err: unknown) => void,
  ): Promise<{ value: T; attempts: number } | null> {
    return withRetry(fn, this.maxAttempts, onAttemptError, this.signal);
  }

  readPhaseStatus(phase: Phase): PhaseStatus {
    return readManifest(this.projectRoot).phases[phase];
  }

  writePhaseStatus(phase: Phase, status: PhaseStatus): void {
    updatePhaseStatus(this.projectRoot, phase, status);
  }

  async runPipeline(opts: PipelineOptions): Promise<void> {
    const { model, maxBatchSize, phase, resume, timeoutMs, numCtx, skipPreflight, gitNexusCtx } = opts;

    const hasManifest = manifestExists(this.projectRoot);

    if (!hasManifest) {
      const files = discoverFiles(this.projectRoot);
      const manifest = createManifest(this.projectRoot, files);
      manifest.batches.index = createBatches(files, 'index', maxBatchSize);
      writeManifest(this.projectRoot, manifest);
      this.logger.info('Discovery complete', { files: files.length });
    } else if (phase && !resume) {
      resetPhase(this.projectRoot, phase as Phase);
      this.logger.info(`Phase ${phase} reset`);
    }

    if (runUsesModel(phase) && !skipPreflight) {
      await ensureModelReady(model, numCtx, this.logger);
    }

    if (!phase || phase === 'index') {
      const m = readManifest(this.projectRoot);
      if (m.phases.index !== 'completed') {
        const resolvedModel = await resolveLoadedIdentifier(model, numCtx, this.logger, { readOnly: skipPreflight });
        await runIndexPhase(this, this.projectRoot, resolvedModel, this.logger, undefined, timeoutMs, numCtx, this.signal, gitNexusCtx);
      }
      if (readManifest(this.projectRoot).phases.index === 'failed') {
        this.logger.error('Phase 1 failed — halting'); process.exit(1);
      }
    }

    if (!phase || phase === 'analyze') {
      const m = readManifest(this.projectRoot);
      if (m.phases.analyze !== 'completed') {
        const resolvedModel = await resolveLoadedIdentifier(model, numCtx, this.logger, { readOnly: skipPreflight });
        await runAnalyzePhase(this, this.projectRoot, resolvedModel, this.logger, undefined, timeoutMs, numCtx, this.signal, gitNexusCtx);
      }
      if (readManifest(this.projectRoot).phases.analyze === 'failed') {
        this.logger.error('Phase 2 failed — halting'); process.exit(1);
      }
    }

    if (!phase || phase === 'dedup') {
      const m = readManifest(this.projectRoot);
      if (m.phases.dedup !== 'completed') {
        const resolvedModel = await resolveLoadedIdentifier(model, numCtx, this.logger, { readOnly: skipPreflight });
        await runDedupPhase(this, this.projectRoot, resolvedModel, this.logger, undefined, timeoutMs, numCtx, this.signal);
      }
      if (readManifest(this.projectRoot).phases.dedup === 'failed') {
        this.logger.error('Phase 2.5 failed — halting'); process.exit(1);
      }
    }

    if (!phase || phase === 'aggregate') {
      const m = readManifest(this.projectRoot);
      if (m.phases.aggregate !== 'completed') {
        const resolvedModel = await resolveLoadedIdentifier(model, numCtx, this.logger, { readOnly: skipPreflight });
        await runAggregatePhase(this, this.projectRoot, resolvedModel, this.logger, undefined, timeoutMs, numCtx, this.signal);
      }
      if (readManifest(this.projectRoot).phases.aggregate === 'failed') {
        this.logger.error('Phase 3 failed — halting'); process.exit(1);
      }
    }

    this.logger.info('Pipeline complete');
  }
}
```

### 4. Implementation Notes

- **VERIFY before finalizing**: Read `src/preflight.ts` to confirm both `ensureModelReady` and `resolveLoadedIdentifier` are separate exports with distinct semantics. The `ensureModelReady` call is the top-level preflight guard; `resolveLoadedIdentifier` returns the actual identifier string per phase.
- **VERIFY**: Read `src/retry.ts` to confirm `withRetry` signature matches `runWithRetry`'s delegation.
- `maxAttempts` is `public readonly` so phase modules can reference `orchestrator.maxAttempts` in `updateBatchStatus` failure paths.
- Line count: ~125 lines. Well within the 200-line cap. No split needed.

### 5. Validation & Testing

- `npx tsc --noEmit` must pass
- `wc -l src/phase-orchestrator.ts` must be ≤ 200
- All existing integration tests pass without modification (see File 8 for test update)
- `npx vitest run` — all tests green

### 6. Idempotency & Safety Checks

- `PhaseOrchestrator` is stateless between runs — all state is on disk in the manifest
- Re-running `runPipeline` is idempotent: phase-status checks prevent re-running completed phases

---

## Files 3–6: Phase modules (MODIFIED)

For each of the four phase modules, apply the same structural change:
1. Remove `const MAX_ATTEMPTS = 3`
2. Remove `import { withRetry }` 
3. Add `import type { PhaseOrchestrator } from '../phase-orchestrator.js'`
4. Add `orchestrator: PhaseOrchestrator` as first parameter of the exported function
5. Replace all `withRetry(fn, MAX_ATTEMPTS, onErr, signal)` calls with `orchestrator.runWithRetry(fn, onErr)`
6. Replace `MAX_ATTEMPTS` in failure-path `updateBatchStatus` calls with `orchestrator.maxAttempts`

### `src/phases/index.ts`

- One `withRetry` call. One `MAX_ATTEMPTS` reference.
- Inner body of `withRetry` callback: **no changes** — inline brace-tracking functions (`extractJsonArray`, `extractJsonFromResponse`) are pre-existing C4 violations, deferred to Phase 2.2. Do not remove or add inline parsing.

### `src/phases/analyze.ts`

- One `withRetry` call. One `MAX_ATTEMPTS` reference.
- `JSON.parse(raw)` on LLM output is pre-existing C4 violation — do not change.

### `src/phases/dedup.ts`

- **Two** `withRetry` calls (Pass A and Pass B) — replace both.
- Two `MAX_ATTEMPTS` references — replace both.
- `safeMaxTokens` local function stays — it is not orchestration logic.
- `JSON.parse(raw)` on LLM output lines — pre-existing C4, do not change.

### `src/phases/aggregate.ts`

- One `withRetry` call. One `MAX_ATTEMPTS` reference.
- No JSON parsing on LLM output in this file — no C4 concern.

---

## File 7: `src/index.ts` (MODIFIED — full replacement)

### 1. File Overview

After this PR: wiring-only. Argument parsing, logger init, signal handlers, delegate to `PhaseOrchestrator`.

### 2. Detailed Code — Full File

```typescript
#!/usr/bin/env node
import minimist from 'minimist';
import { createLogger } from './logger.js';
import { DEFAULT_MODEL } from './models.js';
import { join } from 'path';
import { closeGitNexus } from './gitnexus.js';
import { detectGitNexus } from './process-helpers.js';
import { PhaseOrchestrator } from './phase-orchestrator.js';

const args = minimist(process.argv.slice(2), {
  string: ['phase', 'model-override'],
  boolean: ['resume', 'skip-preflight', 'version'],
  alias: { v: 'version' },
});

if (args['version']) {
  const { createRequire } = await import('module');
  const req = createRequire(import.meta.url);
  const pkg = req('../../package.json') as { version: string };
  console.log(pkg.version);
  process.exit(0);
}

const projectRoot = process.cwd();
const model: string = (args['model-override'] as string | undefined) ?? DEFAULT_MODEL;
const maxBatchSize: number = args['max-batch-size'] !== undefined
  ? Number(args['max-batch-size'])
  : Number(process.env['MAX_BATCH_SIZE'] ?? 8000);
const phase: string | undefined = args['phase'] as string | undefined;
const resume: boolean = (args['resume'] as boolean | undefined) ?? false;
const timeoutMs: number = args['timeout'] !== undefined
  ? Number(args['timeout']) * 1000
  : Number(process.env['DEFAULT_TIMEOUT_MS'] ?? 600_000);
const numCtx: number = args['num-ctx'] !== undefined ? Number(args['num-ctx']) : 32000;
const skipPreflight: boolean = (args['skip-preflight'] as boolean | undefined) ?? false;

if (!Number.isInteger(numCtx) || numCtx <= 0) {
  console.error(`Invalid --num-ctx: must be a positive integer (got ${args['num-ctx']})`);
  process.exit(1);
}

const logger = createLogger(join(projectRoot, 'code-analysis', 'logs', 'run.log'));

const runController = new AbortController();
const handleSignal = (sig: string) => {
  logger.info(`${sig} received — cancelling run`);
  runController.abort();
  setTimeout(() => process.exit(sig === 'SIGINT' ? 130 : 143), 3000).unref();
};
process.once('SIGINT', () => handleSignal('SIGINT'));
process.once('SIGTERM', () => handleSignal('SIGTERM'));

async function main() {
  const gitNexusCtx = await detectGitNexus(projectRoot, logger);
  process.once('exit', () => { if (gitNexusCtx) closeGitNexus(gitNexusCtx); });
  process.once('uncaughtException', (e) => { if (gitNexusCtx) closeGitNexus(gitNexusCtx); throw e; });

  const orchestrator = new PhaseOrchestrator(projectRoot, logger, 3, runController.signal);
  await orchestrator.runPipeline({ model, maxBatchSize, phase, resume, timeoutMs, numCtx, skipPreflight, gitNexusCtx });
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

### 3. Post-edit verification

```powershell
grep -n "withRetry|runIndexPhase|runAnalyzePhase|runDedupPhase|runAggregatePhase|discoverFiles|createManifest|resetPhase|ensureModelReady|resolveLoadedIdentifier" src/index.ts
# Expected: zero results
```

---

## File 8: `tests/integration/phase1.test.ts` (MODIFIED)

`runIndexPhase` gains `orchestrator` as first parameter. Update all three call sites.

```diff
+import { PhaseOrchestrator } from '../../src/phase-orchestrator.js';

 // In each it() block that calls runIndexPhase:
+  const orchestrator = new PhaseOrchestrator(testRoot, logger);
-  await runIndexPhase(testRoot, 'qwen/qwen3.5-9b', logger, LM_URL);
+  await runIndexPhase(orchestrator, testRoot, 'qwen/qwen3.5-9b', logger, LM_URL);
```

Apply to all three test cases. `new PhaseOrchestrator(testRoot, logger)` uses default `maxAttempts = 3` — no behavior change.

---

## Execution Order

```
1. Read all 8 files listed in Pre-Work (mandatory)
2. Create src/process-helpers.ts
3. Create src/phase-orchestrator.ts
4. Modify src/phases/index.ts
5. Modify src/phases/analyze.ts
6. Modify src/phases/dedup.ts
7. Modify src/phases/aggregate.ts
8. Replace src/index.ts
9. Modify tests/integration/phase1.test.ts
10. npx tsc --noEmit  [must pass]
11. npx vitest run  [must pass — GATE for Phase 2]
```

## Environment Config (C1 compliance)

Add the following to `.env.example` documenting the defaults now sourced from env vars:

```
MAX_BATCH_SIZE=8000
DEFAULT_TIMEOUT_MS=600000
```

These were formerly hardcoded literals in `src/index.ts`. They are now read from environment with the same values as defaults.

## Post-PR Verification

```powershell
# No retry logic outside orchestrator
grep -rn "withRetry|MAX_ATTEMPTS" src/phases/

# No business logic in index.ts
grep -n "withRetry|runIndexPhase|discoverFiles|createManifest|resetPhase" src/index.ts

# PhaseOrchestrator line count
(Get-Content src/phase-orchestrator.ts).Count  # must be <= 200

# C4 guard: no new inline JSON parsing in touched files
grep -n "JSON.parse" src/phases/index.ts src/phases/analyze.ts src/phases/dedup.ts src/phases/aggregate.ts
# Verify: only pre-existing hits, no new code added by this PR
```
