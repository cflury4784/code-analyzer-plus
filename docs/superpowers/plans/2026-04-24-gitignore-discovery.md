# .gitignore-Based File Discovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `discovery.ts`'s hardcoded exclusion set with `.gitignore`-based filtering using the `ignore` npm package, so code-analyzer automatically respects any project's `.gitignore`.

**Architecture:** `discoverFiles()` reads the project root's `.gitignore` once at startup via the `ignore` package. If no `.gitignore` exists, falls back to the existing hardcoded set. `code-analysis/` and `.git/` are always excluded via a permanent name-check regardless of `.gitignore` content. The public API of `discoverFiles()` does not change.

**Tech Stack:** TypeScript 5, Node.js 20+, Vitest, `ignore` npm package (v5)

---

## File Map

| File | Change |
|------|--------|
| `package.json` | Add `ignore@^5.3.0` to `dependencies` |
| `src/discovery.ts` | Replace `EXCLUDED` set with `buildIgnore()` + `ALWAYS_EXCLUDED` + `FALLBACK_EXCLUDED` |
| `tests/unit/discovery.test.ts` | Add 5 new test cases for `.gitignore` behavior |

---

### Task 1: Install `ignore` package

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add `ignore` to dependencies and install**

Run from `C:\Users\cflur\projects\code-analyzer`:
```bash
npm install ignore@^5.3.0
```

Expected: `node_modules/ignore/` exists, `package.json` `dependencies` now includes `"ignore": "^5.3.x"`.

- [ ] **Step 2: Verify existing tests still pass**

Run:
```bash
npx vitest run
```

Expected: All 6 existing `discovery.test.ts` tests pass. No regressions.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add ignore package for .gitignore-based file discovery"
```

---

### Task 2: Add failing tests for .gitignore behavior

**Files:**
- Modify: `tests/unit/discovery.test.ts`

Add the following 5 tests inside the existing `describe('discoverFiles', ...)` block, after the last existing test. The full current file content is included for reference — add only the new `it(...)` blocks.

- [ ] **Step 1: Add the 5 new test cases**

Append to `tests/unit/discovery.test.ts` inside the `describe` block:

```typescript
  it('reads .gitignore and excludes matched directories', () => {
    writeFileSync(join(testRoot, '.gitignore'), 'custom-excluded/\n');
    mkdirSync(join(testRoot, 'custom-excluded'), { recursive: true });
    writeFileSync(join(testRoot, 'custom-excluded', 'file.ts'), 'x');
    writeFileSync(join(testRoot, 'keep.ts'), 'x');
    const files = discoverFiles(testRoot);
    expect(files.some(f => f.path.startsWith('custom-excluded/'))).toBe(false);
    expect(files.some(f => f.path === 'keep.ts')).toBe(true);
  });

  it('reads .gitignore and excludes matched files by glob', () => {
    writeFileSync(join(testRoot, '.gitignore'), '*.log\n');
    writeFileSync(join(testRoot, 'app.log'), 'x');
    writeFileSync(join(testRoot, 'app.ts'), 'x');
    const files = discoverFiles(testRoot);
    expect(files.some(f => f.path === 'app.log')).toBe(false);
    expect(files.some(f => f.path === 'app.ts')).toBe(true);
  });

  it('respects .gitignore negation patterns', () => {
    writeFileSync(join(testRoot, '.gitignore'), '*.log\n!important.log\n');
    writeFileSync(join(testRoot, 'debug.log'), 'x');
    writeFileSync(join(testRoot, 'important.log'), 'x');
    const files = discoverFiles(testRoot);
    expect(files.some(f => f.path === 'debug.log')).toBe(false);
    expect(files.some(f => f.path === 'important.log')).toBe(true);
  });

  it('always excludes code-analysis/ even when not in .gitignore', () => {
    writeFileSync(join(testRoot, '.gitignore'), '# no exclusions\n');
    mkdirSync(join(testRoot, 'code-analysis'), { recursive: true });
    writeFileSync(join(testRoot, 'code-analysis', 'manifest.json'), '{}');
    const files = discoverFiles(testRoot);
    expect(files.some(f => f.path.startsWith('code-analysis/'))).toBe(false);
  });

  it('always excludes .git/ even when not in .gitignore', () => {
    writeFileSync(join(testRoot, '.gitignore'), '# no exclusions\n');
    mkdirSync(join(testRoot, '.git'), { recursive: true });
    writeFileSync(join(testRoot, '.git', 'HEAD'), 'ref: refs/heads/main');
    const files = discoverFiles(testRoot);
    expect(files.some(f => f.path.startsWith('.git/'))).toBe(false);
  });
