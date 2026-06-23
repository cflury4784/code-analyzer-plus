# code-analyzer+ GitNexus Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fork `code-analyzer` into `code-analyzer+` and wire GitNexus's KuzuDB knowledge graph into three pipeline phases — index (structural field injection), analyze (community-based batching), and refactor (impact-ordered prompts) — while preserving all existing behavior as a fallback.

**Architecture:** A new `src/gitnexus.ts` adapter reads `.gitnexus/` via the `kuzu` npm package (read-only). All public functions return `T | null` and never throw; callers use `null` as a signal to take the existing code path. `gitNexusCtx` is threaded through all phase runners as an optional parameter. When it is `null`, every phase runs identically to the original `code-analyzer`.

**Tech Stack:** TypeScript 5 (ESM, `"type": "module"`), Vitest 1, `kuzu` (KuzuDB Node.js client), existing `code-analyzer` pipeline (LM Studio, manifest, phases).

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `src/gitnexus.ts` | KuzuDB adapter — types, openGitNexus, getFileStructure, getCommunities, getImpact |
| Create | `tests/unit/gitnexus.test.ts` | Unit tests for all gitnexus.ts exports |
| Modify | `src/index.ts` | Startup detection, `npx gitnexus analyze` spawn, Y/N prompt, thread `gitNexusCtx` |
| Modify | `src/prompts/templates.ts` | `indexPrompt` optional `graphData` param; `refactorPrompt` optional `impactedPaths` param |
| Modify | `src/phases/index.ts` | Accept `gitNexusCtx`, call `getFileStructure`, merge structural fields before write |
| Modify | `src/phases/analyze.ts` | Accept `gitNexusCtx`, community-based `groupIndexOutputs` (becomes async) |
| Modify | `src/phases/refactor.ts` | Accept `gitNexusCtx`, call `getImpact` per batch, inject into prompt |

---

## Task 1: Bootstrap code-analyzer+

**Files:**
- Create: `C:\Users\cflur\projects\code-analyzer+\` (entire project copy)

- [ ] **Step 1: Copy project (exclude node_modules, code-analysis, .git)**

```powershell
robocopy "C:\Users\cflur\projects\code-analyzer" "C:\Users\cflur\projects\code-analyzer+" /E /XD node_modules code-analysis .git /XF "*.log" "nul"
```

Expected: `robocopy` exits with code 1 (files copied, no errors — code 1 means "files copied successfully").

- [ ] **Step 2: Init fresh git repo and commit**

```powershell
cd "C:\Users\cflur\projects\code-analyzer+"
git init
git add .
git commit -m "chore: initial commit — fork of code-analyzer pre-gitnexus"
```

- [ ] **Step 3: Install existing dependencies + kuzu**

```powershell
npm install
npm install kuzu
```

- [ ] **Step 4: Commit the new dependency**

```powershell
git add package.json package-lock.json
git commit -m "chore: add kuzu dependency for KuzuDB access"
```

- [ ] **Step 5: Verify build still passes**

```powershell
npm run build
```

Expected: no TypeScript errors, `dist/` populated.

---

## Task 2: `src/gitnexus.ts` — types, path normalization, openGitNexus

**Files:**
- Create: `src/gitnexus.ts`
- Create: `tests/unit/gitnexus.test.ts`

- [ ] **Step 1: Write failing tests for openGitNexus**

Create `tests/unit/gitnexus.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('kuzu', () => ({
  default: {
    Database: vi.fn(),
    Connection: vi.fn(),
  },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn() };
});

import { existsSync } from 'fs';
import { openGitNexus } from '../../src/gitnexus.js';
import kuzu from 'kuzu';

