# Code Analyzer CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a globally-installable TypeScript CLI that runs a four-phase AI-assisted code analysis pipeline (index → analyze → aggregate → refactor) with crash-safe, resumable state via a manifest file.

**Architecture:** Phases run sequentially; each batch writes output files and updates `code-analysis/manifest.json` atomically on every status change. LM Studio handles Phases 1, 2, 4 via OpenAI-compatible REST. The `claude` CLI subprocess handles Phase 3. A shared retry helper provides exponential backoff for Phases 1, 2, 4.

**Tech Stack:** TypeScript 5, Node.js 20+, Vitest, msw 2.x, tsx, minimist

---

## File Map

| File | Responsibility |
|------|---------------|
| `src/types.ts` | All shared interfaces |
| `src/logger.ts` | Append-only structured logger |
| `src/manifest.ts` | Atomic manifest read/write/update |
| `src/discovery.ts` | Recursive file scan with exclusions |
| `src/batcher.ts` | Group FileEntry[] into byte-bounded BatchEntry[] |
| `src/retry.ts` | Exponential backoff retry helper |
| `src/lm-studio.ts` | POST to localhost:1234/v1/chat/completions |
| `src/claude-cli.ts` | Subprocess wrapper for `claude -p` |
| `src/prompts/templates.ts` | Prompt strings per phase |
| `src/phases/index.ts` | Phase 1: indexing |
| `src/phases/analyze.ts` | Phase 2: analysis |
| `src/phases/aggregate.ts` | Phase 3: aggregation |
| `src/phases/refactor.ts` | Phase 4: refactor planning |
| `src/index.ts` | CLI entry: arg parsing + phase orchestration |
| `tests/unit/batcher.test.ts` | Batcher byte-boundary logic |
| `tests/unit/manifest.test.ts` | Manifest CRUD + atomic write |
| `tests/unit/discovery.test.ts` | Exclusion rules + size filtering |
| `tests/unit/lm-studio.test.ts` | HTTP client behavior |
| `tests/integration/phase1.test.ts` | Phase 1 end-to-end with MSW mock |
| `tests/fixtures/sample-project/` | Small TS project for integration tests |

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "code-analyzer",
  "version": "0.1.0",
  "type": "module",
  "bin": { "code-analyzer": "./dist/index.js" },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "test": "vitest",
    "test:run": "vitest run"
  },
  "dependencies": {
    "minimist": "^1.2.8"
  },
  "devDependencies": {
    "@types/minimist": "^1.2.5",
    "@types/node": "^20.0.0",
    "msw": "^2.2.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
code-analysis/
*.tmp
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`

Expected: `node_modules/` created, no errors.

- [ ] **Step 6: Create src directory structure**

Run: `mkdir -p src/phases src/prompts tests/unit tests/integration tests/fixtures/sample-project/src`

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore
git commit -m "feat: project scaffold — TypeScript CLI for code-analyzer"
```

---

### Task 2: Shared Types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write src/types.ts**

```typescript
export type PhaseStatus = 'pending' | 'completed' | 'failed';
export type Phase = 'index' | 'analyze' | 'aggregate' | 'refactor';
export type BatchPhase = 'index' | 'analyze' | 'refactor';

export interface FileEntry {
  path: string;
  size_bytes: number;
  skipped: boolean;
  skip_reason: string | null;
}

export interface BatchEntry {
  id: string;
  files: string[];
  size_bytes: number;
  status: 'pending' | 'completed' | 'failed';
  attempts: number;
  completed_at: string | null;
  output_file: string;
}

export interface Manifest {
  version: 1;
  created: string;
  last_run: string;
  project_root: string;
  files: FileEntry[];
  batches: {
    index: BatchEntry[];
    analyze: BatchEntry[];
    refactor: BatchEntry[];
  };
  phases: {
    index: PhaseStatus;
    analyze: PhaseStatus;
    aggregate: PhaseStatus;
    refactor: PhaseStatus;
  };
}

export interface IndexOutput {
  module: string;
  responsibilities: string[];
  ui_patterns: string[];
  data_flow: string[];
  dependencies: string[];
  duplicated_logic_candidates: Array<{ description: string; similar_to: string[] }>;
  inconsistencies: Array<{ type: string; issue: string }>;
}

export interface AnalysisOutput {
  duplication_clusters: Array<{ description: string; files: string[] }>;
  ui_inconsistencies: Array<{ description: string; files: string[] }>;
  architecture_inconsistencies: Array<{ description: string; files: string[] }>;
  candidate_shared_components: Array<{ name: string; rationale: string; files: string[] }>;
  candidate_utility_functions: Array<{ name: string; rationale: string; files: string[] }>;
}

export interface RefactorPlanEntry {
  file: string;
  change: string;
  before: string;
  after: string;
  dependencies_impacted: string[];
  tests_to_validate: string[];
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: shared TypeScript interfaces for manifest, phases, and outputs"
```

---

### Task 3: Logger

**Files:**
- Create: `src/logger.ts`
- Create: `tests/unit/logger.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/logger.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createLogger } from '../../src/logger.js';

let testDir: string;
let logPath: string;

beforeEach(() => {
  testDir = join(tmpdir(), `logger-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  logPath = join(testDir, 'run.log');
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('createLogger', () => {
  it('appends INFO lines to log file', () => {
    const logger = createLogger(logPath);
    logger.info('Phase 1 started', { model: 'qwen' });
    const content = readFileSync(logPath, 'utf8');
    expect(content).toMatch(/\[INFO\].*Phase 1 started.*model=qwen/);
  });

  it('appends ERROR lines', () => {
    const logger = createLogger(logPath);
    logger.error('batch failed', { error: 'timeout' });
    const content = readFileSync(logPath, 'utf8');
    expect(content).toMatch(/\[ERROR\].*batch failed.*error=timeout/);
  });

  it('creates parent directory if missing', () => {
    const nested = join(testDir, 'logs', 'nested', 'run.log');
    const logger = createLogger(nested);
    logger.info('test');
    const content = readFileSync(nested, 'utf8');
    expect(content).toContain('[INFO]');
  });

  it('includes ISO timestamp', () => {
    const logger = createLogger(logPath);
    logger.info('event');
    const content = readFileSync(logPath, 'utf8');
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('appends multiple lines without overwriting', () => {
    const logger = createLogger(logPath);
    logger.info('first');
    logger.info('second');
    const content = readFileSync(logPath, 'utf8');
    expect(content).toContain('first');
    expect(content).toContain('second');
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `npx vitest run tests/unit/logger.test.ts`

Expected: FAIL — `Cannot find module '../../src/logger.js'`

- [ ] **Step 3: Write src/logger.ts**

```typescript
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export type LogLevel = 'INFO' | 'ERROR' | 'WARN';

export function createLogger(logPath: string) {
  mkdirSync(dirname(logPath), { recursive: true });

  function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
    const ts = new Date().toISOString();
    const metaStr = meta
      ? ' | ' + Object.entries(meta).map(([k, v]) => `${k}=${v}`).join(' ')
      : '';
    appendFileSync(logPath, `[${ts}] [${level}]  ${message}${metaStr}\n`, 'utf8');
  }

  return {
    info: (msg: string, meta?: Record<string, unknown>) => log('INFO', msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) => log('ERROR', msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => log('WARN', msg, meta),
  };
}

export type Logger = ReturnType<typeof createLogger>;
```

- [ ] **Step 4: Run test — expect pass**

Run: `npx vitest run tests/unit/logger.test.ts`

Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/logger.ts tests/unit/logger.test.ts
git commit -m "feat: append-only logger with ISO timestamps and structured metadata"
```

---

### Task 4: Manifest

**Files:**
- Create: `src/manifest.ts`
- Create: `tests/unit/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/manifest.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  manifestExists,
  createManifest,
  readManifest,
  writeManifest,
  updateBatchStatus,
  updatePhaseStatus,
  resetPhase,
} from '../../src/manifest.js';
import type { FileEntry } from '../../src/types.js';

let testRoot: string;

beforeEach(() => {
  testRoot = join(tmpdir(), `manifest-test-${Date.now()}`);
  mkdirSync(testRoot, { recursive: true });
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('manifestExists', () => {
  it('returns false when no manifest present', () => {
    expect(manifestExists(testRoot)).toBe(false);
  });

  it('returns true after writing manifest', () => {
    writeManifest(testRoot, createManifest(testRoot, []));
    expect(manifestExists(testRoot)).toBe(true);
  });
});

describe('writeManifest / readManifest', () => {
  it('round-trips data correctly', () => {
    const files: FileEntry[] = [
      { path: 'src/a.ts', size_bytes: 1000, skipped: false, skip_reason: null },
    ];
    const m = createManifest(testRoot, files);
    writeManifest(testRoot, m);
    const read = readManifest(testRoot);
    expect(read.files).toEqual(files);
    expect(read.version).toBe(1);
    expect(read.phases.index).toBe('pending');
  });

  it('writes to code-analysis/manifest.json', () => {
    writeManifest(testRoot, createManifest(testRoot, []));
    expect(existsSync(join(testRoot, 'code-analysis', 'manifest.json'))).toBe(true);
  });

  it('does not leave .tmp file on disk', () => {
    writeManifest(testRoot, createManifest(testRoot, []));
    expect(existsSync(join(testRoot, 'code-analysis', 'manifest.json.tmp'))).toBe(false);
  });
});

describe('updateBatchStatus', () => {
  it('marks batch completed and sets completed_at', () => {
    const m = createManifest(testRoot, []);
    m.batches.index = [{
      id: 'batch-001', files: [], size_bytes: 0,
      status: 'pending', attempts: 0, completed_at: null,
      output_file: 'code-analysis/index/batch-001.json',
    }];
    writeManifest(testRoot, m);

    updateBatchStatus(testRoot, 'index', 'batch-001', 'completed', 1);

    const updated = readManifest(testRoot);
    expect(updated.batches.index[0].status).toBe('completed');
    expect(updated.batches.index[0].attempts).toBe(1);
    expect(updated.batches.index[0].completed_at).not.toBeNull();
  });

  it('marks batch failed', () => {
    const m = createManifest(testRoot, []);
    m.batches.index = [{
      id: 'batch-001', files: [], size_bytes: 0,
      status: 'pending', attempts: 0, completed_at: null,
      output_file: 'code-analysis/index/batch-001.json',
    }];
    writeManifest(testRoot, m);

    updateBatchStatus(testRoot, 'index', 'batch-001', 'failed', 3);

    const updated = readManifest(testRoot);
    expect(updated.batches.index[0].status).toBe('failed');
    expect(updated.batches.index[0].attempts).toBe(3);
    expect(updated.batches.index[0].completed_at).toBeNull();
  });
});

describe('updatePhaseStatus', () => {
  it('persists new phase status', () => {
    writeManifest(testRoot, createManifest(testRoot, []));
    updatePhaseStatus(testRoot, 'index', 'completed');
    expect(readManifest(testRoot).phases.index).toBe('completed');
  });
});

describe('resetPhase', () => {
  it('resets phase status and all its batches to pending', () => {
    const m = createManifest(testRoot, []);
    m.phases.index = 'completed';
    m.batches.index = [{
      id: 'batch-001', files: [], size_bytes: 0,
      status: 'completed', attempts: 2,
      completed_at: '2026-01-01T00:00:00Z',
      output_file: 'code-analysis/index/batch-001.json',
    }];
    writeManifest(testRoot, m);

    resetPhase(testRoot, 'index');

    const updated = readManifest(testRoot);
    expect(updated.phases.index).toBe('pending');
    expect(updated.batches.index[0].status).toBe('pending');
    expect(updated.batches.index[0].attempts).toBe(0);
    expect(updated.batches.index[0].completed_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `npx vitest run tests/unit/manifest.test.ts`

Expected: FAIL — `Cannot find module '../../src/manifest.js'`

- [ ] **Step 3: Write src/manifest.ts**

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import type { Manifest, FileEntry, PhaseStatus, Phase, BatchPhase } from './types.js';

const MANIFEST_RELATIVE = join('code-analysis', 'manifest.json');

export function manifestPath(projectRoot: string): string {
  return join(projectRoot, MANIFEST_RELATIVE);
}

export function manifestExists(projectRoot: string): boolean {
  return existsSync(manifestPath(projectRoot));
}

export function createManifest(projectRoot: string, files: FileEntry[]): Manifest {
  const now = new Date().toISOString();
  return {
    version: 1,
    created: now,
    last_run: now,
    project_root: projectRoot,
    files,
    batches: { index: [], analyze: [], refactor: [] },
    phases: { index: 'pending', analyze: 'pending', aggregate: 'pending', refactor: 'pending' },
  };
}

export function readManifest(projectRoot: string): Manifest {
  return JSON.parse(readFileSync(manifestPath(projectRoot), 'utf8')) as Manifest;
}

export function writeManifest(projectRoot: string, manifest: Manifest): void {
  const path = manifestPath(projectRoot);
  const tmp = path + '.tmp';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  renameSync(tmp, path);
}

export function updateBatchStatus(
  projectRoot: string,
  phase: BatchPhase,
  batchId: string,
  status: 'completed' | 'failed',
  attempts: number
): void {
  const manifest = readManifest(projectRoot);
  const batch = manifest.batches[phase].find(b => b.id === batchId);
  if (!batch) throw new Error(`Batch ${batchId} not found in phase ${phase}`);
  batch.status = status;
  batch.attempts = attempts;
  batch.completed_at = status === 'completed' ? new Date().toISOString() : null;
  manifest.last_run = new Date().toISOString();
  writeManifest(projectRoot, manifest);
}

export function updatePhaseStatus(projectRoot: string, phase: Phase, status: PhaseStatus): void {
  const manifest = readManifest(projectRoot);
  manifest.phases[phase] = status;
  manifest.last_run = new Date().toISOString();
  writeManifest(projectRoot, manifest);
}

export function resetPhase(projectRoot: string, phase: Phase): void {
  const manifest = readManifest(projectRoot);
  manifest.phases[phase] = 'pending';
  if (phase !== 'aggregate') {
    const key = phase as BatchPhase;
    manifest.batches[key] = manifest.batches[key].map(b => ({
      ...b,
      status: 'pending' as const,
      attempts: 0,
      completed_at: null,
    }));
  }
  writeManifest(projectRoot, manifest);
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `npx vitest run tests/unit/manifest.test.ts`

Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/manifest.ts tests/unit/manifest.test.ts
git commit -m "feat: atomic manifest read/write with batch and phase status updates"
```

---

### Task 5: Discovery

**Files:**
- Create: `src/discovery.ts`
- Create: `tests/unit/discovery.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/discovery.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverFiles } from '../../src/discovery.js';

let testRoot: string;

beforeEach(() => {
  testRoot = join(tmpdir(), `discovery-test-${Date.now()}`);
  mkdirSync(testRoot, { recursive: true });
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('discoverFiles', () => {
  it('finds files in subdirectories', () => {
    mkdirSync(join(testRoot, 'src'));
    writeFileSync(join(testRoot, 'src', 'a.ts'), 'export const x = 1;');
    const files = discoverFiles(testRoot);
    expect(files.some(f => f.path === 'src/a.ts')).toBe(true);
  });

  it('uses forward slashes on all platforms', () => {
    mkdirSync(join(testRoot, 'src', 'utils'), { recursive: true });
    writeFileSync(join(testRoot, 'src', 'utils', 'helper.ts'), 'x');
    const files = discoverFiles(testRoot);
    expect(files.find(f => f.path.includes('helper'))?.path).toBe('src/utils/helper.ts');
  });

  it('excludes node_modules, .git, dist, build, out, coverage, code-analysis', () => {
    for (const dir of ['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'code-analysis']) {
      mkdirSync(join(testRoot, dir), { recursive: true });
      writeFileSync(join(testRoot, dir, 'file.js'), 'x');
    }
    const files = discoverFiles(testRoot);
    expect(files).toHaveLength(0);
  });

  it('marks files over 500KB as skipped with skip_reason size_exceeded', () => {
    writeFileSync(join(testRoot, 'big.ts'), 'x'.repeat(501 * 1024));
    const files = discoverFiles(testRoot);
    const big = files.find(f => f.path === 'big.ts');
    expect(big?.skipped).toBe(true);
    expect(big?.skip_reason).toBe('size_exceeded');
  });

  it('includes size_bytes for each file', () => {
    writeFileSync(join(testRoot, 'a.ts'), 'hello');
    const files = discoverFiles(testRoot);
    expect(files[0].size_bytes).toBe(5);
  });

  it('does not skip files under 500KB', () => {
    writeFileSync(join(testRoot, 'normal.ts'), 'export const x = 1;');
    const files = discoverFiles(testRoot);
    expect(files[0].skipped).toBe(false);
    expect(files[0].skip_reason).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `npx vitest run tests/unit/discovery.test.ts`

Expected: FAIL — `Cannot find module '../../src/discovery.js'`

- [ ] **Step 3: Write src/discovery.ts**

```typescript
import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import type { FileEntry } from './types.js';

const EXCLUDED = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'code-analysis']);
const MAX_BYTES = 500 * 1024;

export function discoverFiles(projectRoot: string): FileEntry[] {
  const results: FileEntry[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!EXCLUDED.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        const full = join(dir, entry.name);
        const size_bytes = statSync(full).size;
        const path = relative(projectRoot, full).replace(/\\/g, '/');
        results.push(
          size_bytes > MAX_BYTES
            ? { path, size_bytes, skipped: true, skip_reason: 'size_exceeded' }
            : { path, size_bytes, skipped: false, skip_reason: null }
        );
      }
    }
  }

  walk(projectRoot);
  return results;
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `npx vitest run tests/unit/discovery.test.ts`

Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/discovery.ts tests/unit/discovery.test.ts
git commit -m "feat: recursive file discovery with exclusions and 500KB size filter"
```

---

### Task 6: Batcher

**Files:**
- Create: `src/batcher.ts`
- Create: `tests/unit/batcher.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/batcher.test.ts
import { describe, it, expect } from 'vitest';
import { createBatches } from '../../src/batcher.js';
import type { FileEntry } from '../../src/types.js';

function file(path: string, size: number): FileEntry {
  return { path, size_bytes: size, skipped: false, skip_reason: null };
}

describe('createBatches', () => {
  it('groups files until byte limit is reached', () => {
    const batches = createBatches([file('a.ts', 20000), file('b.ts', 20000), file('c.ts', 20000)], 'index', 55000);
    expect(batches).toHaveLength(2);
    expect(batches[0].files).toEqual(['a.ts', 'b.ts']);
    expect(batches[1].files).toEqual(['c.ts']);
  });

  it('puts a file exceeding the limit in its own batch', () => {
    const batches = createBatches([file('a.ts', 20000), file('big.ts', 60000), file('b.ts', 20000)], 'index', 55000);
    expect(batches).toHaveLength(3);
    expect(batches[1].files).toEqual(['big.ts']);
  });

  it('skips files with skipped=true', () => {
    const skipped: FileEntry = { path: 'skip.ts', size_bytes: 600000, skipped: true, skip_reason: 'size_exceeded' };
    const batches = createBatches([file('a.ts', 1000), skipped], 'index', 55000);
    expect(batches).toHaveLength(1);
    expect(batches[0].files).toEqual(['a.ts']);
  });

  it('zero-pads batch IDs to 3 digits', () => {
    const files = Array.from({ length: 2 }, (_, i) => file(`f${i}.ts`, 30000));
    const batches = createBatches(files, 'index', 55000);
    expect(batches[0].id).toBe('batch-001');
    expect(batches[1].id).toBe('batch-002');
  });

  it('sets output_file to code-analysis/<phase>/<id>.json', () => {
    const batches = createBatches([file('a.ts', 1000)], 'index', 55000);
    expect(batches[0].output_file).toBe('code-analysis/index/batch-001.json');
  });

  it('returns empty array for empty input', () => {
    expect(createBatches([], 'index', 55000)).toHaveLength(0);
  });

  it('records correct size_bytes per batch', () => {
    const batches = createBatches([file('a.ts', 10000), file('b.ts', 20000)], 'index', 55000);
    expect(batches[0].size_bytes).toBe(30000);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `npx vitest run tests/unit/batcher.test.ts`

Expected: FAIL — `Cannot find module '../../src/batcher.js'`

- [ ] **Step 3: Write src/batcher.ts**

```typescript
import type { FileEntry, BatchEntry } from './types.js';

export function createBatches(
  files: FileEntry[],
  phase: string,
  maxBatchBytes: number = 55000
): BatchEntry[] {
  const eligible = files.filter(f => !f.skipped);
  const batches: BatchEntry[] = [];
  let current: string[] = [];
  let currentSize = 0;
  let num = 1;

  function flush() {
    if (current.length === 0) return;
    const id = `batch-${String(num).padStart(3, '0')}`;
    batches.push({
      id,
      files: current,
      size_bytes: currentSize,
      status: 'pending',
      attempts: 0,
      completed_at: null,
      output_file: `code-analysis/${phase}/${id}.json`,
    });
    num++;
    current = [];
    currentSize = 0;
  }

  for (const f of eligible) {
    if (f.size_bytes > maxBatchBytes) {
      flush();
      const id = `batch-${String(num).padStart(3, '0')}`;
      batches.push({
        id,
        files: [f.path],
        size_bytes: f.size_bytes,
        status: 'pending',
        attempts: 0,
        completed_at: null,
        output_file: `code-analysis/${phase}/${id}.json`,
      });
      num++;
    } else if (currentSize + f.size_bytes > maxBatchBytes) {
      flush();
      current = [f.path];
      currentSize = f.size_bytes;
    } else {
      current.push(f.path);
      currentSize += f.size_bytes;
    }
  }
  flush();
  return batches;
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `npx vitest run tests/unit/batcher.test.ts`

Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/batcher.ts tests/unit/batcher.test.ts
git commit -m "feat: byte-bounded batcher with oversized-file isolation"
```

---

### Task 7: Retry Helper

**Files:**
- Create: `src/retry.ts`

- [ ] **Step 1: Write src/retry.ts**

```typescript
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  onAttemptError: (attempt: number, err: unknown) => void
): Promise<{ value: T; attempts: number } | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return { value: await fn(), attempts: attempt };
    } catch (err) {
      onAttemptError(attempt, err);
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }
  return null;
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/retry.ts
git commit -m "feat: exponential backoff retry helper for LM Studio phases"
```

---

### Task 8: LM Studio Client

**Files:**
- Create: `src/lm-studio.ts`
- Create: `tests/unit/lm-studio.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/lm-studio.test.ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { callLMStudio } from '../../src/lm-studio.js';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('callLMStudio', () => {
  it('returns content string from choices[0].message.content', async () => {
    server.use(
      http.post('http://localhost:1234/v1/chat/completions', () =>
        HttpResponse.json({ choices: [{ message: { content: '{"ok":true}' } }] })
      )
    );
    const result = await callLMStudio('qwen/qwen3.5-9b', 'prompt', 'http://localhost:1234/v1/chat/completions');
    expect(result).toBe('{"ok":true}');
  });

  it('throws with status code on non-200 response', async () => {
    server.use(
      http.post('http://localhost:1234/v1/chat/completions', () =>
        new HttpResponse('Service Unavailable', { status: 503 })
      )
    );
    await expect(
      callLMStudio('qwen/qwen3.5-9b', 'prompt', 'http://localhost:1234/v1/chat/completions')
    ).rejects.toThrow('503');
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `npx vitest run tests/unit/lm-studio.test.ts`

Expected: FAIL — `Cannot find module '../../src/lm-studio.js'`

- [ ] **Step 3: Write src/lm-studio.ts**

```typescript
interface LMStudioResponse {
  choices: Array<{ message: { content: string } }>;
}

export async function callLMStudio(
  model: string,
  prompt: string,
  url: string = 'http://localhost:1234/v1/chat/completions'
): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`LM Studio returned ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as LMStudioResponse;
  return data.choices[0].message.content;
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `npx vitest run tests/unit/lm-studio.test.ts`

Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lm-studio.ts tests/unit/lm-studio.test.ts
git commit -m "feat: LM Studio OpenAI-compatible REST client"
```

---

### Task 9: Claude CLI Wrapper

**Files:**
- Create: `src/claude-cli.ts`

- [ ] **Step 1: Write src/claude-cli.ts**

```typescript
import { spawnSync } from 'child_process';

export function callClaudeCLI(prompt: string): string {
  const result = spawnSync('claude', ['-p', prompt], {
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`claude CLI exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout;
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/claude-cli.ts
git commit -m "feat: subprocess wrapper for claude CLI Phase 3"
```

---

### Task 10: Prompt Templates

**Files:**
- Create: `src/prompts/templates.ts`

- [ ] **Step 1: Write src/prompts/templates.ts**

```typescript
export function indexPrompt(fileContents: Array<{ path: string; content: string }>): string {
  const block = fileContents.map(f => `=== ${f.path} ===\n${f.content}`).join('\n\n');
  return `Analyze each source file below. Return a JSON array where each element has this exact schema:
{
  "module": "relative/path",
  "responsibilities": ["string"],
  "ui_patterns": ["string"],
  "data_flow": ["string"],
  "dependencies": ["relative/path"],
  "duplicated_logic_candidates": [{"description": "string", "similar_to": ["path"]}],
  "inconsistencies": [{"type": "UI|architecture|naming", "issue": "string"}]
}
Return ONLY a JSON array. No explanation.

${block}`;
}

export function analyzePrompt(indexItems: unknown[]): string {
  return `You are a code architect. Analyze these file summaries and identify cross-cutting patterns.
Return a single JSON object with this exact schema:
{
  "duplication_clusters": [{"description": "string", "files": ["path"]}],
  "ui_inconsistencies": [{"description": "string", "files": ["path"]}],
  "architecture_inconsistencies": [{"description": "string", "files": ["path"]}],
  "candidate_shared_components": [{"name": "string", "rationale": "string", "files": ["path"]}],
  "candidate_utility_functions": [{"name": "string", "rationale": "string", "files": ["path"]}]
}
Return ONLY JSON. No explanation.

${JSON.stringify(indexItems, null, 2)}`;
}

export function aggregatePrompt(analysisItems: unknown[]): string {
  return `You are a senior engineer. Based on these analysis reports, produce two documents.
Format your response exactly as:

=== standards.md ===
[opinionated codebase standards document]

=== refactor-strategy.md ===
[high-level refactor strategy]

Input:
${JSON.stringify(analysisItems, null, 2)}`;
}

export function refactorPrompt(standardsMd: string, modules: unknown[]): string {
  return `You are a senior engineer. Using the standards below and module information, create a refactor plan.
Return a JSON array where each element has:
{
  "file": "relative/path",
  "change": "exact description of what to change",
  "before": "pattern before refactor",
  "after": "pattern after refactor",
  "dependencies_impacted": ["path"],
  "tests_to_validate": ["description"]
}
Return ONLY a JSON array.

Standards:
${standardsMd}

Modules:
${JSON.stringify(modules, null, 2)}`;
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/prompts/templates.ts
git commit -m "feat: prompt templates for all four analysis phases"
```

---

### Task 11: Test Fixtures

**Files:**
- Create: `tests/fixtures/sample-project/src/utils/helper.ts`
- Create: `tests/fixtures/sample-project/src/components/Button.ts`
- Create: `tests/fixtures/sample-project/src/api/user.ts`

- [ ] **Step 1: Write fixture files**

`tests/fixtures/sample-project/src/utils/helper.ts`:
```typescript
export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}
```

`tests/fixtures/sample-project/src/components/Button.ts`:
```typescript
export interface ButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export function renderButton(props: ButtonProps): string {
  return `<button ${props.disabled ? 'disabled' : ''} onclick="${props.onClick}">${props.label}</button>`;
}
```

`tests/fixtures/sample-project/src/api/user.ts`:
```typescript
export interface User {
  id: string;
  name: string;
  email: string;
}

export async function fetchUser(id: string): Promise<User> {
  const res = await fetch(`/api/users/${id}`);
  return res.json() as Promise<User>;
}

export async function updateUser(id: string, data: Partial<User>): Promise<User> {
  const res = await fetch(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
  return res.json() as Promise<User>;
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/fixtures/
git commit -m "test: fixture project for integration tests"
```

---

### Task 12: Phase 1 — Indexing + Integration Test

**Files:**
- Create: `src/phases/index.ts`
- Create: `tests/integration/phase1.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
// tests/integration/phase1.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverFiles } from '../../src/discovery.js';
import { createManifest, writeManifest, readManifest } from '../../src/manifest.js';
import { createBatches } from '../../src/batcher.js';
import { runIndexPhase } from '../../src/phases/index.js';
import { createLogger } from '../../src/logger.js';

const MOCK_INDEX_ITEM = {
  module: 'src/utils/helper.ts',
  responsibilities: ['format date', 'truncate string'],
  ui_patterns: [],
  data_flow: [],
  dependencies: [],
  duplicated_logic_candidates: [],
  inconsistencies: [],
};

const server = setupServer();
let testRoot: string;

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function setupProject() {
  testRoot = join(tmpdir(), `phase1-test-${Date.now()}`);
  mkdirSync(join(testRoot, 'src', 'utils'), { recursive: true });
  writeFileSync(join(testRoot, 'src', 'utils', 'helper.ts'), 'export const x = 1;');

  const files = discoverFiles(testRoot);
  const manifest = createManifest(testRoot, files);
  manifest.batches.index = createBatches(files, 'index');
  writeManifest(testRoot, manifest);

  server.use(
    http.post('http://localhost:1234/v1/chat/completions', () =>
      HttpResponse.json({ choices: [{ message: { content: JSON.stringify([MOCK_INDEX_ITEM]) } }] })
    )
  );

  return { files, manifest };
}

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('runIndexPhase', () => {
  it('writes batch output file and marks batch completed', async () => {
    setupProject();
    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));

    await runIndexPhase(testRoot, 'qwen/qwen3.5-9b', logger);

    const manifest = readManifest(testRoot);
    expect(manifest.phases.index).toBe('completed');
    expect(manifest.batches.index[0].status).toBe('completed');
    expect(existsSync(join(testRoot, 'code-analysis', 'index', 'batch-001.json'))).toBe(true);
  });

  it('skips already-completed batches on re-run', async () => {
    setupProject();

    let callCount = 0;
    server.use(
      http.post('http://localhost:1234/v1/chat/completions', () => {
        callCount++;
        return HttpResponse.json({ choices: [{ message: { content: JSON.stringify([MOCK_INDEX_ITEM]) } }] });
      })
    );

    const manifest = readManifest(testRoot);
    manifest.batches.index[0].status = 'completed';
    manifest.batches.index[0].completed_at = new Date().toISOString();
    mkdirSync(join(testRoot, 'code-analysis', 'index'), { recursive: true });
    writeFileSync(join(testRoot, 'code-analysis', 'index', 'batch-001.json'), JSON.stringify([MOCK_INDEX_ITEM]));
    writeManifest(testRoot, manifest);

    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
    await runIndexPhase(testRoot, 'qwen/qwen3.5-9b', logger);

    expect(callCount).toBe(0);
  });

  it('marks phase failed when all batches fail', async () => {
    setupProject();
    server.use(
      http.post('http://localhost:1234/v1/chat/completions', () =>
        new HttpResponse('error', { status: 500 })
      )
    );

    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
    await runIndexPhase(testRoot, 'qwen/qwen3.5-9b', logger);

    expect(readManifest(testRoot).phases.index).toBe('failed');
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `npx vitest run tests/integration/phase1.test.ts`

Expected: FAIL — `Cannot find module '../../src/phases/index.js'`

- [ ] **Step 3: Write src/phases/index.ts**

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { readManifest, updateBatchStatus, updatePhaseStatus } from '../manifest.js';
import { callLMStudio } from '../lm-studio.js';
import { withRetry } from '../retry.js';
import { indexPrompt } from '../prompts/templates.js';
import type { Logger } from '../logger.js';
import type { IndexOutput } from '../types.js';

const MAX_ATTEMPTS = 3;

export async function runIndexPhase(
  projectRoot: string,
  model: string,
  logger: Logger,
  lmUrl?: string
): Promise<void> {
  logger.info('Phase 1 started', { model });
  updatePhaseStatus(projectRoot, 'index', 'pending');

  const manifest = readManifest(projectRoot);
  let failedCount = 0;

  for (const batch of manifest.batches.index) {
    if (batch.status === 'completed') continue;

    const fileContents = batch.files.map(path => ({
      path,
      content: readFileSync(join(projectRoot, path), 'utf8'),
    }));

    const result = await withRetry(
      async () => {
        const raw = await callLMStudio(model, indexPrompt(fileContents), lmUrl);
        const parsed = JSON.parse(raw) as IndexOutput[];
        mkdirSync(join(projectRoot, 'code-analysis', 'index'), { recursive: true });
        writeFileSync(join(projectRoot, batch.output_file), JSON.stringify(parsed, null, 2), 'utf8');
        return parsed;
      },
      MAX_ATTEMPTS,
      (attempt, err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`${batch.id} failed (attempt ${attempt}/${MAX_ATTEMPTS})`, { error: msg });
      }
    );

    if (result) {
      updateBatchStatus(projectRoot, 'index', batch.id, 'completed', result.attempts);
      logger.info(`${batch.id} completed`, { files: batch.files.length, size_bytes: batch.size_bytes });
    } else {
      updateBatchStatus(projectRoot, 'index', batch.id, 'failed', MAX_ATTEMPTS);
      failedCount++;
    }
  }

  const finalStatus = failedCount > 0 ? 'failed' : 'completed';
  updatePhaseStatus(projectRoot, 'index', finalStatus);
  logger.info('Phase 1 completed', { batches: manifest.batches.index.length, failed: failedCount });
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `npx vitest run tests/integration/phase1.test.ts`

Expected: PASS — 3 tests.

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`

Expected: PASS — all tests.

- [ ] **Step 6: Commit**

```bash
git add src/phases/index.ts tests/integration/phase1.test.ts
git commit -m "feat: Phase 1 indexing with retry, atomic batch state, MSW integration test"
```

---

### Task 13: Phase 2 — Analysis

**Files:**
- Create: `src/phases/analyze.ts`

- [ ] **Step 1: Write src/phases/analyze.ts**

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { readManifest, writeManifest, updateBatchStatus, updatePhaseStatus } from '../manifest.js';
import { callLMStudio } from '../lm-studio.js';
import { withRetry } from '../retry.js';
import { analyzePrompt } from '../prompts/templates.js';
import type { Logger } from '../logger.js';
import type { AnalysisOutput, BatchEntry, IndexOutput } from '../types.js';

const MAX_ATTEMPTS = 3;
const MAX_GROUP_BYTES = 80000;

function buildAnalyzeBatches(projectRoot: string): BatchEntry[] {
  const manifest = readManifest(projectRoot);
  const allItems: IndexOutput[] = [];

  for (const batch of manifest.batches.index) {
    if (batch.status === 'completed') {
      const items = JSON.parse(readFileSync(join(projectRoot, batch.output_file), 'utf8')) as IndexOutput[];
      allItems.push(...items);
    }
  }

  const groups: IndexOutput[][] = [];
  let current: IndexOutput[] = [];
  let currentSize = 0;

  for (const item of allItems) {
    const size = JSON.stringify(item).length;
    if (currentSize + size > MAX_GROUP_BYTES && current.length > 0) {
      groups.push(current);
      current = [item];
      currentSize = size;
    } else {
      current.push(item);
      currentSize += size;
    }
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group, i) => {
    const id = `group-${String(i + 1).padStart(3, '0')}`;
    return {
      id,
      files: [],
      size_bytes: JSON.stringify(group).length,
      status: 'pending' as const,
      attempts: 0,
      completed_at: null,
      output_file: `code-analysis/analyzer/${id}.json`,
    };
  });
}

export async function runAnalyzePhase(
  projectRoot: string,
  model: string,
  logger: Logger,
  lmUrl?: string
): Promise<void> {
  logger.info('Phase 2 started', { model });

  let manifest = readManifest(projectRoot);
  if (manifest.batches.analyze.length === 0) {
    manifest.batches.analyze = buildAnalyzeBatches(projectRoot);
    writeManifest(projectRoot, manifest);
  }

  manifest = readManifest(projectRoot);
  let failedCount = 0;

  // Re-derive group contents from index outputs each time (crash-safe)
  const allItems: IndexOutput[] = [];
  for (const batch of manifest.batches.index) {
    if (batch.status === 'completed') {
      allItems.push(...JSON.parse(readFileSync(join(projectRoot, batch.output_file), 'utf8')) as IndexOutput[]);
    }
  }

  const groups: IndexOutput[][] = [];
  let current: IndexOutput[] = [];
  let currentSize = 0;
  for (const item of allItems) {
    const size = JSON.stringify(item).length;
    if (currentSize + size > MAX_GROUP_BYTES && current.length > 0) {
      groups.push(current);
      current = [item];
      currentSize = size;
    } else {
      current.push(item);
      currentSize += size;
    }
  }
  if (current.length > 0) groups.push(current);

  for (let i = 0; i < manifest.batches.analyze.length; i++) {
    const batch = manifest.batches.analyze[i];
    if (batch.status === 'completed') continue;

    const groupItems = groups[i] ?? [];

    const result = await withRetry(
      async () => {
        const raw = await callLMStudio(model, analyzePrompt(groupItems), lmUrl);
        const parsed = JSON.parse(raw) as AnalysisOutput;
        mkdirSync(join(projectRoot, 'code-analysis', 'analyzer'), { recursive: true });
        writeFileSync(join(projectRoot, batch.output_file), JSON.stringify(parsed, null, 2), 'utf8');
        return parsed;
      },
      MAX_ATTEMPTS,
      (attempt, err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`${batch.id} failed (attempt ${attempt}/${MAX_ATTEMPTS})`, { error: msg });
      }
    );

    if (result) {
      updateBatchStatus(projectRoot, 'analyze', batch.id, 'completed', result.attempts);
      logger.info(`${batch.id} completed`, { size_bytes: batch.size_bytes });
    } else {
      updateBatchStatus(projectRoot, 'analyze', batch.id, 'failed', MAX_ATTEMPTS);
      failedCount++;
    }
  }

  updatePhaseStatus(projectRoot, 'analyze', failedCount > 0 ? 'failed' : 'completed');
  logger.info('Phase 2 completed', { groups: manifest.batches.analyze.length, failed: failedCount });
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/phases/analyze.ts
git commit -m "feat: Phase 2 analysis — groups index outputs into ≤80KB batches for LM Studio"
```

---

### Task 14: Phase 3 — Aggregation

**Files:**
- Create: `src/phases/aggregate.ts`

- [ ] **Step 1: Write src/phases/aggregate.ts**

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { readManifest, updatePhaseStatus } from '../manifest.js';
import { callClaudeCLI } from '../claude-cli.js';
import { aggregatePrompt } from '../prompts/templates.js';
import type { Logger } from '../logger.js';
import type { AnalysisOutput } from '../types.js';

const MAX_CHUNK_BYTES = 100000;

export async function runAggregatePhase(projectRoot: string, logger: Logger): Promise<void> {
  logger.info('Phase 3 started', { model: 'claude-cli' });

  const manifest = readManifest(projectRoot);
  const allOutputs: AnalysisOutput[] = [];

  for (const batch of manifest.batches.analyze) {
    if (batch.status === 'completed') {
      allOutputs.push(JSON.parse(readFileSync(join(projectRoot, batch.output_file), 'utf8')) as AnalysisOutput);
    }
  }

  // Split into ≤100KB chunks
  const chunks: AnalysisOutput[][] = [];
  let current: AnalysisOutput[] = [];
  let currentSize = 0;
  for (const item of allOutputs) {
    const size = JSON.stringify(item).length;
    if (currentSize + size > MAX_CHUNK_BYTES && current.length > 0) {
      chunks.push(current);
      current = [item];
      currentSize = size;
    } else {
      current.push(item);
      currentSize += size;
    }
  }
  if (current.length > 0) chunks.push(current);

  try {
    let combined = '';
    for (const chunk of chunks) {
      combined += callClaudeCLI(aggregatePrompt(chunk)) + '\n';
    }

    const stdMatch = combined.match(/=== standards\.md ===\n([\s\S]*?)(?==== |\s*$)/);
    const refMatch = combined.match(/=== refactor-strategy\.md ===\n([\s\S]*?)(?==== |\s*$)/);

    mkdirSync(join(projectRoot, 'code-analysis', 'aggregate'), { recursive: true });
    writeFileSync(join(projectRoot, 'code-analysis', 'aggregate', 'standards.md'), stdMatch?.[1]?.trim() ?? '', 'utf8');
    writeFileSync(join(projectRoot, 'code-analysis', 'aggregate', 'refactor-strategy.md'), refMatch?.[1]?.trim() ?? '', 'utf8');

    updatePhaseStatus(projectRoot, 'aggregate', 'completed');
    logger.info('Phase 3 completed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Phase 3 failed', { error: msg });
    updatePhaseStatus(projectRoot, 'aggregate', 'failed');
    throw err;
  }
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/phases/aggregate.ts
git commit -m "feat: Phase 3 aggregation — claude CLI subprocess, ≤100KB chunks, extracts standards.md"
```

---

### Task 15: Phase 4 — Refactor Planning

**Files:**
- Create: `src/phases/refactor.ts`

- [ ] **Step 1: Write src/phases/refactor.ts**

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { readManifest, writeManifest, updateBatchStatus, updatePhaseStatus } from '../manifest.js';
import { callLMStudio } from '../lm-studio.js';
import { withRetry } from '../retry.js';
import { refactorPrompt } from '../prompts/templates.js';
import type { Logger } from '../logger.js';
import type { BatchEntry, IndexOutput, RefactorPlanEntry } from '../types.js';

const MAX_ATTEMPTS = 3;

function buildRefactorBatches(projectRoot: string): { batches: BatchEntry[]; groups: IndexOutput[][] } {
  const manifest = readManifest(projectRoot);
  const dirMap = new Map<string, IndexOutput[]>();

  for (const batch of manifest.batches.index) {
    if (batch.status === 'completed') {
      const items = JSON.parse(readFileSync(join(projectRoot, batch.output_file), 'utf8')) as IndexOutput[];
      for (const item of items) {
        const topDir = item.module.split('/')[0] ?? '.';
        if (!dirMap.has(topDir)) dirMap.set(topDir, []);
        dirMap.get(topDir)!.push(item);
      }
    }
  }

  const batches: BatchEntry[] = [];
  const groups: IndexOutput[][] = [];
  let num = 1;

  for (const [, items] of dirMap) {
    const id = `plan-${String(num).padStart(3, '0')}`;
    batches.push({
      id,
      files: [],
      size_bytes: JSON.stringify(items).length,
      status: 'pending',
      attempts: 0,
      completed_at: null,
      output_file: `code-analysis/refactor/${id}.md`,
    });
    groups.push(items);
    num++;
  }

  return { batches, groups };
}

export async function runRefactorPhase(
  projectRoot: string,
  model: string,
  logger: Logger,
  lmUrl?: string
): Promise<void> {
  logger.info('Phase 4 started', { model });

  let manifest = readManifest(projectRoot);
  let groups: IndexOutput[][];

  if (manifest.batches.refactor.length === 0) {
    const built = buildRefactorBatches(projectRoot);
    manifest.batches.refactor = built.batches;
    groups = built.groups;
    writeManifest(projectRoot, manifest);
  } else {
    groups = buildRefactorBatches(projectRoot).groups;
  }

  manifest = readManifest(projectRoot);
  const standardsMd = readFileSync(join(projectRoot, 'code-analysis', 'aggregate', 'standards.md'), 'utf8');
  let failedCount = 0;

  for (let i = 0; i < manifest.batches.refactor.length; i++) {
    const batch = manifest.batches.refactor[i];
    if (batch.status === 'completed') continue;

    const moduleItems = groups[i] ?? [];

    const result = await withRetry(
      async () => {
        const raw = await callLMStudio(model, refactorPrompt(standardsMd, moduleItems), lmUrl);
        const parsed = JSON.parse(raw) as RefactorPlanEntry[];
        mkdirSync(join(projectRoot, 'code-analysis', 'refactor'), { recursive: true });
        const md = parsed.map(p =>
          `## ${p.file}\n\n**Change:** ${p.change}\n\n**Before:**\n\`\`\`\n${p.before}\n\`\`\`\n\n**After:**\n\`\`\`\n${p.after}\n\`\`\`\n\n**Dependencies:** ${p.dependencies_impacted.join(', ') || 'none'}\n\n**Tests:** ${p.tests_to_validate.join('; ') || 'none'}`
        ).join('\n\n---\n\n');
        writeFileSync(join(projectRoot, batch.output_file), md, 'utf8');
        return parsed;
      },
      MAX_ATTEMPTS,
      (attempt, err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`${batch.id} failed (attempt ${attempt}/${MAX_ATTEMPTS})`, { error: msg });
      }
    );

    if (result) {
      updateBatchStatus(projectRoot, 'refactor', batch.id, 'completed', result.attempts);
      logger.info(`${batch.id} completed`);
    } else {
      updateBatchStatus(projectRoot, 'refactor', batch.id, 'failed', MAX_ATTEMPTS);
      failedCount++;
    }
  }

  updatePhaseStatus(projectRoot, 'refactor', failedCount > 0 ? 'failed' : 'completed');
  logger.info('Phase 4 completed', { plans: manifest.batches.refactor.length, failed: failedCount });
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/phases/refactor.ts
git commit -m "feat: Phase 4 refactor planning — clusters by top-level directory, outputs markdown plans"
```

---

### Task 16: CLI Entry Point

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Write src/index.ts**

```typescript
#!/usr/bin/env node
import minimist from 'minimist';
import { discoverFiles } from './discovery.js';
import { manifestExists, createManifest, readManifest, writeManifest, resetPhase } from './manifest.js';
import { createBatches } from './batcher.js';
import { createLogger } from './logger.js';
import { runIndexPhase } from './phases/index.js';
import { runAnalyzePhase } from './phases/analyze.js';
import { runAggregatePhase } from './phases/aggregate.js';
import { runRefactorPhase } from './phases/refactor.js';
import { join } from 'path';

const args = minimist(process.argv.slice(2), {
  string: ['phase', 'model-override'],
  number: ['max-batch-size'],
  boolean: ['resume'],
});

const projectRoot = process.cwd();
const model: string = (args['model-override'] as string | undefined) ?? 'qwen/qwen3.5-9b';
const maxBatchSize: number = (args['max-batch-size'] as number | undefined) ?? 55000;
const phase: string | undefined = args['phase'] as string | undefined;
const resume: boolean = args['resume'] as boolean ?? false;

const logger = createLogger(join(projectRoot, 'code-analysis', 'logs', 'run.log'));

async function main() {
  const hasManifest = manifestExists(projectRoot);

  if (!hasManifest) {
    // Fresh run: discover and create manifest
    const files = discoverFiles(projectRoot);
    const manifest = createManifest(projectRoot, files);
    manifest.batches.index = createBatches(files, 'index', maxBatchSize);
    writeManifest(projectRoot, manifest);
    logger.info('Discovery complete', { files: files.length });
  } else if (phase && !resume) {
    // Explicit phase re-run: reset that phase
    resetPhase(projectRoot, phase as 'index' | 'analyze' | 'aggregate' | 'refactor');
    logger.info(`Phase ${phase} reset`);
  }

  const manifest = readManifest(projectRoot);

  if (!phase || phase === 'index') {
    if (manifest.phases.index !== 'completed') {
      await runIndexPhase(projectRoot, model, logger);
    }
    if (readManifest(projectRoot).phases.index === 'failed') {
      logger.error('Phase 1 failed — halting');
      process.exit(1);
    }
  }

  if (!phase || phase === 'analyze') {
    const m = readManifest(projectRoot);
    if (m.phases.analyze !== 'completed') {
      await runAnalyzePhase(projectRoot, model, logger);
    }
    if (readManifest(projectRoot).phases.analyze === 'failed') {
      logger.error('Phase 2 failed — halting');
      process.exit(1);
    }
  }

  if (!phase || phase === 'aggregate') {
    const m = readManifest(projectRoot);
    if (m.phases.aggregate !== 'completed') {
      await runAggregatePhase(projectRoot, logger);
    }
    if (readManifest(projectRoot).phases.aggregate === 'failed') {
      logger.error('Phase 3 failed — halting');
      process.exit(1);
    }
  }

  if (!phase || phase === 'refactor') {
    const m = readManifest(projectRoot);
    if (m.phases.refactor !== 'completed') {
      await runRefactorPhase(projectRoot, model, logger);
    }
  }

  logger.info('Pipeline complete');
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

- [ ] **Step 2: Build**

Run: `npm run build`

Expected: `dist/` directory created with compiled `.js` files, no errors.

- [ ] **Step 3: Verify bin is executable (Unix)**

Run: `chmod +x dist/index.js`

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: CLI entry point — arg parsing, phase orchestration, startup/resume logic"
```

---

### Task 17: Final Build Verification

- [ ] **Step 1: Run full build and test suite**

Run: `npm run build && npx vitest run`

Expected: Compilation succeeds, all tests pass.

- [ ] **Step 2: Verify dist/index.js exists and has shebang**

Run: `head -1 dist/index.js`

Expected: `#!/usr/bin/env node`

If missing, run:

```bash
node -e "
const fs = require('fs');
const f = 'dist/index.js';
const content = fs.readFileSync(f, 'utf8');
if (!content.startsWith('#!/usr/bin/env node')) {
  fs.writeFileSync(f, '#!/usr/bin/env node\n' + content);
}
"
```

Then rebuild: `npm run build`

- [ ] **Step 3: Verify global install works**

Run: `npm install -g .`

Expected: `code-analyzer` binary available in PATH.

Run: `code-analyzer --help 2>&1 || code-analyzer --phase=index 2>&1 | head -5`

Expected: Tool runs without import errors.

Run: `npm uninstall -g code-analyzer`

- [ ] **Step 4: Final commit**

```bash
git add dist/
git commit -m "build: compiled output and verified global install"
```

---

## Self-Review Against Spec

| Spec Requirement | Covered By |
|---|---|
| Globally-installed TypeScript CLI | Task 1 (package.json bin), Task 16 |
| Four-phase pipeline | Tasks 12–15 |
| Resumable / idempotent batches | Task 4 (manifest), Task 12–15 (skip completed) |
| manifest.json state | Task 4 |
| File discovery with exclusions | Task 5 |
| 500KB size limit | Task 5 |
| Byte-bounded batching (50–60KB) | Task 6 |
| LM Studio REST client | Task 8 |
| Claude CLI subprocess | Task 9 |
| Retry up to 3 attempts, exponential backoff | Task 7, applied in Tasks 12–15 |
| Phase 3: no retry, halt on failure | Task 14 (try/catch, no withRetry) |
| Downstream phases halt if upstream fails | Task 16 |
| `--phase`, `--resume`, `--max-batch-size`, `--model-override` | Task 16 |
| Phase 3 always uses claude CLI (ignores --model-override) | Task 14 |
| Logging format with timestamp/level/metadata | Task 3 |
| Output directory structure | Tasks 12–15 |
| Unit tests: batcher, manifest, discovery | Tasks 3–6 |
| Integration test: Phase 1 with MSW | Task 12 |
| Test fixtures | Task 11 |
