# Refactor Phase Empty Response Fix

**Date:** 2026-04-22
**Status:** Approved

## Problem

Phase 4 (refactor) marks batches as `completed` when the model returns `[]`. `JSON.parse("[]")` succeeds, `toMarkdown([])` writes an empty string, and the file is saved with zero content. `withRetry` never fires because no exception is thrown. 20 of 29 plans in a real run were silently empty.

Three contributing causes:
1. The prompt has no instruction for what to do when a module needs no changes — the model returns `[]` as the path of least resistance.
2. Empty arrays are accepted as valid results — the runner never rejects them.
3. Raw model responses are never logged, making malformed output (e.g. thinking-mode bleed, markdown-wrapped JSON) invisible until it causes a parse error.

## Design

### 1. Schema — `RefactorPlanEntry` (`src/types.ts`)

Add one optional field:

```ts
reason?: string
```

Present only when `change === 'NO_CHANGES_NEEDED'`. All other fields remain required as before.

### 2. Prompt — `refactorPrompt` (`src/prompts/templates.ts`)

Add to the existing instruction:

> If a module has no changes that violate the standards, return a single entry with `file` set to the module path, `change` set to `"NO_CHANGES_NEEDED"`, and `reason` explaining why (e.g. `"config-only file, no business logic"`). Set all other fields to empty strings/arrays.

The `"Return ONLY a JSON array"` instruction stays. The model always returns a non-empty array.

### 3. Runner — `src/phases/refactor.ts`

Three additions inside the `withRetry` callback, in order:

**a. Log raw response before parsing:**
```ts
logger.debug(`${batch.id} raw`, { preview: raw.slice(0, 300) });
```

**b. Reject empty arrays:**
```ts
if (parsed.length === 0) throw new Error('model returned empty array');
```
This makes `withRetry` treat empty arrays as failures and retry up to `MAX_ATTEMPTS`.

**c. Detect sentinel and write reason instead of markdown:**
```ts
const isNoOp = parsed.length === 1 && parsed[0].change === 'NO_CHANGES_NEEDED';
const content = isNoOp
  ? `<!-- NO_CHANGES_NEEDED: ${parsed[0].reason ?? 'no reason given'} -->`
  : toMarkdown(parsed);
writeFileSync(join(projectRoot, batch.output_file), content, 'utf8');
```

No-op files are always written (manifest stays consistent), but their content is a single HTML comment that is human-readable and trivially filterable downstream.

### 4. Logger — `src/logger.ts`

Add `DEBUG` level:

- Same log-file behavior as other levels (always written).
- **Stdout suppressed by default.** Only printed when `DEBUG=1` env var is set.
- Color: dim white (`\x1b[2m`).

```ts
export type LogLevel = 'INFO' | 'ERROR' | 'WARN' | 'DEBUG';
```

`Logger` type gains:
```ts
debug: (msg: string, meta?: Record<string, unknown>) => void
```

## Files Changed

| File | Change |
|------|--------|
| `src/types.ts` | Add `reason?: string` to `RefactorPlanEntry` |
| `src/prompts/templates.ts` | Update `refactorPrompt` with no-changes instruction |
| `src/phases/refactor.ts` | Log raw, reject empty, detect sentinel |
| `src/logger.ts` | Add `DEBUG` level, suppress from stdout unless `DEBUG=1` |

## Testing

- Unit test: `refactorPrompt` output contains `NO_CHANGES_NEEDED` instruction string.
- Unit test: runner throws on empty array (triggering retry path).
- Unit test: runner writes HTML comment when sentinel entry is returned.
- Unit test: `DEBUG` level writes to log file but not stdout when `DEBUG` env var is unset.
- Existing tests must continue to pass.
