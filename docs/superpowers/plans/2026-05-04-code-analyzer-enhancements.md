# Code Analyzer Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add severity/frequency signals, .md file exclusion, two-pass deduplication phase (Phase 2.5), verbatim before/after code in refactor plans, TypeScript signatures on candidates, and structured NO_CHANGES_NEEDED entries.

**Architecture:** Expand types with `Finding`/`Candidate`/`DedupOutput`; insert Phase 2.5 between analyze and aggregate using two-pass LM Studio batching; aggregate reads a single deduplicated JSON file instead of all group files; refactor prompts receive raw file content so the model can quote verbatim source lines.

**Tech Stack:** TypeScript 5, Node.js ESM, Vitest 1, LM Studio API (`callLMStudio`), Claude CLI (`callClaudeCLI`)

---

## File Map

| File | Action | What changes |
|---|---|---|
| `src/discovery.ts` | Modify | Add `.md` to `EXCLUDED_EXTENSIONS` |
| `src/types.ts` | Modify | Add `Finding`, `Candidate`, `DedupFinding`, `DedupOutput`; update `AnalysisOutput`, `RefactorPlanEntry`, `Manifest`, `Phase`, `BatchPhase` |
| `src/manifest.ts` | Modify | Init dedup fields in `createManifest`; backward-compat in `readManifest`; dedup in `resetPhase` |
| `src/prompts/templates.ts` | Modify | Update `analyzePrompt`, `aggregatePrompt`, `refactorPrompt`; add `deduplicatePromptPassA`, `deduplicatePromptPassB` |
| `src/phases/dedup.ts` | Create | Two-pass batched dedup (Pass A: partial per batch group, Pass B: merge to `findings.json`) |
| `src/phases/aggregate.ts` | Modify | Read `dedup/findings.json`; remove chunking loop; gate on `dedup === 'completed'` |
| `src/phases/refactor.ts` | Modify | Load file content in `buildRefactorGroups`; pass content map to `refactorPrompt`; update `toMarkdown` for verdict entries; export `toMarkdown` |
| `src/index.ts` | Modify | Import `runDedupPhase`; add dedup block between analyze and aggregate |
| `tests/unit/discovery.test.ts` | Create | `.md` exclusion test |
| `tests/unit/manifest.test.ts` | Modify | Tests for dedup fields and backward compat |
| `tests/unit/prompts.test.ts` | Create | Prompt content tests |
| `tests/unit/refactor.test.ts` | Create | `toMarkdown` verdict rendering tests |

---

### Task 1: Exclude .md files from discovery

