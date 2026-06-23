# Phase 1a — Bin Entry Fix
## Implementation Plan

**Version**: 1.0 — 2026-06-22
**PR scope**: `package.json` only
**Risk**: Zero architectural risk
**Rollback**: `git revert HEAD` on `package.json` — no other files touched
**Standards enforced**: C2 (Bin Entry Consistency)

---

## Requires

- Read access to `package.json`, `tsconfig.json`, `dist/` tree
- No upstream phase must complete first (ships in parallel with Phase 0)

## Provides

- `package.json` with correct `bin` entry (path + binary name verified)
- PR comment recording: resolved binary name, resolved file path, and verification command output — for downstream phases to reference

---

## Pre-Execution Verification (mandatory — do not skip)

Perform all checks before editing any file.

### Step V1 — Read the current `bin` field

```powershell
Get-Content 'package.json' | ConvertFrom-Json | Select-Object -ExpandProperty bin
```

Expected current state: `{ "code-analyzer": "./dist/src/index.js" }`

### Step V2 — Confirm `tsconfig.json` outDir

```powershell
Get-Content 'tsconfig.json' | ConvertFrom-Json | Select-Object -ExpandProperty compilerOptions
```

Expected: `outDir: "./dist"`, `rootDir: "."` → TypeScript emits `src/index.ts` → `dist/src/index.js`.

### Step V3 — Confirm compiled entry file exists

```powershell
Test-Path '.\dist\src\index.js'
```

Must return `True`. If `False`, run `npm run build` first.

### Step V4 — Confirm shebang is present

```powershell
Get-Content '.\dist\src\index.js' -TotalCount 1
```

Must return `#!/usr/bin/env node`. If absent, rebuild (`npm run build`) and recheck.

### Step V5 — Determine intended binary name

Cross-reference against README and spec. The refactor strategy references `npx gitnexus` as the expected invocation. Current `bin` key is `code-analyzer`.

```powershell
if (Test-Path '.\README.md') { Get-Content '.\README.md' | Select-String 'gitnexus|code-analyzer|bin|npx' }
```

If README confirms `gitnexus` is the user-facing command, the binary name fix is confirmed. If ambiguous, **stop and ask the project owner**.

---

## File Overview

**File**: `package.json`
**Role**: NPM package manifest. The `bin` field maps binary names to entry file paths.
**Current state**: `bin.code-analyzer` → `./dist/src/index.js` (file exists, shebang present).
**Problem**: Binary name `code-analyzer` does not match the intended CLI command `gitnexus`. Users running `npx gitnexus` get command-not-found.

---

## Change Summary

Remove the `code-analyzer` key from `bin` and add a `gitnexus` key pointing to `./dist/src/index.js`.

---

## Detailed Code Modifications

### File: `package.json`

**old_string** (match exactly, preserve 2-space indent):

```json
  "bin": {
    "code-analyzer": "./dist/src/index.js"
  },
```

**new_string**:

```json
  "bin": {
    "gitnexus": "./dist/src/index.js"
  },
```

**Conditional branches**:
- If Step V3 shows `dist/src/index.js` does NOT exist → run `npm run build`, recheck, then proceed.
- If Step V5 finds intended binary name is NOT `gitnexus` → stop and report.
- If Step V5 confirms `gitnexus` → apply the change above.

---

## Implementation Notes

1. `./dist/src/index.js` is the correct path — do not change it.
2. Do not rename the `name` field (`"code-analyzer"`) — that is the npm registry name. Out of scope.
3. Shebang in `src/index.ts` line 1 carries through to compiled output.
4. Standards C2 is satisfied: `bin.gitnexus` → `./dist/src/index.js` (file exists).
5. After editing `package.json`, run `npm install` or `npm link` to regenerate the bin shim for local testing.

---

## Validation & Testing

### V-A: File path check
```powershell
Test-Path '.\dist\src\index.js'   # True
```

### V-B: Dry-run pack
```powershell
npm pack --dry-run 2>&1
# Look for: bin: gitnexus -> dist/src/index.js
```

### V-C: Execute via Node directly
```powershell
node .\dist\src\index.js --help
# Must print help text, no module resolution error
```

### V-D: Execute via npx
```powershell
npx . --help
# Must produce help output, not command-not-found
```

### V-E: Confirm only package.json changed
```powershell
git diff --name-only
# Must output exactly: package.json
```

---

## Idempotency & Safety Checks

| Check | Command | Pass condition |
|---|---|---|
| Bin file exists | `Test-Path '.\dist\src\index.js'` | `True` |
| Shebang present | `(Get-Content '.\dist\src\index.js' -TotalCount 1) -eq '#!/usr/bin/env node'` | `True` |
| Only one file changed | `git diff --name-only` | `package.json` only |
| `bin` key is `gitnexus` | `(Get-Content package.json \| ConvertFrom-Json).bin` | Property `gitnexus` present, `code-analyzer` absent |
| `bin` value correct | `(Get-Content package.json \| ConvertFrom-Json).bin.gitnexus` | `./dist/src/index.js` |

**Rollback**:
```powershell
git revert HEAD --no-edit
git push
```

---

## PR Comment Template (post-merge, required)

```
Phase 1a complete.

Resolved binary name: gitnexus
Resolved entry file path: ./dist/src/index.js
Verification: `node ./dist/src/index.js --help` exits 0; `npx . --help` resolves bin correctly.
Standards: C2 satisfied.

Downstream note: Any phase that references the binary name must use `gitnexus`.
The npm package name (`name` field) remains `code-analyzer` and is unchanged.
```
