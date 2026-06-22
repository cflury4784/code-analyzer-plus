# code-analyzer: .gitignore-Based File Discovery — Design Spec
**Date:** 2026-04-24
**Status:** Approved

---

## Overview

Replace `discovery.ts`'s hardcoded directory exclusion set with `.gitignore`-based filtering. When a project has a root `.gitignore`, code-analyzer reads and respects it automatically — no extra config file needed. `code-analysis/` and `.git/` are always excluded regardless.

---

## Goals

- Zero config for any project that already has a `.gitignore`
- Generic — works for all projects, not VoyageDesk-specific
- Backward compatible — falls back to current hardcoded list when no `.gitignore` is present
- `code-analysis/` (the tool's own output) always excluded unconditionally

## Non-Goals

- Nested `.gitignore` files in subdirectories — root only
- Writing or modifying the target project's `.gitignore`
- Per-project supplemental ignore files (`.analyzerignore`)

---

## Files Changed

| File | Change |
|------|--------|
| `src/discovery.ts` | Replace `EXCLUDED` set with `ignore`-based filter |
| `package.json` | Add `ignore` as a runtime dependency |
| `tests/unit/discovery.test.ts` | Add `.gitignore`-reading test cases |

No changes to any other file. VoyageDesk requires no changes.

---

## Discovery Logic

### Constants

```typescript
const ALWAYS_EXCLUDED = ['code-analysis', '.git'];  // checked by entry.name, never skipped
const FALLBACK_EXCLUDED = new Set([                  // used when no .gitignore exists
  'node_modules', 'dist', 'build', 'out', 'coverage'
]);
const MAX_BYTES = 500 * 1024;
```

### buildIgnore()

```typescript
function buildIgnore(projectRoot: string): Ignore | null {
  const gitignorePath = join(projectRoot, '.gitignore');
  if (!existsSync(gitignorePath)) return null;
  return ignore().add(readFileSync(gitignorePath, 'utf8'));
}
```

Returns `null` when no `.gitignore` exists. Caller uses the fallback set in that case.

### Walk logic (pseudocode)

```
ig = buildIgnore(projectRoot)   // null if no .gitignore

walk(dir):
  for each entry in dir:
    relPath = relative(projectRoot, entry.fullPath).replace('\\', '/')

    if entry.name is in ALWAYS_EXCLUDED → skip

    if entry.isDirectory:
      if ig != null:
        if ig.ignores(relPath + '/') → skip
      else:
        if entry.name in FALLBACK_EXCLUDED → skip
      walk(entry.fullPath)

    if entry.isFile:
      if ig != null and ig.ignores(relPath) → skip
      add to results (with size check)
```

Trailing `/` is appended when testing directories — required for correct gitignore directory-pattern matching.

---

## Dependency

**Package:** `ignore` (npm)
- Lightweight, zero runtime deps
- Handles full gitignore spec: globs, negation (`!`), trailing slashes, comments
- Added to `dependencies` (not `devDependencies`) — runs at analysis time

```json
"dependencies": {
  "ignore": "^5.3.0",
  "minimist": "^1.2.8"
}
```

---

## Test Cases Added

1. `.gitignore` present with `dist/` → files inside `dist/` are excluded
2. `.gitignore` with `*.log` and `!important.log` → negation at root level works, `important.log` is included
3. No `.gitignore` → fallback hardcoded exclusions apply (existing tests unchanged)
4. `code-analysis/` always excluded even when not in `.gitignore`
5. `.git/` always excluded even when not in `.gitignore`

---

## Behavior by Scenario

| Scenario | Behavior |
|---|---|
| Project has `.gitignore` | Patterns from root `.gitignore` drive exclusions |
| Project has no `.gitignore` | Hardcoded fallback: `node_modules`, `dist`, `build`, `out`, `coverage` |
| `code-analysis/` not in `.gitignore` | Always excluded (tool's own output) |
| `.git/` not in `.gitignore` | Always excluded |
| Nested `.gitignore` files | Ignored — root only |

---

## Impact on VoyageDesk

Running `code-analyzer` in VoyageDesk after this change, the following would be excluded automatically via `.gitignore`:

- `node_modules/`, `/coverage`, `/.next/`, `/out/`, `/build`, `.vercel/`
- `.env*` files
- `*.pem`, `*.tsbuildinfo`, `next-env.d.ts`, `local.db*`
- `.worktrees/`, `.superpowers/`

Plus always-excluded: `code-analysis/`, `.git/`

Not in VoyageDesk's `.gitignore` (still analyzed): `public/`, `docs/`, `.claude/`, `.ruff_cache/`, `drizzle/`

These can be added to `.gitignore` by the user if desired — the tool will pick them up automatically.
