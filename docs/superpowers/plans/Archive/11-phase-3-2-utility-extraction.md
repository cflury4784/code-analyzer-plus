# Phase 3.2 — Extract Utility Functions
## Implementation Plan

**Version**: 1.0 — 2026-06-22
**Requires**: Phase 2.2 complete (`src/utils/index.ts` must exist and export `extractJson`)
**Provides**: `src/utils/groupByByteSize.ts`; `src/utils/resolveModelIdentifier.ts`; `safeMaxTokens` consolidated into `calculateSafeMaxTokens`

---

## Requires Manifest

- Phase 2.2 merged (`src/utils/index.ts` exists)
- `src/models.ts` stable (no concurrent PR renaming exports)
- `src/utils.ts` root-level `calculateSafeMaxTokens` exists and is correct
- `npx madge` available for circular import check

## Provides Manifest

| Artifact | Description |
|---|---|
| `src/utils/groupByByteSize.ts` | Pure generic byte-budget accumulator |
| `src/utils/resolveModelIdentifier.ts` | Pure model registry lookup with ad-hoc fallback |
| `src/utils/index.ts` | Updated barrel — exports both new utilities |
| `src/phases/analyze.ts` | Inline byte-grouping loops replaced with `groupByByteSize` |
| `src/preflight.ts` | `escapeRegex` + `resolveSpec` removed; uses `resolveModelIdentifier` |
| `src/phases/dedup.ts` | `safeMaxTokens` deleted; uses `calculateSafeMaxTokens` from root `utils.ts` |

---

## Pre-Condition Check (MANDATORY)

```powershell
Test-Path 'src/utils/index.ts'
# Must return True. If False: Phase 2.2 has not merged — stop.
```

---

## Purity Verification (DO THIS BEFORE EXTRACTING)

### `groupByByteSize` — verify pure

In `analyze.ts`, the byte-grouping accumulator:
- Accepts array input, byte ceiling constant
- Calls `JSON.stringify(item).length` (pure — no I/O)
- Returns grouped arrays
- No `fs`, no network, no `process.*`, no mutable module state

**Confirmed pure. Safe to extract.**

### `resolveModelIdentifier` — verify pure

In `preflight.ts`:
- `escapeRegex`: pure string transformation
- `resolveSpec`: reads from `MODEL_REGISTRY` (frozen constant), returns `{ spec, known }`
- No I/O, no network, no `process.*`

**Confirmed pure. Safe to extract.**

### `safeMaxTokens` consolidation — verify formula matches

Before deleting `safeMaxTokens` from `dedup.ts`, verify the formula is byte-for-byte identical to `calculateSafeMaxTokens` in `src/utils.ts`:

```
dedup.ts:    Math.max(500, Math.min(Math.floor(numCtx * 0.85) - Math.ceil(promptLen / 3.5), cap))
utils.ts:    Math.max(500, Math.min(Math.floor(numCtx * 0.85) - Math.ceil(promptLen / 3.5), cap))
```

If formulas differ even slightly, **stop and report** — do not consolidate until the discrepancy is understood.

---

## File 1: `src/utils/groupByByteSize.ts` (NEW)

```typescript
/**
 * Partition an array of items into groups where no group exceeds `maxGroupBytes`
 * when serialized to JSON. Items larger than the limit are placed in their own
 * single-item group.
 *
 * Pure function — no I/O, no side effects.
 */
export function groupByByteSize<T>(items: T[], maxGroupBytes: number): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let currentSize = 0;

  for (const item of items) {
    const size = JSON.stringify(item).length;
    if (currentSize + size > maxGroupBytes && current.length > 0) {
      groups.push(current);
      current = [item];
      currentSize = size;
    } else {
      current.push(item);
      currentSize += size;
    }
  }
  if (current.length > 0) groups.push(current);

  return groups;
}
```

---

## File 2: `src/utils/resolveModelIdentifier.ts` (NEW)

