# Phase 2.2 — Consolidate JSON Extraction Logic
## Implementation Plan

**Version**: 1.0 — 2026-06-22
**Requires**: Phase 1b.2 integration test gate passed
**Provides**: `src/utils/extractJson.ts`; `src/utils/index.ts`; C4 fully satisfied in phase modules

---

## Requires Manifest

- Phase 1b.2 merged and green
- C4 guard maintained during Phase 1b (no new inline parsing was introduced)
- `src/utils.ts` (root-level `calculateSafeMaxTokens`) exists and is NOT touched

## Provides Manifest

| Artifact | Description |
|---|---|
| `src/utils/extractJson.ts` | Pure `extractJson(raw): unknown` utility |
| `src/utils/index.ts` | Barrel export for `src/utils/` |
| `src/phases/index.ts` | Two inline brace-tracking functions removed; `extractJson` used instead |
| `src/phases/analyze.ts` | Bare `JSON.parse(raw)` replaced with `extractJson(raw)` |
| `src/phases/dedup.ts` | Both bare `JSON.parse(raw)` calls replaced |

C4 invariant now fully satisfied: no inline brace-tracking or `JSON.parse`-of-LLM-output exists outside `extractJson`.

---

## IMPORTANT: Coexistence of `src/utils.ts` and `src/utils/`

`src/utils.ts` (root-level, exports `calculateSafeMaxTokens`) and `src/utils/` (subdirectory) coexist in Node.js module resolution:
- `import '../utils.js'` resolves to `src/utils.ts`
- `import '../utils/index.js'` resolves to `src/utils/index.ts`

These paths are distinct and do not conflict. **Verify** your build tooling resolves both correctly with `npx tsc --noEmit` before proceeding. If there is a conflict, rename `src/utils.ts` to `src/token-utils.ts` and update the one import in `analyze.ts`.

---

## File 1: `src/utils/extractJson.ts` (NEW)

### 1. File Overview

Single pure function `extractJson(raw: string): unknown`. No imports from other `src/` files. No module-level state.

### 2. Detailed Code

```typescript
/**
 * Extracts and parses a JSON value from raw LLM model output.
 *
 * Strategy:
 *  1. Strip code fences and trim.
 *  2. Try parsing the entire cleaned string.
 *  3. Brace-track to find the first complete JSON array ([...]).
 *  4. Brace-track to find the first complete JSON object ({...}).
 *
 * @throws {Error} If no valid JSON value can be found.
 */
export function extractJson(raw: string): unknown {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  try { return JSON.parse(cleaned); } catch { /* fall through */ }

  const arrayResult = extractByOpenChar(cleaned, '[', ']');
  if (arrayResult !== null) {
    try { return JSON.parse(arrayResult); } catch { /* fall through */ }
  }

  const objResult = extractByOpenChar(cleaned, '{', '}');
  if (objResult !== null) {
    try { return JSON.parse(objResult); } catch { /* fall through */ }
  }

  throw new Error('no valid JSON found in model response');
}

function extractByOpenChar(input: string, open: string, close: string): string | null {
  const start = input.indexOf(open);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  return null;
}
```

### 3. Implementation Notes

- Returns `unknown` — callers cast with `as T` at the call site (same pattern as existing `JSON.parse(raw) as T`)
- `extractByOpenChar` is not exported — implementation detail only
- Implements the superset of the two inline functions in `src/phases/index.ts` (`extractJsonArray` and `extractJsonFromResponse`)

### 4. Validation & Testing

Create `tests/unit/extractJson.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractJson } from '../../src/utils/extractJson.js';

describe('extractJson', () => {
  it('parses a bare JSON array', () => {
    expect(extractJson('[{"a":1}]')).toEqual([{ a: 1 }]);
  });
  it('parses a bare JSON object', () => {
    expect(extractJson('{"key":"val"}')).toEqual({ key: 'val' });
  });
  it('strips json code fences', () => {
    expect(extractJson('```json\n[1,2,3]\n```')).toEqual([1, 2, 3]);
  });
  it('extracts array embedded in prose', () => {
    expect(extractJson('Here: [{"a":1}] done.')).toEqual([{ a: 1 }]);
  });
  it('handles escaped quotes inside strings', () => {
    expect(extractJson('{"key":"val\\"ue"}')).toEqual({ key: 'val"ue' });
  });
  it('handles nested objects', () => {
    expect(extractJson('{"a":{"b":1}}')).toEqual({ a: { b: 1 } });
  });
  it('throws on empty string', () => {
    expect(() => extractJson('')).toThrow('no valid JSON found in model response');
  });
  it('throws on unbalanced braces', () => {
    expect(() => extractJson('{"a":1')).toThrow();
  });
});
```

### 5. Idempotency & Safety Checks

- Pure function — no side effects, no shared state
- Rollback: revert `src/utils/extractJson.ts` + `src/utils/index.ts` + three phase file changes

---

## File 2: `src/utils/index.ts` (NEW)

```typescript
export { extractJson } from './extractJson.js';
```

---

## Files 3–5: Phase modules (MODIFIED)

### `src/phases/index.ts`

1. Add import: `import { extractJson } from '../utils/index.js';`
2. Delete the entire bodies of `extractJsonArray` (lines 14–45) and `extractJsonFromResponse` (lines 47–108)
3. Change the call site (line 165):
   - Old: `const parsed = JSON.parse(extractJsonArray(raw)) as Partial<IndexOutput>[];`
   - New: `const parsed = extractJson(raw) as Partial<IndexOutput>[];`

### `src/phases/analyze.ts`

1. Add import: `import { extractJson } from '../utils/index.js';`
2. Change line 189 inside `withRetry`:
   - Old: `const parsed = JSON.parse(raw) as AnalysisOutput;`
   - New: `const parsed = extractJson(raw) as AnalysisOutput;`

### `src/phases/dedup.ts`

1. Add import: `import { extractJson } from '../utils/index.js';`
2. Change Pass A call site:
   - Old: `const parsed = JSON.parse(raw) as DedupOutput;`
   - New: `const parsed = extractJson(raw) as DedupOutput;`
3. Change Pass B call site:
   - Old: `return JSON.parse(raw) as DedupOutput;`
   - New: `return extractJson(raw) as DedupOutput;`

**Do NOT change** `JSON.parse(readFileSync(...))` calls in `dedup.ts` — those read previously validated files from disk, not LLM output. C4 does not apply to them.

---

## Implementation Notes

- `withRetry` catches all throws from inner lambdas. The new `'no valid JSON found in model response'` error message is strictly more informative than the old raw `SyntaxError` — retry behavior is unchanged.
- The `safeMaxTokens` duplicate in `dedup.ts` (mirrors `calculateSafeMaxTokens` in `src/utils.ts`) is a Phase 3.2 finding. Do NOT merge them here.

---

## Execution Order

```
1. Verify src/utils.ts and src/utils/ coexist without conflict (npx tsc --noEmit on a scratch import)
2. Create src/utils/extractJson.ts
3. Create src/utils/index.ts
4. npx tsc --noEmit  [must pass]
5. Modify src/phases/index.ts (remove inline functions, add import, update call site)
6. npx tsc --noEmit  [must pass]
7. Modify src/phases/analyze.ts
8. Modify src/phases/dedup.ts
9. npx tsc --noEmit  [must pass]
10. npx vitest run  [all tests green]
```

## Post-PR C4 Compliance Check

```powershell
grep -n "JSON.parse" src/phases/index.ts src/phases/analyze.ts src/phases/dedup.ts
# Expected: only disk-read lines (readFileSync calls), zero bare JSON.parse(raw) on LLM output
```