```

- [ ] **Step 2: Run tests — expect 5 failures, 6 passes**

Run:
```bash
npx vitest run tests/unit/discovery.test.ts
```

Expected: 6 existing tests PASS, 5 new tests FAIL (wrong behavior — `.gitignore` not yet read).

---

### Task 3: Update discovery.ts

**Files:**
- Modify: `src/discovery.ts`

Replace the entire file with the implementation below. Key changes from the current version:
- `EXCLUDED` set is removed
- `ALWAYS_EXCLUDED` (Set): `code-analysis`, `.git` — checked by `entry.name` first, before anything else
- `FALLBACK_EXCLUDED` (Set): `node_modules`, `dist`, `build`, `out`, `coverage` — used only when no `.gitignore` exists
- `buildIgnore()` reads `<projectRoot>/.gitignore` via the `ignore` package; returns `null` if not present
- Walk: for each entry, `relPath` is computed once; directories are tested via `ig.ignores(relPath)`, files the same

- [ ] **Step 1: Replace `src/discovery.ts`**

```typescript
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import ignore, { type Ignore } from 'ignore';
import type { FileEntry } from './types.js';

const ALWAYS_EXCLUDED = new Set(['code-analysis', '.git']);
const FALLBACK_EXCLUDED = new Set(['node_modules', 'dist', 'build', 'out', 'coverage']);
const MAX_BYTES = 500 * 1024;

function buildIgnore(projectRoot: string): Ignore | null {
  const gitignorePath = join(projectRoot, '.gitignore');
  if (!existsSync(gitignorePath)) return null;
  return ignore().add(readFileSync(gitignorePath, 'utf8'));
}

export function discoverFiles(projectRoot: string): FileEntry[] {
  const ig = buildIgnore(projectRoot);
  const results: FileEntry[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ALWAYS_EXCLUDED.has(entry.name)) continue;

      const full = join(dir, entry.name);
      const relPath = relative(projectRoot, full).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (ig !== null) {
          if (ig.ignores(relPath)) continue;
        } else {
          if (FALLBACK_EXCLUDED.has(entry.name)) continue;
        }
        walk(full);
      } else if (entry.isFile()) {
        if (ig !== null && ig.ignores(relPath)) continue;
        const size_bytes = statSync(full).size;
        results.push(
          size_bytes > MAX_BYTES
            ? { path: relPath, size_bytes, skipped: true, skip_reason: 'size_exceeded' }
            : { path: relPath, size_bytes, skipped: false, skip_reason: null }
        );
      }
    }
  }

  walk(projectRoot);
  return results;
}
```

- [ ] **Step 2: Run all tests — expect all 11 pass**

Run:
```bash
npx vitest run tests/unit/discovery.test.ts
```

Expected: PASS — 11 tests (6 existing + 5 new).

If the `reads .gitignore and excludes matched directories` test fails, the `ignore` package may require checking `ig.ignores(relPath + '/')` for directory patterns. If so, change the directory check to:

```typescript
if (ig.ignores(relPath) || ig.ignores(relPath + '/')) continue;
```

Re-run until all 11 pass.

- [ ] **Step 3: Verify TypeScript compiles**

Run:
```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Run full test suite**

Run:
```bash
npx vitest run
```

Expected: All tests pass (discovery + any other test files present).

- [ ] **Step 5: Commit**

```bash
git add src/discovery.ts tests/unit/discovery.test.ts
git commit -m "feat: replace hardcoded exclusions with .gitignore-based file discovery"
```

---

## Self-Review Against Spec

| Spec Requirement | Covered By |
|---|---|
| Read root `.gitignore` when present | Task 3 — `buildIgnore()` |
| Fall back to hardcoded list when no `.gitignore` | Task 3 — `FALLBACK_EXCLUDED` + null check |
| `code-analysis/` always excluded | Task 3 — `ALWAYS_EXCLUDED` |
| `.git/` always excluded | Task 3 — `ALWAYS_EXCLUDED` |
| Nested `.gitignore` files ignored (root only) | Task 3 — `buildIgnore()` reads only root |
| `ignore` package as runtime dependency | Task 1 |
| Test: `.gitignore` excludes matched directories | Task 2 — test 1 |
| Test: `.gitignore` glob pattern for files | Task 2 — test 2 |
| Test: negation pattern | Task 2 — test 3 |
| Test: `code-analysis/` always excluded | Task 2 — test 4 |
| Test: `.git/` always excluded | Task 2 — test 5 |
| No change to `discoverFiles()` public signature | Task 3 — signature unchanged |
| No changes to VoyageDesk | Confirmed — VoyageDesk `.gitignore` read automatically |