```typescript
import { MODEL_REGISTRY, type ModelSpec } from '../models.js';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve a logical model name to its ModelSpec and whether it is registered.
 *
 * - Known models: returns the registered ModelSpec.
 * - Unknown models: builds an ad-hoc ModelSpec with regex-escaped identifierMatch.
 *   `requiredTotalGB` is 0 — caller must supply actual requirement at runtime.
 *
 * Pure function — no I/O, no side effects.
 */
export function resolveModelIdentifier(
  modelName: string,
): { spec: ModelSpec; known: boolean } {
  const known = MODEL_REGISTRY[modelName];
  if (known) return { spec: known, known: true };
  return {
    spec: {
      loadKey: modelName,
      identifierMatch: new RegExp(escapeRegex(modelName), 'i'),
      requiredTotalGB: 0,
    },
    known: false,
  };
}
```

---

## File 3: `src/utils/index.ts` (APPEND)

Append to the existing barrel (do not replace existing exports):

```typescript
export { groupByByteSize } from './groupByByteSize.js';
export { resolveModelIdentifier } from './resolveModelIdentifier.js';
```

---

## File 4: `src/phases/analyze.ts` (MODIFY)

**Add import**:
```typescript
import { groupByByteSize } from '../utils/index.js';
```

**Replace `byteGroupIndexOutputs` function body**: Remove the inline accumulator loop, replace with `groupByByteSize` call:

```diff
 function byteGroupIndexOutputs(allItems: IndexOutput[]): { batches: BatchEntry[]; groups: IndexOutput[][] } {
-  const groups: IndexOutput[][] = [];
-  let current: IndexOutput[] = [];
-  let currentSize = 0;
-  for (const item of allItems) {
-    const size = JSON.stringify(item).length;
-    if (currentSize + size > MAX_GROUP_BYTES && current.length > 0) {
-      groups.push(current);
-      current = [item];
-      currentSize = size;
-    } else {
-      current.push(item);
-      currentSize += size;
-    }
-  }
-  if (current.length > 0) groups.push(current);
+  const groups = groupByByteSize(allItems, MAX_GROUP_BYTES);
   const batches: BatchEntry[] = groups.map((group, i) => {
     // ... batch building (unchanged)
   });
   return { batches, groups };
 }
```

**Replace inline accumulator loops in `groupIndexOutputs`** (community sub-split and overflow fallback):

```diff
-  for (const [, items] of commGroups) {
-    let current: IndexOutput[] = [];
-    let currentSize = 0;
-    for (const item of items) {
-      const size = JSON.stringify(item).length;
-      if (currentSize + size > MAX_GROUP_BYTES && current.length > 0) {
-        groups.push(current); current = [item]; currentSize = size;
-      } else { current.push(item); currentSize += size; }
-    }
-    if (current.length > 0) groups.push(current);
-  }
+  for (const [, items] of commGroups) {
+    groups.push(...groupByByteSize(items, MAX_GROUP_BYTES));
+  }

-  // overflow accumulator (same pattern)
-  let current: IndexOutput[] = [];
-  let currentSize = 0;
-  for (const item of overflow) { ... }
-  if (current.length > 0) groups.push(current);
+  groups.push(...groupByByteSize(overflow, MAX_GROUP_BYTES));
```

**Verification**:
```powershell
grep -n "currentSize + size" src/phases/analyze.ts
# Expected: zero results — all inline loops replaced
```

---

## File 5: `src/preflight.ts` (MODIFY)

**Add import**:
```typescript
import { resolveModelIdentifier } from './utils/index.js';
```

**Remove** from `models.js` import: `MODEL_REGISTRY` and `type ModelSpec` (verify no other use in this file first):
```diff
-import { MODEL_REGISTRY, type ModelSpec, FREE_FLOOR_GB, ESTIMATE_MARGIN_GB } from './models.js';
+import { FREE_FLOOR_GB, ESTIMATE_MARGIN_GB } from './models.js';
```

**Delete** `escapeRegex` function (line ~107).

**Delete** `resolveSpec` function (lines ~110–121).

**Replace** both call sites:
- In `ensureModelReady`: `resolveSpec(modelName)` → `resolveModelIdentifier(modelName)`
- In `resolveLoadedIdentifier`: `resolveSpec(modelName)` → `resolveModelIdentifier(modelName)`

**Verification**:
```powershell
grep -n "escapeRegex|resolveSpec" src/preflight.ts
# Expected: zero results
```