const mockExistsSync = vi.mocked(existsSync);
const MockDatabase = vi.mocked(kuzu.Database);
const MockConnection = vi.mocked(kuzu.Connection);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('openGitNexus', () => {
  it('returns null when .gitnexus directory does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await openGitNexus('/project');
    expect(result).toBeNull();
  });

  it('returns context when .gitnexus exists and DB opens', async () => {
    mockExistsSync.mockReturnValue(true);
    const fakeDb = {};
    const fakeConn = { query: vi.fn().mockResolvedValue({ getAll: vi.fn().mockReturnValue([]) }) };
    MockDatabase.mockReturnValue(fakeDb as never);
    MockConnection.mockReturnValue(fakeConn as never);

    const result = await openGitNexus('/project');
    expect(result).not.toBeNull();
    expect(result?.projectRoot).toBe('/project');
    expect(result?.db).toBe(fakeDb);
    expect(result?.conn).toBe(fakeConn);
  });

  it('returns null when kuzu.Database throws', async () => {
    mockExistsSync.mockReturnValue(true);
    MockDatabase.mockImplementation(() => { throw new Error('lock error'); });

    const result = await openGitNexus('/project');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — expect failure (module not found)**

```powershell
npx vitest run tests/unit/gitnexus.test.ts
```

Expected: FAIL — `Cannot find module '../../src/gitnexus.js'`

- [ ] **Step 3: Create `src/gitnexus.ts` with types and openGitNexus**

```typescript
import kuzu from 'kuzu';
import { existsSync } from 'fs';
import { join, relative } from 'path';

export interface GitNexusContext {
  db: InstanceType<typeof kuzu.Database>;
  conn: InstanceType<typeof kuzu.Connection>;
  projectRoot: string;
}

export interface FileStructure {
  imports: string[];  // POSIX-relative paths this file imports
  calls: string[];    // POSIX-relative paths of files containing called symbols
}

export interface ImpactResult {
  impactedPaths: string[];  // files that directly import this file (depth 1)
}

export function toPosixRelative(projectRoot: string, filePath: string): string {
  // Case-insensitive startsWith for Windows (paths are case-insensitive on NTFS)
  const rootNorm = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const pathNorm = filePath.replace(/\\/g, '/');
  const rel = pathNorm.toLowerCase().startsWith(rootNorm.toLowerCase())
    ? pathNorm.slice(rootNorm.length).replace(/^\//, '')
    : pathNorm;
  return rel.replace(/^\.\//, '');
}

async function validateSchema(ctx: GitNexusContext): Promise<boolean> {
  try {
    const r = await ctx.conn.query('MATCH (f:File) RETURN f.path LIMIT 1');
    r.getAll();
    return true;
  } catch {
    return false;
  }
}

export function closeGitNexus(ctx: GitNexusContext): void {
  try {
    (ctx.conn as { close?: () => void }).close?.();
    (ctx.db as { close?: () => void }).close?.();
  } catch {}
}

export async function openGitNexus(projectRoot: string): Promise<GitNexusContext | null> {
  try {
    const dbPath = join(projectRoot, '.gitnexus');
    if (!existsSync(dbPath)) return null;
    // readOnly=true (5th arg) prevents write-lock conflicts with the MCP server
    // NOTE: verify constructor signature against installed kuzu version before use:
    //   check node_modules/kuzu/README.md or kuzu.d.ts — signature varies by release
    const db = new kuzu.Database(dbPath, 0, 0, true, true);
    const conn = new kuzu.Connection(db);
    const ctx = { db, conn, projectRoot };
    const valid = await validateSchema(ctx);
    if (!valid) { closeGitNexus(ctx); return null; }
    return ctx;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

```powershell
npx vitest run tests/unit/gitnexus.test.ts
```

Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```powershell
git add src/gitnexus.ts tests/unit/gitnexus.test.ts
git commit -m "feat: gitnexus adapter — types and openGitNexus"
```

---

## Task 3: `getFileStructure` — IMPORTS query

**Files:**
- Modify: `src/gitnexus.ts`
- Modify: `tests/unit/gitnexus.test.ts`

- [ ] **Step 1: Add failing tests for getFileStructure**

Append to `tests/unit/gitnexus.test.ts`:

```typescript
import { getFileStructure } from '../../src/gitnexus.js';
import type { GitNexusContext } from '../../src/gitnexus.js';

describe('getFileStructure', () => {
  it('returns null when query throws', async () => {
    const fakeConn = {
      query: vi.fn().mockRejectedValue(new Error('db error')),
    };
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: fakeConn as never,
      projectRoot: '/project',
    };
    const result = await getFileStructure(ctx, ['src/foo.ts']);
    expect(result).toBeNull();
  });

  it('maps import edges to FileStructure.imports', async () => {
    const fakeQueryResult = {
      getAll: vi.fn().mockReturnValue([
        { src: 'src/foo.ts', dep: 'src/bar.ts' },
        { src: 'src/foo.ts', dep: 'src/baz.ts' },
      ]),
    };
    const fakeConn = {
      query: vi.fn()
        .mockResolvedValueOnce(fakeQueryResult)   // IMPORTS query
        .mockResolvedValueOnce({ getAll: vi.fn().mockReturnValue([]) }), // CALLS query
    };
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: fakeConn as never,
      projectRoot: '/project',
    };
    const result = await getFileStructure(ctx, ['/project/src/foo.ts']);
    expect(result).not.toBeNull();
    expect(result!.get('src/foo.ts')?.imports).toEqual(['src/bar.ts', 'src/baz.ts']);
  });

  it('returns empty structure for paths with no edges', async () => {
    const fakeConn = {
      query: vi.fn().mockResolvedValue({ getAll: vi.fn().mockReturnValue([]) }),
    };
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: fakeConn as never,
      projectRoot: '/project',
    };
    const result = await getFileStructure(ctx, ['src/isolated.ts']);
    expect(result!.get('src/isolated.ts')).toEqual({ imports: [], calls: [] });
  });

  it('normalizes Windows absolute paths to POSIX relative', async () => {
    const fakeConn = {
      query: vi.fn().mockResolvedValue({ getAll: vi.fn().mockReturnValue([]) }),
    };
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: fakeConn as never,
      projectRoot: 'C:/project',
    };
    const result = await getFileStructure(ctx, ['C:\\project\\src\\foo.ts']);
    expect(result!.has('src/foo.ts')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```powershell
npx vitest run tests/unit/gitnexus.test.ts
```

Expected: FAIL — `getFileStructure is not a function`

- [ ] **Step 3: Implement `getFileStructure` in `src/gitnexus.ts`**

Append after `openGitNexus`:

```typescript
export async function getFileStructure(
  ctx: GitNexusContext,
  paths: string[],
): Promise<Map<string, FileStructure> | null> {
  try {
    const normalized = paths.map(p => toPosixRelative(ctx.projectRoot, p));

    // Run both queries in parallel; use parameterized form to avoid Cypher injection
    const [importResult, callResult] = await Promise.all([
      ctx.conn.query(
        `MATCH (f:File)-[:CodeRelation {type: 'IMPORTS'}]->(dep:File)
         WHERE f.path IN $paths
         RETURN f.path AS src, dep.path AS dep`,
        { paths: normalized },
      ),
      ctx.conn.query(
        `MATCH (f:File)-[:CodeRelation {type: 'CALLS'}]->(sym)
         WHERE f.path IN $paths
         RETURN f.path AS src, sym.filePath AS dep`,
        { paths: normalized },
      ),
    ]);

    const importRows = importResult.getAll() as Array<{ src: string; dep: string }>;
    const callRows = callResult.getAll() as Array<{ src: string; dep: string }>;

    const result = new Map<string, FileStructure>();
    for (const p of normalized) result.set(p, { imports: [], calls: [] });

    for (const row of importRows) {
      if (!row.src || !row.dep) continue;
      const s = result.get(row.src);
      if (s && !s.imports.includes(row.dep)) s.imports.push(row.dep);
    }
    for (const row of callRows) {
      if (!row.src || !row.dep) continue;
      const s = result.get(row.src);
      if (s && !s.calls.includes(row.dep)) s.calls.push(row.dep);
    }
    return result;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

```powershell
npx vitest run tests/unit/gitnexus.test.ts
```

Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```powershell
git add src/gitnexus.ts tests/unit/gitnexus.test.ts
git commit -m "feat: getFileStructure — IMPORTS/CALLS queries with path normalization"
```

---

## Task 4: `getCommunities` — MEMBER_OF query

**Files:**
- Modify: `src/gitnexus.ts`
- Modify: `tests/unit/gitnexus.test.ts`

- [ ] **Step 1: Add failing tests for getCommunities**

Append to `tests/unit/gitnexus.test.ts`:

```typescript
import { getCommunities } from '../../src/gitnexus.js';

describe('getCommunities', () => {
  it('returns null when query throws', async () => {
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: { query: vi.fn().mockRejectedValue(new Error('fail')) } as never,
      projectRoot: '/project',
    };
    expect(await getCommunities(ctx)).toBeNull();
  });

  it('groups file paths by community name', async () => {
    const rows = [
      { filePath: 'src/auth/login.ts', community: 'auth' },
      { filePath: 'src/auth/logout.ts', community: 'auth' },
      { filePath: 'src/ui/button.ts', community: 'ui' },
    ];
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: {
        query: vi.fn().mockResolvedValue({ getAll: vi.fn().mockReturnValue(rows) }),
      } as never,
      projectRoot: '/project',
    };
    const result = await getCommunities(ctx);
    expect(result!.get('auth')).toEqual(['src/auth/login.ts', 'src/auth/logout.ts']);
    expect(result!.get('ui')).toEqual(['src/ui/button.ts']);
  });

  it('returns empty map when no community edges', async () => {
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: {
        query: vi.fn().mockResolvedValue({ getAll: vi.fn().mockReturnValue([]) }),
      } as never,
      projectRoot: '/project',
    };
    expect((await getCommunities(ctx))!.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```powershell
npx vitest run tests/unit/gitnexus.test.ts
```

Expected: FAIL — `getCommunities is not a function`

- [ ] **Step 3: Implement `getCommunities` in `src/gitnexus.ts`**

Append after `getFileStructure`:

```typescript
export async function getCommunities(
  ctx: GitNexusContext,
): Promise<Map<string, string[]> | null> {
  try {
    const result = await ctx.conn.query(
      `MATCH (f:File)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
       RETURN f.path AS filePath, c.name AS community`,
    );
    const rows = result.getAll() as Array<{ filePath: string; community: string }>;

    const communities = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.filePath || !row.community) continue;
      if (!communities.has(row.community)) communities.set(row.community, []);
      communities.get(row.community)!.push(row.filePath);
    }
    return communities;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

```powershell
npx vitest run tests/unit/gitnexus.test.ts
```

Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```powershell
git add src/gitnexus.ts tests/unit/gitnexus.test.ts
git commit -m "feat: getCommunities — MEMBER_OF query for cluster-based batching"
```

---

## Task 5: `getImpact` — reverse dependency query

**Files:**
- Modify: `src/gitnexus.ts`
- Modify: `tests/unit/gitnexus.test.ts`

- [ ] **Step 1: Add failing tests for getImpact**

Append to `tests/unit/gitnexus.test.ts`:

```typescript
import { getImpact } from '../../src/gitnexus.js';

describe('getImpact', () => {
  it('returns null when query throws', async () => {
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: { query: vi.fn().mockRejectedValue(new Error('fail')) } as never,
      projectRoot: '/project',
    };
    expect(await getImpact(ctx, 'src/utils.ts')).toBeNull();
  });

  it('returns list of files that import this file', async () => {
    const rows = [
      { depPath: 'src/components/Header.tsx' },
      { depPath: 'src/pages/Home.tsx' },
    ];
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: {
        query: vi.fn().mockResolvedValue({ getAll: vi.fn().mockReturnValue(rows) }),
      } as never,
      projectRoot: '/project',
    };
    const result = await getImpact(ctx, 'src/utils.ts');
    expect(result!.impactedPaths).toEqual(['src/components/Header.tsx', 'src/pages/Home.tsx']);
  });

  it('normalizes filePath before querying', async () => {
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: {
        query: vi.fn().mockResolvedValue({ getAll: vi.fn().mockReturnValue([]) }),
      } as never,
      projectRoot: 'C:/project',
    };
    await getImpact(ctx, 'C:\\project\\src\\utils.ts');
    const cypher = (ctx.conn.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(cypher).toContain("'src/utils.ts'");
  });

  it('returns empty impactedPaths when no dependents', async () => {
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: {
        query: vi.fn().mockResolvedValue({ getAll: vi.fn().mockReturnValue([]) }),
      } as never,
      projectRoot: '/project',
    };
    const result = await getImpact(ctx, 'src/leaf.ts');
    expect(result!.impactedPaths).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```powershell
npx vitest run tests/unit/gitnexus.test.ts
```

Expected: FAIL — `getImpact is not a function`

- [ ] **Step 3: Implement `getImpact` in `src/gitnexus.ts`**

Append after `getCommunities`:

```typescript
export async function getImpact(
  ctx: GitNexusContext,
  filePath: string,
): Promise<ImpactResult | null> {
  try {
    const normalized = toPosixRelative(ctx.projectRoot, filePath);
    // Parameterized query — no string interpolation of file paths
    const result = await ctx.conn.query(
      `MATCH (dep:File)-[:CodeRelation {type: 'IMPORTS'}]->(f:File)
       WHERE f.path = $path
       RETURN DISTINCT dep.path AS depPath`,
      { path: normalized },
    );
    const rows = result.getAll() as Array<{ depPath: string }>;
    const impactedPaths = rows.map(r => r.depPath).filter(Boolean);
    return { impactedPaths };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

```powershell
npx vitest run tests/unit/gitnexus.test.ts
```

Expected: PASS (all tests)

- [ ] **Step 5: Run full unit test suite**

```powershell
npx vitest run tests/unit/
```

Expected: all existing tests still pass

- [ ] **Step 6: Commit**

```powershell
git add src/gitnexus.ts tests/unit/gitnexus.test.ts
git commit -m "feat: getImpact — reverse IMPORTS query for blast-radius data"
```

---

## Task 6: Startup detection in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add gitnexus imports and detection block**

In `src/index.ts`, add these imports near the top (after existing imports):

```typescript
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import * as readline from 'readline';
import { openGitNexus, closeGitNexus } from './gitnexus.js';
import type { GitNexusContext } from './gitnexus.js';
```

- [ ] **Step 2: Add `spawnAsync` utility and `detectGitNexus` helper function**

Add these functions before `main()` in `src/index.ts`:

```typescript
function spawnAsync(cmd: string, args: string[], opts: { cwd: string; shell: boolean }): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { ...opts, stdio: 'inherit' });
    proc.on('close', resolve);
    proc.on('error', reject);
  });
}

async function detectGitNexus(projectRoot: string, logger: ReturnType<typeof createLogger>): Promise<GitNexusContext | null> {
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

  // .gitnexus exists — update the index first (async spawn, does not block event loop)
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

- [ ] **Step 3: Call `detectGitNexus` inside `main()` and thread `gitNexusCtx`**

In `src/index.ts`, inside `async function main()`, add this block immediately after the manifest init block (after the `logger.info('Discovery complete', ...)` section and before the `runUsesModel` preflight check):

```typescript
  // GitNexus enrichment — optional, falls back to existing behaviour if null
  const gitNexusCtx: GitNexusContext | null = await detectGitNexus(projectRoot, logger);
  // Register cleanup so DB file lock is released on normal exit and unhandled rejection
  process.once('exit', () => { if (gitNexusCtx) closeGitNexus(gitNexusCtx); });
  process.once('uncaughtException', (e) => { if (gitNexusCtx) closeGitNexus(gitNexusCtx); throw e; });
```

Then update every phase call to pass `gitNexusCtx` as the last argument. Also update `runAnalyzePhase` to store results from the first `groupIndexOutputs` call and not call it twice (the second call in the original code re-groups unnecessarily):

```typescript
  // Phase 1
  await runIndexPhase(projectRoot, resolvedModel, logger, undefined, timeoutMs, numCtx, runController.signal, gitNexusCtx);

  // Phase 2
  await runAnalyzePhase(projectRoot, resolvedModel, logger, undefined, timeoutMs, numCtx, runController.signal, gitNexusCtx);

  // Phase 2.5 (dedup — no enrichment, pass nothing, signature unchanged)
  await runDedupPhase(projectRoot, resolvedModel, logger, undefined, timeoutMs, numCtx, runController.signal);

  // Phase 3 (aggregate — no enrichment, signature unchanged)
  await runAggregatePhase(projectRoot, resolvedModel, logger, undefined, timeoutMs, numCtx, runController.signal);

  // Phase 4
  await runRefactorPhase(projectRoot, resolvedModel, logger, undefined, timeoutMs, numCtx, runController.signal, gitNexusCtx);
```

- [ ] **Step 4: Typecheck**

```powershell
npx tsc --noEmit
```

Expected: errors only on `runIndexPhase`, `runAnalyzePhase`, `runRefactorPhase` not yet accepting the new parameter — that is correct; the next tasks add those parameters.

- [ ] **Step 5: Commit**

```powershell
git add src/index.ts
git commit -m "feat: startup GitNexus detection — .gitnexus check, analyze refresh, Y/N prompt"
```

---

## Task 7: `indexPrompt` — optional graphData param

**Files:**
- Modify: `src/prompts/templates.ts`

- [ ] **Step 1: Write a failing test for the enriched prompt**

Create `tests/unit/templates-gitnexus.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { indexPrompt } from '../../src/prompts/templates.js';
import type { FileStructure } from '../../src/gitnexus.js';

describe('indexPrompt with graphData', () => {
  it('includes dependencies and data_flow fields when graphData is absent', () => {
    const prompt = indexPrompt([{ path: 'src/foo.ts', content: 'export const x = 1;' }]);
    expect(prompt).toContain('"dependencies"');
    expect(prompt).toContain('"data_flow"');
  });

  it('omits dependencies and data_flow fields when graphData is provided', () => {
    const graphData = new Map<string, FileStructure>([
      ['src/foo.ts', { imports: ['src/bar.ts'], calls: [] }],
    ]);
    const prompt = indexPrompt(
      [{ path: 'src/foo.ts', content: 'export const x = 1;' }],
      graphData,
    );
    expect(prompt).not.toContain('"dependencies"');
    expect(prompt).not.toContain('"data_flow"');
  });

  it('notes that dependencies are injected from graph when graphData provided', () => {
    const graphData = new Map<string, FileStructure>();
    const prompt = indexPrompt(
      [{ path: 'src/foo.ts', content: '' }],
      graphData,
    );
    expect(prompt).toContain('dependencies and data_flow');
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```powershell
npx vitest run tests/unit/templates-gitnexus.test.ts
```

Expected: FAIL — `indexPrompt` does not accept second argument

- [ ] **Step 3: Update `indexPrompt` in `src/prompts/templates.ts`**

Add `FileStructure` import at top:

```typescript
import type { FileStructure } from './gitnexus.js';
```

Replace the `indexPrompt` function:

```typescript
export function indexPrompt(
  fileContents: Array<{ path: string; content: string }>,
  graphData?: Map<string, FileStructure> | null,
): string {
  const block = fileContents.map(f => `=== ${f.path} ===\n${f.content}`).join('\n\n');

  const schema = graphData != null
    ? `{
  "module": "relative/path",
  "responsibilities": ["string"],
  "ui_patterns": ["string"],
  "duplicated_logic_candidates": [{"description": "string", "similar_to": ["path"]}],
  "inconsistencies": [{"type": "UI|architecture|naming", "issue": "string"}]
}`
    : `{
  "module": "relative/path",
  "responsibilities": ["string"],
  "ui_patterns": ["string"],
  "data_flow": ["string"],
  "dependencies": ["relative/path"],
  "duplicated_logic_candidates": [{"description": "string", "similar_to": ["path"]}],
  "inconsistencies": [{"type": "UI|architecture|naming", "issue": "string"}]
}`;

  const graphNote = graphData != null
    ? '\nNote: dependencies and data_flow will be injected from the code graph — omit them from your response.\n'
    : '';

  return `Analyze each source file below. Return a JSON array where each element has this exact schema:
${schema}
Rules: Be concise. Each array: maximum 5 items, one short phrase each. Return ONLY a JSON array. No explanation.${graphNote}

${block}`;
}
```

- [ ] **Step 4: Run tests — expect pass**

```powershell
npx vitest run tests/unit/templates-gitnexus.test.ts
```

Expected: PASS

- [ ] **Step 5: Run full test suite to check no regressions**

```powershell
npx vitest run
```

Expected: all existing tests still pass

- [ ] **Step 6: Commit**

```powershell
git add src/prompts/templates.ts tests/unit/templates-gitnexus.test.ts
git commit -m "feat: indexPrompt optional graphData — omits structural fields when graph data available"
```

---

## Task 8: `runIndexPhase` enrichment — call getFileStructure, merge, write

**Files:**
- Modify: `src/phases/index.ts`

- [ ] **Step 1: Add imports and update signature**

At the top of `src/phases/index.ts`, add:

```typescript
import { getFileStructure } from '../gitnexus.js';
import type { GitNexusContext } from '../gitnexus.js';
```

Update `runIndexPhase` signature (add `gitNexusCtx` as last parameter):

```typescript
export async function runIndexPhase(
  projectRoot: string,
  model: string,
  logger: Logger,
  lmUrl?: string,
  timeoutMs?: number,
  numCtx?: number,
  signal?: AbortSignal,
  gitNexusCtx?: GitNexusContext | null,
): Promise<void> {
```

- [ ] **Step 2: Add graph pre-fetch and merge inside the batch loop**

Inside the `for (const batch of manifest.batches.index)` loop, replace this block:

```typescript
    const prompt = indexPrompt(fileContents);
```

with:

```typescript
    // Pre-fetch structural data from GitNexus if available
    const graphData = gitNexusCtx
      ? await getFileStructure(gitNexusCtx, batch.files)
      : null;

    const prompt = indexPrompt(fileContents, graphData);
```

Then, inside `withRetry`, replace:

```typescript
        const parsed = JSON.parse(extractJsonArray(raw));
        mkdirSync(join(projectRoot, 'code-analysis', 'index'), { recursive: true });
        writeFileSync(join(projectRoot, batch.output_file), JSON.stringify(parsed, null, 2), 'utf8');
        return parsed;
```

with:

```typescript
        const parsed = JSON.parse(extractJsonArray(raw)) as Partial<IndexOutput>[];

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

        mkdirSync(join(projectRoot, 'code-analysis', 'index'), { recursive: true });
        writeFileSync(join(projectRoot, batch.output_file), JSON.stringify(enriched, null, 2), 'utf8');
        return enriched;
```

- [ ] **Step 3: Typecheck**

```powershell
npx tsc --noEmit
```

Expected: only the previously-noted errors on `runAnalyzePhase` and `runRefactorPhase` (not yet updated).

- [ ] **Step 4: Run existing tests**

```powershell
npx vitest run tests/unit/
```

Expected: all pass

- [ ] **Step 5: Commit**

```powershell
git add src/phases/index.ts
git commit -m "feat: runIndexPhase — getFileStructure enrichment with graph merge"
```

---

## Task 9: `runAnalyzePhase` — community-cluster batching

**Files:**
- Modify: `src/phases/analyze.ts`

- [ ] **Step 1: Add imports and make `groupIndexOutputs` async with community support**

Add imports at top of `src/phases/analyze.ts`:

```typescript
import { getCommunities } from '../gitnexus.js';
import type { GitNexusContext } from '../gitnexus.js';
```

Replace the entire `groupIndexOutputs` function with this async version:

```typescript
async function groupIndexOutputs(
  projectRoot: string,
  gitNexusCtx?: GitNexusContext | null,
): Promise<{ batches: BatchEntry[]; groups: IndexOutput[][] }> {
  const manifest = readManifest(projectRoot);
  const allItems: IndexOutput[] = [];

  for (const batch of manifest.batches.index) {
    if (batch.status === 'completed') {
      const raw = JSON.parse(readFileSync(join(projectRoot, batch.output_file), 'utf8'));
      const items = Array.isArray(raw) ? raw as IndexOutput[] : [raw as IndexOutput];
      allItems.push(...items);
    }
  }

  const groups: IndexOutput[][] = [];

  if (gitNexusCtx) {
    // Community-based grouping
    const communities = await getCommunities(gitNexusCtx);
    if (communities && communities.size > 0) {
      // Build reverse map: posix file path → community name
      const fileToComm = new Map<string, string>();
      for (const [comm, files] of communities) {
        for (const f of files) fileToComm.set(f.replace(/\\/g, '/'), comm);
      }

      const commGroups = new Map<string, IndexOutput[]>();
      const overflow: IndexOutput[] = [];

      for (const item of allItems) {
        const posixPath = (item.module ?? '').replace(/\\/g, '/');
        const comm = fileToComm.get(posixPath);
        if (comm) {
          if (!commGroups.has(comm)) commGroups.set(comm, []);
          commGroups.get(comm)!.push(item);
        } else {
          overflow.push(item);
        }
      }

      // Sub-split each community by bytes if it exceeds MAX_GROUP_BYTES
      for (const [, items] of commGroups) {
        let current: IndexOutput[] = [];
        let currentSize = 0;
        for (const item of items) {
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
      }

      // Overflow items: fallback byte grouping
      let current: IndexOutput[] = [];
      let currentSize = 0;
      for (const item of overflow) {
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
    } else {
      // getCommunities returned null or empty — fall through to byte grouping
      return byteGroupIndexOutputs(allItems);
    }
  } else {
    return byteGroupIndexOutputs(allItems);
  }

  const batches: BatchEntry[] = groups.map((group, i) => {
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

  return { batches, groups };
}

function byteGroupIndexOutputs(allItems: IndexOutput[]): { batches: BatchEntry[]; groups: IndexOutput[][] } {
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

  const batches: BatchEntry[] = groups.map((group, i) => {
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

  return { batches, groups };
}
```

- [ ] **Step 2: Update `runAnalyzePhase` signature and await groupIndexOutputs**

Update the function signature:

```typescript
export async function runAnalyzePhase(
  projectRoot: string,
  model: string,
  logger: Logger,
  lmUrl?: string,
  timeoutMs?: number,
  numCtx?: number,
  signal?: AbortSignal,
  gitNexusCtx?: GitNexusContext | null,
): Promise<void> {
```

Inside the function body, call `groupIndexOutputs` once and reuse results (avoids a redundant community re-query):

```typescript
  // Single call — reuse batches for manifest and groups for processing
  const { batches: computedBatches, groups } = await groupIndexOutputs(projectRoot, gitNexusCtx);

  if (noAnalyzeProgress) {
    manifest.batches.analyze = computedBatches;
    writeManifest(projectRoot, manifest);
    manifest = readManifest(projectRoot);
  }
```

- [ ] **Step 3: Typecheck**

```powershell
npx tsc --noEmit
```

Expected: only remaining error is `runRefactorPhase` not yet accepting `gitNexusCtx`.

- [ ] **Step 4: Run existing tests**

```powershell
npx vitest run
```

Expected: all pass

- [ ] **Step 5: Commit**

```powershell
git add src/phases/analyze.ts
git commit -m "feat: runAnalyzePhase — community-cluster batching via getCommunities"
```

---

## Task 10: `refactorPrompt` — optional impactedPaths param

**Files:**
- Modify: `src/prompts/templates.ts`

- [ ] **Step 1: Add failing test**

Append to `tests/unit/templates-gitnexus.test.ts`:

```typescript
import { refactorPrompt } from '../../src/prompts/templates.js';
import type { IndexOutput } from '../../src/types.js';

const emptyModules: IndexOutput[] = [];
const emptyContents = new Map<string, string>();
const stdMd = '# Standards\n- no globals';

describe('refactorPrompt with impactedPaths', () => {
  it('does not include dependents section when impactedPaths is absent', () => {
    const prompt = refactorPrompt(stdMd, emptyModules, emptyContents);
    expect(prompt).not.toContain('Known dependents');
  });

  it('includes dependents section when impactedPaths provided', () => {
    const prompt = refactorPrompt(stdMd, emptyModules, emptyContents, ['src/a.ts', 'src/b.ts']);
    expect(prompt).toContain('Known dependents');
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toContain('src/b.ts');
  });

  it('does not include dependents section when impactedPaths is empty array', () => {
    const prompt = refactorPrompt(stdMd, emptyModules, emptyContents, []);
    expect(prompt).not.toContain('Known dependents');
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```powershell
npx vitest run tests/unit/templates-gitnexus.test.ts
```

Expected: FAIL — `refactorPrompt` does not accept fourth argument

- [ ] **Step 3: Update `refactorPrompt` in `src/prompts/templates.ts`**

Replace the `refactorPrompt` function signature and body. Add `impactedPaths` as the last parameter and inject the Known dependents section:

```typescript
export function refactorPrompt(
  standardsMd: string,
  modules: IndexOutput[],
  fileContents: Map<string, string>,
  impactedPaths?: string[] | null,
): string {
  const fileBlock = [...fileContents.entries()]
    .map(([path, content]) => `=== ${path} ===\n${content}`)
    .join('\n\n');

  const impactSection = impactedPaths && impactedPaths.length > 0
    ? `\nKnown dependents (files that import or call into these modules — ensure your plan accounts for them in dependencies_impacted and tests_to_validate):\n${impactedPaths.map(p => `  - ${p}`).join('\n')}\n`
    : '';

  return `You are a senior engineer. Using the standards, module summaries, and file contents below, create a refactor plan.${impactSection}
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

- [ ] **Step 4: Run tests — expect pass**

```powershell
npx vitest run tests/unit/templates-gitnexus.test.ts
```

Expected: PASS (all tests)

- [ ] **Step 5: Run full suite**

```powershell
npx vitest run
```

Expected: all pass

- [ ] **Step 6: Commit**

```powershell
git add src/prompts/templates.ts tests/unit/templates-gitnexus.test.ts
git commit -m "feat: refactorPrompt optional impactedPaths — Known dependents section"
```

---

## Task 11: `runRefactorPhase` enrichment — getImpact per batch, inject into prompt

**Files:**
- Modify: `src/phases/refactor.ts`

- [ ] **Step 1: Add imports and update signature**

Add imports at top of `src/phases/refactor.ts`:

```typescript
import { getImpact } from '../gitnexus.js';
import type { GitNexusContext } from '../gitnexus.js';
```

Update `runRefactorPhase` signature:

```typescript
export async function runRefactorPhase(
  projectRoot: string,
  model: string,
  logger: Logger,
  lmUrl?: string,
  timeoutMs?: number,
  numCtx?: number,
  signal?: AbortSignal,
  gitNexusCtx?: GitNexusContext | null,
): Promise<void> {
```

- [ ] **Step 2: Add impact collection and pass to prompt inside the batch loop**

Inside the `for (let i = 0; i < manifest.batches.refactor.length; i++)` loop, after `const contentMap = fileContentMaps[i] ?? new Map<string, string>();`, add:

```typescript
    // Collect combined impact for all files in this batch (parallel — one query per file)
    let batchImpactedPaths: string[] | null = null;
    if (gitNexusCtx) {
      const batchFiles = moduleItems.map(m => m.module);
      const impacts = await Promise.all(batchFiles.map(fp => getImpact(gitNexusCtx, fp)));
      const allImpacted = new Set<string>();
      for (const impact of impacts) {
        if (impact) impact.impactedPaths.forEach(p => allImpacted.add(p));
      }
      // Remove files that are themselves in this batch
      const batchNorm = new Set(batchFiles.map(fp => fp.replace(/\\/g, '/')));
      for (const fp of batchNorm) allImpacted.delete(fp);
      batchImpactedPaths = allImpacted.size > 0 ? [...allImpacted].sort() : null;
    }
```

Then update the `prompt` line inside `withRetry`:

```typescript
        const prompt = refactorPrompt(standardsMd, moduleItems, contentMap, batchImpactedPaths);
```

- [ ] **Step 3: Typecheck — expect clean**

```powershell
npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 4: Run full test suite**

```powershell
npx vitest run
```

Expected: all pass

- [ ] **Step 5: Build**

```powershell
npm run build
```

Expected: clean build, no errors

- [ ] **Step 6: Commit**

```powershell
git add src/phases/refactor.ts
git commit -m "feat: runRefactorPhase — getImpact per batch, inject Known dependents into prompt"
```

---

## Task 12: Integration validation against fcc-site

**Files:** none (validation only)

- [ ] **Step 1: Confirm fcc-site has a GitNexus index**

```powershell
npx gitnexus status --cwd "C:\Users\cflur\projects\fcc-site"
```

Expected: index found, shows symbol counts

- [ ] **Step 2: Run code-analyzer+ against fcc-site — full pipeline**

```powershell
cd "C:\Users\cflur\projects\fcc-site"
node "C:\Users\cflur\projects\code-analyzer+\dist\index.js"
```

Expected:
- Prints "GitNexus index found — running npx gitnexus analyze to refresh"
- `npx gitnexus analyze` completes
- Phases 1–4 run to completion
- `code-analysis/` directory created in fcc-site

- [ ] **Step 3: Inspect an index batch — confirm graph-sourced dependencies**

```powershell
Get-Content "C:\Users\cflur\projects\fcc-site\code-analysis\index\batch-001.json" | ConvertFrom-Json | Select-Object -First 1 | Select-Object module, dependencies, data_flow | Format-List
```

Expected: `dependencies` lists actual import paths (e.g., `src/lib/utils.ts`), `data_flow` entries start with `→`.

- [ ] **Step 4: Compare batch count — community vs. byte grouping**

Check how many analyze batches were created and look at a batch to confirm community grouping:

```powershell
$manifest = Get-Content "C:\Users\cflur\projects\fcc-site\code-analysis\manifest.json" | ConvertFrom-Json
$manifest.batches.analyze.Count
```

Then inspect one analyze batch output to confirm related files appear together.

- [ ] **Step 5: Inspect a refactor plan — confirm Known dependents present**

```powershell
Get-Content "C:\Users\cflur\projects\fcc-site\code-analysis\refactor\plan-001.md" | Select-String "Known dependents" -Context 0,5
```

Expected: "Known dependents" section present if that file has any importers.

- [ ] **Step 6: Confirm fallback works — run against a repo with no .gitnexus**

Run code-analyzer+ against a directory that has no `.gitnexus/`:

```powershell
cd "C:\Users\cflur\projects\Pokemon"
node "C:\Users\cflur\projects\code-analyzer+\dist\index.js"
```

Expected: Y/N prompt appears. Press `N` → exits cleanly. Re-run, press `Y` → runs full pipeline using existing behavior (byte-based batching, no graph data).

- [ ] **Step 7: Final commit**

```powershell
cd "C:\Users\cflur\projects\code-analyzer+"
git add .
git commit -m "chore: integration validated against fcc-site"
```