**Files:**
- Modify: `src/discovery.ts:30-38`
- Test: `tests/unit/discovery.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/unit/discovery.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
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

describe('discoverFiles — .md exclusion', () => {
  it('excludes .md files', () => {
    writeFileSync(join(testRoot, 'README.md'), '# docs');
    writeFileSync(join(testRoot, 'index.ts'), 'export {}');
    const files = discoverFiles(testRoot);
    expect(files.map(f => f.path)).not.toContain('README.md');
    expect(files.map(f => f.path)).toContain('index.ts');
  });

  it('excludes nested .md files', () => {
    mkdirSync(join(testRoot, 'src'), { recursive: true });
    writeFileSync(join(testRoot, 'src', 'NOTES.md'), '# notes');
    writeFileSync(join(testRoot, 'src', 'util.ts'), 'export {}');
    const files = discoverFiles(testRoot);
    expect(files.map(f => f.path)).not.toContain('src/NOTES.md');
    expect(files.map(f => f.path)).toContain('src/util.ts');
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```
cd C:\Users\cflur\projects\code-analyzer
npx vitest run tests/unit/discovery.test.ts
```

Expected: FAIL — `README.md` appears in the discovered file list.

- [ ] **Step 3: Add `.md` to `EXCLUDED_EXTENSIONS` in `src/discovery.ts`**

Change lines 30-38 from:
```typescript
const EXCLUDED_EXTENSIONS = new Set([
  '.lock', '.snap', '.map', '.min.js', '.min.css',
```
to:
```typescript
const EXCLUDED_EXTENSIONS = new Set([
  '.md',
  '.lock', '.snap', '.map', '.min.js', '.min.css',
```

- [ ] **Step 4: Run test to confirm it passes**

```
npx vitest run tests/unit/discovery.test.ts
```

Expected: 2 PASS

- [ ] **Step 5: Commit**

```bash
git add src/discovery.ts tests/unit/discovery.test.ts
git commit -m "feat: exclude .md files from discovery"
```

---

### Task 2: Expand type system

**Files:**
- Modify: `src/types.ts`

No new test file — type-only changes. TypeScript compilation in Step 2 validates correctness. Downstream test failures in later tasks would surface type errors.

- [ ] **Step 1: Replace `src/types.ts` with the full updated file**

```typescript
export type PhaseStatus = 'pending' | 'completed' | 'failed';
export type Phase = 'index' | 'analyze' | 'dedup' | 'aggregate' | 'refactor';
export type BatchPhase = 'index' | 'analyze' | 'dedup' | 'refactor';

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

export interface Finding {
  description: string;
  files: string[];
  severity: 'high' | 'medium' | 'low';
  severity_rationale: string;
  occurrence_count: number;
}

export interface Candidate {
  name: string;
  rationale: string;
  files: string[];
  proposed_signature: string;
}

export interface DedupFinding extends Finding {
  convergence_count: number;
}

export interface DedupOutput {
  duplication_clusters: DedupFinding[];
  ui_inconsistencies: DedupFinding[];
  architecture_inconsistencies: DedupFinding[];
  candidate_shared_components: Candidate[];
  candidate_utility_functions: Candidate[];
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
    dedup: BatchEntry[];
    refactor: BatchEntry[];
  };
  phases: {
    index: PhaseStatus;
    analyze: PhaseStatus;
    dedup: PhaseStatus;
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
  duplication_clusters: Finding[];
  ui_inconsistencies: Finding[];
  architecture_inconsistencies: Finding[];
  candidate_shared_components: Candidate[];
  candidate_utility_functions: Candidate[];
}

export interface RefactorPlanEntry {
  file: string;
  // Full plan entry fields
  change?: string;
  before?: string;
  before_lines?: string;
  after?: string;
  dependencies_impacted?: string[];
  tests_to_validate?: string[];
  // No-violations entry fields (mutually exclusive with change/before/after)
  verdict?: 'no_violations';
  checks_performed?: string[];
  confidence?: 'high' | 'medium' | 'low';
  note?: string;
}
```

- [ ] **Step 2: Check compilation — expect known errors only**

```
npx tsc --noEmit 2>&1 | head -40
```

Expected errors (all will be fixed in later tasks):
- `src/manifest.ts` — missing `dedup` in `batches`/`phases` literals
- `src/phases/refactor.ts` — `p.change`, `p.before`, `p.after` now optional; `modules: unknown[]` mismatch
- `src/prompts/templates.ts` — `aggregatePrompt` takes `unknown[]` but now needs `DedupOutput`

No errors in `src/types.ts` itself.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: expand types with Finding, Candidate, DedupOutput, dedup manifest fields"
```

---

### Task 3: Manifest — dedup support and backward compatibility

**Files:**
- Modify: `src/manifest.ts`
- Modify: `tests/unit/manifest.test.ts`

- [ ] **Step 1: Write failing tests — add these describe blocks to `tests/unit/manifest.test.ts` before the last line**

```typescript
describe('createManifest — dedup fields', () => {
  it('initializes phases.dedup as pending', () => {
    const m = createManifest(testRoot, []);
    expect(m.phases.dedup).toBe('pending');
  });

  it('initializes batches.dedup as empty array', () => {
    const m = createManifest(testRoot, []);
    expect(m.batches.dedup).toEqual([]);
  });
});

describe('readManifest — backward compatibility', () => {
  it('populates missing phases.dedup with pending when field absent', () => {
    const m = createManifest(testRoot, []);
    // Write raw JSON without dedup fields to simulate old manifest
    const { mkdirSync: mkdir, writeFileSync: write } = await import('fs');
    const { join: j } = await import('path');
    mkdir(j(testRoot, 'code-analysis'), { recursive: true });
    const raw = JSON.parse(JSON.stringify(m));
    delete raw.phases.dedup;
    delete raw.batches.dedup;
    write(j(testRoot, 'code-analysis', 'manifest.json'), JSON.stringify(raw, null, 2), 'utf8');

    const read = readManifest(testRoot);
    expect(read.phases.dedup).toBe('pending');
    expect(read.batches.dedup).toEqual([]);
  });
});

describe('resetPhase — dedup', () => {
  it('resets dedup phase status and batches to pending', () => {
    const m = createManifest(testRoot, []);
    m.phases.dedup = 'completed';
    m.batches.dedup = [{
      id: 'partial-001', files: [], size_bytes: 0,
      status: 'completed', attempts: 1,
      completed_at: '2026-01-01T00:00:00Z',
      output_file: 'code-analysis/dedup/partial-001.json',
    }];
    writeManifest(testRoot, m);

    resetPhase(testRoot, 'dedup');

    const updated = readManifest(testRoot);
    expect(updated.phases.dedup).toBe('pending');
    expect(updated.batches.dedup[0].status).toBe('pending');
    expect(updated.batches.dedup[0].attempts).toBe(0);
    expect(updated.batches.dedup[0].completed_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm failures**

```
npx vitest run tests/unit/manifest.test.ts
```

Expected: 3+ FAILs — `phases.dedup` is undefined, `batches.dedup` is undefined, backward-compat not yet implemented.

- [ ] **Step 3: Replace `src/manifest.ts` with the full updated file**

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
    batches: { index: [], analyze: [], dedup: [], refactor: [] },
    phases: { index: 'pending', analyze: 'pending', dedup: 'pending', aggregate: 'pending', refactor: 'pending' },
  };
}

export function readManifest(projectRoot: string): Manifest {
  const raw = JSON.parse(readFileSync(manifestPath(projectRoot), 'utf8')) as Manifest;
  // backward compat: initialize dedup fields absent from pre-enhancement manifests
  raw.phases.dedup ??= 'pending';
  raw.batches.dedup ??= [];
  return raw;
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

- [ ] **Step 4: Run all manifest tests**

```
npx vitest run tests/unit/manifest.test.ts
```

Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/manifest.ts tests/unit/manifest.test.ts
git commit -m "feat: add dedup fields to manifest with backward-compat readManifest"
```

---

### Task 4: Update prompts

**Files:**
- Modify: `src/prompts/templates.ts`
- Test: `tests/unit/prompts.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/prompts.test.ts
import { describe, it, expect } from 'vitest';
import {
  analyzePrompt,
  deduplicatePromptPassA,
  deduplicatePromptPassB,
  aggregatePrompt,
  refactorPrompt,
} from '../../src/prompts/templates.js';
import type { DedupOutput } from '../../src/types.js';

const emptyDedup: DedupOutput = {
  duplication_clusters: [],
  ui_inconsistencies: [],
  architecture_inconsistencies: [],
  candidate_shared_components: [],
  candidate_utility_functions: [],
};

describe('analyzePrompt', () => {
  it('requires severity field in schema', () => {
    expect(analyzePrompt([])).toContain('"severity"');
  });
  it('requires severity_rationale field', () => {
    expect(analyzePrompt([])).toContain('"severity_rationale"');
  });
  it('requires occurrence_count field', () => {
    expect(analyzePrompt([])).toContain('"occurrence_count"');
  });
  it('requires proposed_signature for candidates', () => {
    expect(analyzePrompt([])).toContain('"proposed_signature"');
  });
});

describe('deduplicatePromptPassA', () => {
  it('mentions convergence_count', () => {
    expect(deduplicatePromptPassA([])).toContain('convergence_count');
  });
  it('instructs to merge on shared root cause', () => {
    expect(deduplicatePromptPassA([])).toContain('root cause');
  });
  it('serializes input into the prompt body', () => {
    const groups = [{
      duplication_clusters: [{ description: 'dup-test', files: ['a.ts'], severity: 'high' as const, severity_rationale: 'r', occurrence_count: 1 }],
      ui_inconsistencies: [], architecture_inconsistencies: [],
      candidate_shared_components: [], candidate_utility_functions: [],
    }];
    expect(deduplicatePromptPassA(groups)).toContain('"dup-test"');
  });
});

describe('deduplicatePromptPassB', () => {
  it('mentions convergence_count', () => {
    expect(deduplicatePromptPassB([])).toContain('convergence_count');
  });
  it('instructs to merge on shared root cause', () => {
    expect(deduplicatePromptPassB([])).toContain('root cause');
  });
});

describe('aggregatePrompt', () => {
  it('mentions convergence_count ordering', () => {
    expect(aggregatePrompt(emptyDedup)).toContain('convergence_count');
  });
  it('mentions confirmed cross-cutting', () => {
    expect(aggregatePrompt(emptyDedup)).toContain('confirmed cross-cutting');
  });
});

describe('refactorPrompt', () => {
  it('includes File Contents section header', () => {
    expect(refactorPrompt('# standards', [], new Map())).toContain('File Contents:');
  });
  it('injects file content with === path === format', () => {
    const contents = new Map([['src/foo.ts', 'export const x = 1;']]);
    const prompt = refactorPrompt('# standards', [], contents);
    expect(prompt).toContain('=== src/foo.ts ===');
    expect(prompt).toContain('export const x = 1;');
  });
  it('instructs to use before_lines field', () => {
    expect(refactorPrompt('# standards', [], new Map())).toContain('before_lines');
  });
  it('instructs to return structured no_violations entry', () => {
    expect(refactorPrompt('# standards', [], new Map())).toContain('no_violations');
  });
});
```

- [ ] **Step 2: Run to confirm failures**

```
npx vitest run tests/unit/prompts.test.ts
```

Expected: many FAILs — functions not exported or missing content.

- [ ] **Step 3: Replace `src/prompts/templates.ts`**

```typescript
import type { AnalysisOutput, DedupOutput, IndexOutput } from '../types.js';

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
  "duplication_clusters": [{"description": "string", "files": ["path"], "severity": "high|medium|low", "severity_rationale": "string", "occurrence_count": N}],
  "ui_inconsistencies": [{"description": "string", "files": ["path"], "severity": "high|medium|low", "severity_rationale": "string", "occurrence_count": N}],
  "architecture_inconsistencies": [{"description": "string", "files": ["path"], "severity": "high|medium|low", "severity_rationale": "string", "occurrence_count": N}],
  "candidate_shared_components": [{"name": "string", "rationale": "string", "files": ["path"], "proposed_signature": "string"}],
  "candidate_utility_functions": [{"name": "string", "rationale": "string", "files": ["path"], "proposed_signature": "string"}]
}

Severity guide:
  high   = affects multiple features or is a correctness/data risk
  medium = inconsistent UX or meaningful maintainability debt
  low    = style or naming only

For proposed_signature: quote actual type names you see in the summaries.
Write "NEEDS_VERIFICATION" if the signature cannot be determined from the summaries.
Return ONLY JSON. No explanation.

${JSON.stringify(indexItems, null, 2)}`;
}

const DEDUP_SCHEMA = `{
  "duplication_clusters": [{"description": "string", "files": ["path"], "severity": "high|medium|low", "severity_rationale": "string", "occurrence_count": N, "convergence_count": N}],
  "ui_inconsistencies": [same fields as duplication_clusters],
  "architecture_inconsistencies": [same fields as duplication_clusters],
  "candidate_shared_components": [{"name": "string", "rationale": "string", "files": ["path"], "proposed_signature": "string"}],
  "candidate_utility_functions": [same fields as candidate_shared_components]
}`;

export function deduplicatePromptPassA(groups: AnalysisOutput[]): string {
  return `You are a code architect. Deduplicate these analysis findings from one batch of groups.
Merge findings that share the same root cause (≥2 shared files OR same description intent).
- Combine file lists, take the higher severity, set convergence_count to the number of groups that flagged it.
- Keep single-group findings with convergence_count: 1.
- Do NOT invent new findings.
- Sort each category: severity desc, then convergence_count desc.
Return a single JSON object matching this schema:
${DEDUP_SCHEMA}
Return ONLY JSON. No explanation.

${JSON.stringify(groups, null, 2)}`;
}

export function deduplicatePromptPassB(partials: DedupOutput[]): string {
  return `You are a code architect. Merge these partially-deduplicated analysis reports into one final report.
Apply the same dedup rules: merge on shared root cause, combine file lists, take higher severity,
sum convergence_counts. Sort: severity desc, convergence_count desc.
Return a single JSON object matching this schema:
${DEDUP_SCHEMA}
Return ONLY JSON. No explanation.

${JSON.stringify(partials, null, 2)}`;
}

export function aggregatePrompt(deduped: DedupOutput): string {
  return `You are a senior engineer. Based on these deduplicated analysis findings, produce two documents.
Format your response exactly as:

=== standards.md ===
[opinionated codebase standards document]

=== refactor-strategy.md ===
[high-level refactor strategy]

The input is a single deduplicated findings object. Each finding has:
- convergence_count: how many independent analysis passes flagged it (higher = more certain)
- severity: high | medium | low

When producing refactor-strategy.md:
- Order phases by severity desc, then convergence_count desc within each severity tier.
- Call out findings with convergence_count > 1 as "confirmed cross-cutting" issues.

Input:
${JSON.stringify(deduped, null, 2)}`;
}

export function refactorPrompt(
  standardsMd: string,
  modules: IndexOutput[],
  fileContents: Map<string, string>
): string {
  const fileBlock = [...fileContents.entries()]
    .map(([path, content]) => `=== ${path} ===\n${content}`)
    .join('\n\n');

  return `You are a senior engineer. Using the standards, module summaries, and file contents below, create a refactor plan.
Return a JSON array where each element is one of:

Full plan entry:
{
  "file": "relative/path",
  "change": "exact description of what to change",
  "before": "verbatim lines from the source file",
  "before_lines": "47-52",
  "after": "updated code",
  "dependencies_impacted": ["path"],
  "tests_to_validate": ["description"]
}

No-violations entry:
{
  "file": "path",
  "verdict": "no_violations",
  "checks_performed": ["list of standards checked"],
  "confidence": "high" | "medium" | "low",
  "note": "one sentence explaining why no changes are needed"
}

Rules:
- For "before" and "after": quote verbatim lines from File Contents below. Do NOT paraphrase or invent code.
- Set "before_lines" to the 1-indexed line range you are quoting (e.g. "47-52").
- If you cannot locate the exact lines, set before_lines to "NEEDS_VERIFICATION".
- For files with no standards violations, use the no-violations entry format.
Return ONLY a JSON array.

Standards:
${standardsMd}

Module Summaries:
${JSON.stringify(modules, null, 2)}

File Contents:
${fileBlock}`;
}
```

- [ ] **Step 4: Run prompt tests**

```
npx vitest run tests/unit/prompts.test.ts
```

Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/prompts/templates.ts tests/unit/prompts.test.ts
git commit -m "feat: update prompts with severity/signatures; add deduplicatePrompt; structured no_violations"
```

---

### Task 5: Phase 2.5 — dedup phase (new file)

**Files:**
- Create: `src/phases/dedup.ts`

No direct unit tests — the phase makes live LM Studio calls. TypeScript compilation validates structure. Integration is verified when running the full pipeline.

- [ ] **Step 1: Create `src/phases/dedup.ts`**

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { readManifest, writeManifest, updateBatchStatus, updatePhaseStatus } from '../manifest.js';
import { callLMStudio } from '../lm-studio.js';
import { withRetry } from '../retry.js';
import { deduplicatePromptPassA, deduplicatePromptPassB } from '../prompts/templates.js';
import type { Logger } from '../logger.js';
import type { AnalysisOutput, BatchEntry, DedupOutput } from '../types.js';

const MAX_ATTEMPTS = 3;
const MAX_GROUP_BYTES = 80000;

function buildDedupBatches(projectRoot: string): { batches: BatchEntry[]; passAGroups: AnalysisOutput[][] } {
  const manifest = readManifest(projectRoot);
  const allGroups: AnalysisOutput[] = [];

  for (const batch of manifest.batches.analyze) {
    if (batch.status === 'completed') {
      allGroups.push(JSON.parse(readFileSync(join(projectRoot, batch.output_file), 'utf8')) as AnalysisOutput);
    }
  }

  const passAGroups: AnalysisOutput[][] = [];
  let current: AnalysisOutput[] = [];
  let currentSize = 0;

  for (const group of allGroups) {
    const size = JSON.stringify(group).length;
    if (currentSize + size > MAX_GROUP_BYTES && current.length > 0) {
      passAGroups.push(current);
      current = [group];
      currentSize = size;
    } else {
      current.push(group);
      currentSize += size;
    }
  }
  if (current.length > 0) passAGroups.push(current);

  const batches: BatchEntry[] = passAGroups.map((group, i) => ({
    id: `partial-${String(i + 1).padStart(3, '0')}`,
    files: [],
    size_bytes: JSON.stringify(group).length,
    status: 'pending' as const,
    attempts: 0,
    completed_at: null,
    output_file: `code-analysis/dedup/partial-${String(i + 1).padStart(3, '0')}.json`,
  }));

  return { batches, passAGroups };
}

export async function runDedupPhase(
  projectRoot: string,
  model: string,
  logger: Logger,
  lmUrl?: string,
  timeoutMs?: number,
  numCtx?: number
): Promise<void> {
  if (readManifest(projectRoot).phases.dedup === 'completed') {
    logger.info('Phase 2.5 already complete — skipping');
    return;
  }

  logger.info('Phase 2.5 — Dedup', { model });

  // Pass A: batch dedup
  let m = readManifest(projectRoot);
  if (m.batches.dedup.length === 0) {
    const { batches } = buildDedupBatches(projectRoot);
    m.batches.dedup = batches;
    writeManifest(projectRoot, m);
  }

  m = readManifest(projectRoot);
  const { passAGroups } = buildDedupBatches(projectRoot);
  const total = m.batches.dedup.length;
  const pending = m.batches.dedup.filter(b => b.status !== 'completed').length;
  logger.info('Phase 2.5 Pass A', { batches: total, pending });

  let passAFailed = 0;
  let doneCount = total - pending;

  for (let i = 0; i < m.batches.dedup.length; i++) {
    const batch = m.batches.dedup[i];
    if (batch.status === 'completed') continue;

    const groupItems = passAGroups[i] ?? [];

    const result = await withRetry(
      async () => {
        const raw = await callLMStudio(model, deduplicatePromptPassA(groupItems), lmUrl, timeoutMs, numCtx);
        const parsed = JSON.parse(raw) as DedupOutput;
        mkdirSync(join(projectRoot, 'code-analysis', 'dedup'), { recursive: true });
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
      doneCount++;
      updateBatchStatus(projectRoot, 'dedup', batch.id, 'completed', result.attempts);
      logger.info(`${batch.id} done (${doneCount}/${total})`);
    } else {
      updateBatchStatus(projectRoot, 'dedup', batch.id, 'failed', MAX_ATTEMPTS);
      passAFailed++;
    }
  }

  if (passAFailed > 0) {
    logger.error('Phase 2.5 Pass A had failures — cannot proceed to Pass B', { failed: passAFailed });
    updatePhaseStatus(projectRoot, 'dedup', 'failed');
    return;
  }

  // Pass B: merge all partials into findings.json
  logger.info('Phase 2.5 Pass B — merging partials');
  const afterPassA = readManifest(projectRoot);
  const partials: DedupOutput[] = afterPassA.batches.dedup.map(b =>
    JSON.parse(readFileSync(join(projectRoot, b.output_file), 'utf8')) as DedupOutput
  );

  try {
    const raw = await callLMStudio(model, deduplicatePromptPassB(partials), lmUrl, timeoutMs, numCtx);
    const findings = JSON.parse(raw) as DedupOutput;
    mkdirSync(join(projectRoot, 'code-analysis', 'dedup'), { recursive: true });
    writeFileSync(join(projectRoot, 'code-analysis', 'dedup', 'findings.json'), JSON.stringify(findings, null, 2), 'utf8');
    updatePhaseStatus(projectRoot, 'dedup', 'completed');
    logger.info('Phase 2.5 completed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Phase 2.5 Pass B failed', { error: msg });
    updatePhaseStatus(projectRoot, 'dedup', 'failed');
    throw err;
  }
}
```

- [ ] **Step 2: Verify TypeScript compilation**

```
npx tsc --noEmit 2>&1 | head -40
```

Expected: no errors in `src/phases/dedup.ts`. Remaining errors only in `src/phases/aggregate.ts`, `src/phases/refactor.ts`, and `src/index.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/phases/dedup.ts
git commit -m "feat: add Phase 2.5 two-pass dedup (Pass A: batch partials, Pass B: merge to findings.json)"
```

---

### Task 6: Update aggregate phase

**Files:**
- Modify: `src/phases/aggregate.ts`

- [ ] **Step 1: Replace `src/phases/aggregate.ts`**

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { readManifest, updatePhaseStatus } from '../manifest.js';
import { callClaudeCLI } from '../claude-cli.js';
import { aggregatePrompt } from '../prompts/templates.js';
import type { Logger } from '../logger.js';
import type { DedupOutput } from '../types.js';

export async function runAggregatePhase(projectRoot: string, logger: Logger): Promise<void> {
  const manifest = readManifest(projectRoot);

  if (manifest.phases.dedup !== 'completed') {
    throw new Error('Phase 2.5 (dedup) must complete before Phase 3 (aggregate)');
  }

  logger.info('Phase 3 started', { model: 'claude-cli' });

  const deduped: DedupOutput = JSON.parse(
    readFileSync(join(projectRoot, 'code-analysis', 'dedup', 'findings.json'), 'utf8')
  );

  try {
    const combined = callClaudeCLI(aggregatePrompt(deduped));

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

```
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors in `src/phases/aggregate.ts`. Remaining errors only in `src/phases/refactor.ts` and `src/index.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/phases/aggregate.ts
git commit -m "feat: aggregate reads dedup/findings.json, gates on dedup=completed, removes chunking loop"
```

---

### Task 7: Update refactor phase

**Files:**
- Modify: `src/phases/refactor.ts`
- Test: `tests/unit/refactor.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/refactor.test.ts
import { describe, it, expect } from 'vitest';
import { toMarkdown } from '../../src/phases/refactor.js';
import type { RefactorPlanEntry } from '../../src/types.js';

describe('toMarkdown — full plan entry', () => {
  it('renders file header, change, before, after, dependencies, tests', () => {
    const entry: RefactorPlanEntry = {
      file: 'src/foo.ts',
      change: 'Extract helper',
      before: 'const x = 1 + 1;',
      before_lines: '10-10',
      after: 'const x = add(1, 1);',
      dependencies_impacted: ['src/bar.ts'],
      tests_to_validate: ['addition works'],
    };
    const md = toMarkdown([entry]);
    expect(md).toContain('## src/foo.ts');
    expect(md).toContain('Extract helper');
    expect(md).toContain('lines 10-10');
    expect(md).toContain('const x = 1 + 1;');
    expect(md).toContain('src/bar.ts');
    expect(md).toContain('addition works');
  });

  it('omits before_lines annotation when field is absent', () => {
    const entry: RefactorPlanEntry = {
      file: 'src/foo.ts',
      change: 'Fix',
      before: 'old',
      after: 'new',
      dependencies_impacted: [],
      tests_to_validate: [],
    };
    const md = toMarkdown([entry]);
    expect(md).not.toContain('lines');
  });
});

describe('toMarkdown — no_violations entry', () => {
  it('renders compact line with checkmark', () => {
    const entry: RefactorPlanEntry = {
      file: 'src/config.ts',
      verdict: 'no_violations',
      checks_performed: ['duplication', 'naming'],
      confidence: 'high',
      note: 'config-only file',
    };
    const md = toMarkdown([entry]);
    expect(md).toContain('## src/config.ts');
    expect(md).toContain('✓ No violations');
    expect(md).toContain('config-only file');
    expect(md).toContain('confidence: high');
    expect(md).toContain('duplication, naming');
  });

  it('does not contain Change/Before/After headers', () => {
    const entry: RefactorPlanEntry = {
      file: 'src/config.ts',
      verdict: 'no_violations',
      checks_performed: [],
      confidence: 'high',
      note: 'ok',
    };
    expect(toMarkdown([entry])).not.toContain('**Change:**');
    expect(toMarkdown([entry])).not.toContain('**Before');
    expect(toMarkdown([entry])).not.toContain('**After:**');
  });
});

describe('toMarkdown — multiple entries', () => {
  it('separates entries with ---', () => {
    const entries: RefactorPlanEntry[] = [
      { file: 'a.ts', verdict: 'no_violations', checks_performed: [], confidence: 'high', note: 'ok' },
      { file: 'b.ts', verdict: 'no_violations', checks_performed: [], confidence: 'low', note: 'ok' },
    ];
    expect(toMarkdown(entries)).toContain('---');
  });
});
```

- [ ] **Step 2: Run to confirm failures**

```
npx vitest run tests/unit/refactor.test.ts
```

Expected: FAILs — `toMarkdown` is not a named export, and doesn't handle `verdict` entries.

- [ ] **Step 3: Replace `src/phases/refactor.ts`**

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { readManifest, writeManifest, updateBatchStatus, updatePhaseStatus } from '../manifest.js';
import { callLMStudio } from '../lm-studio.js';
import { withRetry } from '../retry.js';
import { refactorPrompt } from '../prompts/templates.js';
import type { Logger } from '../logger.js';
import type { BatchEntry, IndexOutput, RefactorPlanEntry } from '../types.js';

const MAX_ATTEMPTS = 3;
const MAX_FILE_BYTES = 100 * 1024;

const VALID_ESCAPES = new Set(['"', "'", '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

function sanitizeRaw(raw: string): string {
  let s = raw.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();

  let result = '';
  let inString = false;
  let delim = '"';
  let i = 0;

  while (i < s.length) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') {
        const next = s[i + 1];
        if (next !== undefined && VALID_ESCAPES.has(next)) {
          if (next === 'u') {
            result += s.slice(i, i + 6);
            i += 6;
          } else {
            result += next === "'" ? "'" : ch + next;
            i += 2;
          }
        } else {
          result += '\\\\' + (next ?? '');
          i += 2;
        }
      } else if (ch === delim) {
        inString = false;
        result += '"';
        i++;
      } else if (ch === '"' && delim === "'") {
        result += '\\"';
        i++;
      } else if (ch.charCodeAt(0) < 0x20) {
        result += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
        i++;
      } else {
        result += ch;
        i++;
      }
    } else {
      if (ch === '"' || ch === "'") {
        inString = true;
        delim = ch;
        result += '"';
      } else {
        result += ch;
      }
      i++;
    }
  }
  return result;
}

function buildRefactorGroups(projectRoot: string): {
  batches: BatchEntry[];
  groups: IndexOutput[][];
  fileContentMaps: Map<string, string>[];
} {
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
  const fileContentMaps: Map<string, string>[] = [];
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

    const contentMap = new Map<string, string>();
    for (const item of items) {
      try {
        const content = readFileSync(join(projectRoot, item.module), 'utf8');
        if (Buffer.byteLength(content, 'utf8') <= MAX_FILE_BYTES) {
          contentMap.set(item.module, content);
        }
      } catch {
        // file missing or unreadable — skip
      }
    }
    fileContentMaps.push(contentMap);
    num++;
  }

  return { batches, groups, fileContentMaps };
}

export function toMarkdown(entries: RefactorPlanEntry[]): string {
  return entries.map(p => {
    if (p.verdict === 'no_violations') {
      const checks = (p.checks_performed ?? []).join(', ');
      return `## ${p.file}\n\n✓ No violations — ${p.note ?? ''} (confidence: ${p.confidence ?? 'unknown'} | checks: ${checks})`;
    }
    const beforeLines = p.before_lines ? ` (lines ${p.before_lines})` : '';
    return `## ${p.file}\n\n**Change:** ${p.change ?? ''}\n\n**Before**${beforeLines}:\n\`\`\`\n${p.before ?? ''}\n\`\`\`\n\n**After:**\n\`\`\`\n${p.after ?? ''}\n\`\`\`\n\n**Dependencies:** ${(p.dependencies_impacted ?? []).join(', ') || 'none'}\n\n**Tests:** ${(p.tests_to_validate ?? []).join('; ') || 'none'}`;
  }).join('\n\n---\n\n');
}

export async function runRefactorPhase(
  projectRoot: string,
  model: string,
  logger: Logger,
  lmUrl?: string,
  timeoutMs?: number,
  numCtx?: number
): Promise<void> {
  let manifest = readManifest(projectRoot);

  if (manifest.batches.refactor.length === 0) {
    const { batches } = buildRefactorGroups(projectRoot);
    manifest.batches.refactor = batches;
    writeManifest(projectRoot, manifest);
  }

  manifest = readManifest(projectRoot);
  const { groups, fileContentMaps } = buildRefactorGroups(projectRoot);
  const total = manifest.batches.refactor.length;
  const pending = manifest.batches.refactor.filter(b => b.status !== 'completed').length;
  logger.info('Phase 4 — Refactor Planning', { model, plans: total, pending });
  const standardsMd = readFileSync(join(projectRoot, 'code-analysis', 'aggregate', 'standards.md'), 'utf8');
  let failedCount = 0;
  let doneCount = total - pending;

  for (let i = 0; i < manifest.batches.refactor.length; i++) {
    const batch = manifest.batches.refactor[i];
    if (batch.status === 'completed') continue;

    const moduleItems = groups[i] ?? [];
    const contentMap = fileContentMaps[i] ?? new Map<string, string>();

    const result = await withRetry(
      async () => {
        const raw = await callLMStudio(model, refactorPrompt(standardsMd, moduleItems, contentMap), lmUrl, timeoutMs, numCtx);
        logger.debug(`${batch.id} raw`, { preview: raw.slice(0, 300) });
        const parsed = JSON.parse(sanitizeRaw(raw)) as RefactorPlanEntry[];
        if (parsed.length === 0) {
          parsed.push({
            file: moduleItems.map(m => m.module).join(', ') || batch.id,
            verdict: 'no_violations',
            checks_performed: [],
            confidence: 'low',
            note: 'model returned no violations',
          });
        }
        mkdirSync(join(projectRoot, 'code-analysis', 'refactor'), { recursive: true });
        writeFileSync(join(projectRoot, batch.output_file), toMarkdown(parsed), 'utf8');
        return parsed;
      },
      MAX_ATTEMPTS,
      (attempt, err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`${batch.id} failed (attempt ${attempt}/${MAX_ATTEMPTS})`, { error: msg });
      }
    );

    if (result) {
      doneCount++;
      updateBatchStatus(projectRoot, 'refactor', batch.id, 'completed', result.attempts);
      logger.info(`${batch.id} done (${doneCount}/${total})`);
    } else {
      updateBatchStatus(projectRoot, 'refactor', batch.id, 'failed', MAX_ATTEMPTS);
      failedCount++;
    }
  }

  const finalStatus = failedCount > 0 ? 'failed' : 'completed';
  updatePhaseStatus(projectRoot, 'refactor', finalStatus);
  logger.info(`Phase 4 ${finalStatus}`, { plans: total, failed: failedCount });
}
```

- [ ] **Step 4: Run refactor tests**

```
npx vitest run tests/unit/refactor.test.ts
```

Expected: all PASS

- [ ] **Step 5: Verify TypeScript — only index.ts should have errors**

```
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 6: Commit**

```bash
git add src/phases/refactor.ts tests/unit/refactor.test.ts
git commit -m "feat: inject file content into refactor prompt; verdict-based toMarkdown rendering"
```

---

### Task 8: Wire Phase 2.5 in index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Replace `src/index.ts`**

```typescript
#!/usr/bin/env node
import minimist from 'minimist';
import { discoverFiles } from './discovery.js';
import { manifestExists, createManifest, readManifest, writeManifest, resetPhase } from './manifest.js';
import { createBatches } from './batcher.js';
import { createLogger } from './logger.js';
import { runIndexPhase } from './phases/index.js';
import { runAnalyzePhase } from './phases/analyze.js';
import { runDedupPhase } from './phases/dedup.js';
import { runAggregatePhase } from './phases/aggregate.js';
import { runRefactorPhase } from './phases/refactor.js';
import { join } from 'path';

const args = minimist(process.argv.slice(2), {
  string: ['phase', 'model-override'],
  boolean: ['resume'],
});

const projectRoot = process.cwd();
const model: string = (args['model-override'] as string | undefined) ?? 'qwen/qwen3.5-9b';
const maxBatchSize: number = args['max-batch-size'] !== undefined ? Number(args['max-batch-size']) : 8000;
const phase: string | undefined = args['phase'] as string | undefined;
const resume: boolean = (args['resume'] as boolean | undefined) ?? false;
const timeoutMs: number = args['timeout'] !== undefined ? Number(args['timeout']) * 1000 : 10 * 60 * 1000;
const numCtx: number = args['num-ctx'] !== undefined ? Number(args['num-ctx']) : 64000;

const logger = createLogger(join(projectRoot, 'code-analysis', 'logs', 'run.log'));

async function main() {
  const hasManifest = manifestExists(projectRoot);

  if (!hasManifest) {
    const files = discoverFiles(projectRoot);
    const manifest = createManifest(projectRoot, files);
    manifest.batches.index = createBatches(files, 'index', maxBatchSize);
    writeManifest(projectRoot, manifest);
    logger.info('Discovery complete', { files: files.length });
  } else if (phase && !resume) {
    resetPhase(projectRoot, phase as 'index' | 'analyze' | 'dedup' | 'aggregate' | 'refactor');
    logger.info(`Phase ${phase} reset`);
  }

  if (!phase || phase === 'index') {
    const m = readManifest(projectRoot);
    if (m.phases.index !== 'completed') {
      await runIndexPhase(projectRoot, model, logger, undefined, timeoutMs, numCtx);
    }
    if (readManifest(projectRoot).phases.index === 'failed') {
      logger.error('Phase 1 failed — halting');
      process.exit(1);
    }
  }

  if (!phase || phase === 'analyze') {
    const m = readManifest(projectRoot);
    if (m.phases.analyze !== 'completed') {
      await runAnalyzePhase(projectRoot, model, logger, undefined, timeoutMs, numCtx);
    }
    if (readManifest(projectRoot).phases.analyze === 'failed') {
      logger.error('Phase 2 failed — halting');
      process.exit(1);
    }
  }

  if (!phase || phase === 'dedup') {
    const m = readManifest(projectRoot);
    if (m.phases.dedup !== 'completed') {
      await runDedupPhase(projectRoot, model, logger, undefined, timeoutMs, numCtx);
    }
    if (readManifest(projectRoot).phases.dedup === 'failed') {
      logger.error('Phase 2.5 failed — halting');
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
      await runRefactorPhase(projectRoot, model, logger, undefined, timeoutMs, numCtx);
    }
  }

  logger.info('Pipeline complete');
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

- [ ] **Step 2: Verify full TypeScript compilation — 0 errors**

```
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Run full test suite**

```
npx vitest run
```

Expected: all tests PASS (discovery, manifest, batcher, prompts, refactor).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire Phase 2.5 dedup between analyze and aggregate"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Task |
|---|---|
| .md files excluded at discovery layer | Task 1 |
| `Finding` with severity/severity_rationale/occurrence_count | Task 2 |
| `Candidate` with proposed_signature | Task 2 |
| `DedupFinding` / `DedupOutput` types | Task 2 |
| `RefactorPlanEntry` with before_lines, verdict, checks_performed, confidence, note | Task 2 |
| Manifest dedup fields + backward compat | Task 3 |
| `analyzePrompt` includes severity/occurrence_count/proposed_signature schema | Task 4 |
| `deduplicatePromptPassA` / `PassB` | Task 4 |
| `aggregatePrompt` uses DedupOutput, orders by severity+convergence_count | Task 4 |
| `refactorPrompt` injects File Contents block, before_lines, structured no_violations | Task 4 |
| Phase 2.5 Pass A: batch analysis groups → partial files | Task 5 |
| Phase 2.5 Pass B: merge partials → findings.json | Task 5 |
| Phase 2.5 skips if already completed | Task 5 |
| `batches.dedup` tracks Pass A partial batch entries | Task 5 |
| Aggregate reads dedup/findings.json, gates on dedup=completed, no chunking | Task 6 |
| Refactor loads raw file content, passes to prompt | Task 7 |
| `toMarkdown` renders verdict entries as compact line | Task 7 |
| Phase 2.5 wired between analyze and aggregate in pipeline | Task 8 |

All spec requirements covered.

### Placeholder scan

No TBD, TODO, or "similar to Task N" references. Every code block is complete.

### Type consistency

- `Finding` defined in Task 2, used in `AnalysisOutput` (Task 2), `deduplicatePromptPassA` parameter (Task 4), `buildDedupBatches` loaded type (Task 5). ✓
- `DedupOutput` defined in Task 2, returned by `deduplicatePromptPassA`/`PassB` (Task 4), written by dedup phase (Task 5), read by aggregate phase (Task 6). ✓
- `DedupFinding extends Finding` — `convergence_count` field present in `DEDUP_SCHEMA` prompt string (Task 4). ✓
- `RefactorPlanEntry` optional fields match `toMarkdown` null-coalescing usage (`p.change ?? ''`, `p.before ?? ''`, etc.). ✓
- `refactorPrompt(standardsMd, modules: IndexOutput[], fileContents: Map<string, string>)` — caller in Task 7 passes `moduleItems: IndexOutput[]` and `contentMap: Map<string, string>`. ✓
- `aggregatePrompt(deduped: DedupOutput)` — caller in Task 6 passes parsed `DedupOutput`. ✓