---

## File 6: `src/phases/dedup.ts` (MODIFY)

**Add import**:
```typescript
import { calculateSafeMaxTokens } from '../utils.js';
```

**Delete** the local `safeMaxTokens` function (lines 15–19).

**Replace** both call sites:
- Pass A: `safeMaxTokens(...)` → `calculateSafeMaxTokens(...)`
- Pass B: `safeMaxTokens(...)` → `calculateSafeMaxTokens(...)`

**Verification**:
```powershell
grep -n "function safeMaxTokens" src/phases/dedup.ts
# Expected: zero results
```

---

## Unit Tests

### `tests/unit/groupByByteSize.test.ts` (NEW)

```typescript
import { describe, it, expect } from 'vitest';
import { groupByByteSize } from '../../src/utils/index.js';

describe('groupByByteSize', () => {
  it('returns empty array for empty input', () => {
    expect(groupByByteSize([], 1000)).toEqual([]);
  });
  it('groups items that fit within the byte limit', () => {
    const items = [{ a: 1 }, { b: 2 }, { c: 3 }];
    const groups = groupByByteSize(items, 100);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual(items);
  });
  it('splits when limit exceeded', () => {
    const big = { data: 'x'.repeat(50) };
    const groups = groupByByteSize([big, big, big], 60);
    expect(groups).toHaveLength(3);
  });
  it('puts oversized single item in its own group', () => {
    const huge = { data: 'x'.repeat(500) };
    const small = { a: 1 };
    const groups = groupByByteSize([small, huge, small], 100);
    expect(groups.some(g => g.length === 1 && g[0] === huge)).toBe(true);
  });
});
```

### `tests/unit/resolveModelIdentifier.test.ts` (NEW)

```typescript
import { describe, it, expect } from 'vitest';
import { resolveModelIdentifier } from '../../src/utils/index.js';

describe('resolveModelIdentifier', () => {
  it('returns known=true for a registered model', () => {
    const { known } = resolveModelIdentifier('qwen3.6-35b-a3b');
    expect(known).toBe(true);
  });
  it('returns known=false for unrecognized model', () => {
    const { known, spec } = resolveModelIdentifier('some-custom-model');
    expect(known).toBe(false);
    expect(spec.loadKey).toBe('some-custom-model');
    expect(spec.requiredTotalGB).toBe(0);
  });
  it('identifierMatch for unknown model is case-insensitive', () => {
    const { spec } = resolveModelIdentifier('my-custom-model');
    expect(spec.identifierMatch.test('MY-CUSTOM-MODEL')).toBe(true);
    expect(spec.identifierMatch.test('other')).toBe(false);
  });
  it('escapes regex metacharacters in unknown model names', () => {
    const { spec } = resolveModelIdentifier('model.v2+special');
    expect(() => spec.identifierMatch.test('model.v2+special')).not.toThrow();
    expect(spec.identifierMatch.test('model.v2+special')).toBe(true);
    expect(spec.identifierMatch.test('modelXv2Yspecial')).toBe(false);
  });
});
```

---

## Execution Order

```
1. Test-Path src/utils/index.ts  [must be True]
2. Verify formula parity: safeMaxTokens vs calculateSafeMaxTokens
3. Create src/utils/groupByByteSize.ts
4. Create src/utils/resolveModelIdentifier.ts
5. npx tsc --noEmit  [must pass]
6. Append exports to src/utils/index.ts
7. Edit src/phases/analyze.ts
8. npx tsc --noEmit  [must pass]
9. Edit src/preflight.ts
10. Edit src/phases/dedup.ts
11. npx tsc --noEmit  [must pass]
12. npx madge --circular src/  [must be clean]
13. npx vitest run  [all tests green]
```

## Done Criteria

- [ ] Both utilities created with unit tests covering edge cases
- [ ] No inline byte-grouping accumulator loops in `analyze.ts`
- [ ] `safeMaxTokens` deleted from `dedup.ts`
- [ ] `escapeRegex` and `resolveSpec` deleted from `preflight.ts`
- [ ] `npx tsc --noEmit` passes
- [ ] `npx vitest run` passes
- [ ] `npx madge --circular src/` is clean
