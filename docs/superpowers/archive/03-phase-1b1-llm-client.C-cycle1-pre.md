# Phase 1b.1 — Unify LLM Client Abstraction
## Implementation Plan

**Version**: 1.0 — 2026-06-22
**Requires**: Phase 0 sign-off (findings confirmed by second engineer)
**Provides**: `src/llm-client.ts` (LLMClient interface + makeAbortPair); `src/lm-studio.ts` and `src/lms-rest.ts` C1/T3 compliant
**Blocks**: Phase 1b.2 — do not start until this PR's integration tests pass green

---

## Invariants This Plan Must Not Violate

| ID | Rule |
|----|------|
| C1 | No hardcoded API endpoint paths, timeout values, or model sampling params in any touched file |
| C4 | No new inline JSON parsing introduced in any file this PR touches |
| E2 | No `AbortController` instances that are not cleaned up on completion or error |
| T3 | After merge: all LLM requests go through `LLMClient`; direct `AbortController` construction outside `makeAbortPair` is prohibited |

---

## Pre-Work: Read and Inventory Current Source (MANDATORY)

Do not skip even if you believe you know the source.

### Step 0.1 — Read current source files in full

- `src/lm-studio.ts`
- `src/lms-rest.ts`
- `src/types.ts`
- `src/phases/aggregate.ts` (caller)
- `src/phases/index.ts` (caller)
- `src/phases/dedup.ts` (caller)
- `src/phases/analyze.ts` (caller)

### Step 0.2 — Inventory findings to verify

| Item | File | Expected location |
|------|------|----------|
| `AbortController` + timer | `lm-studio.ts` | Inside `callLMStudio`; external signal forwarded |
| `AbortController` + timer | `lms-rest.ts` | Inside `apiFetch`; NO external signal forwarding |
| Hardcoded endpoint | `lm-studio.ts` | Default param `'http://localhost:1234/v1/chat/completions'` |
| Hardcoded endpoint | `lms-rest.ts` | Module constant `API_BASE = 'http://localhost:1234/api/v1'` |
| Hardcoded timeout | `lm-studio.ts` | `DEFAULT_TIMEOUT_MS = 10 * 60 * 1000` |
| Hardcoded timeout | `lms-rest.ts` | `timeoutMs = 10_000` default param; `DEFAULT_LOAD_TIMEOUT_MS` |
| Caller import | all phase files | `import { callLMStudio } from '../lm-studio.js'` |
| Caller signature | all phase files | `callLMStudio(model, prompt, lmUrl, timeoutMs, numCtx, signal, maxTokens?)` |

**If any item cannot be reproduced from source, stop and raise to the team.**

---

## Files This Plan Creates or Changes

| File | Action |
|------|--------|
| `src/llm-client.ts` | **Create** — interface + config types + `makeAbortPair` |
| `src/lm-studio.ts` | **Modify** — externalize config; delegate AbortController to `makeAbortPair` |
| `src/lms-rest.ts` | **Modify** — externalize `API_BASE` + timeouts; delegate AbortController to `makeAbortPair` |

Phase module files (`src/phases/*.ts`) are **NOT touched**. Call signatures are preserved.

---

## File 1: `src/llm-client.ts` (NEW)

### 1. File Overview

Defines `LLMClientConfig`, `LLMRequest`, `LLMClient` interface, `makeAbortPair` utility, and env-read config functions. No `fetch` calls, no I/O, no imports from other `src/` files (prevents circular imports).

### 2. Change Summary

New file — ~90 lines.

### 3. Detailed Code

```typescript
// src/llm-client.ts

/**
 * All runtime-configurable values for an LLM client.
 * Values must come from environment variables or a config object — never hardcoded.
 */
export interface LLMClientConfig {
  /** Full base URL of the LLM API, e.g. http://localhost:1234/v1/chat/completions */
  baseUrl: string;
  /** Request timeout in milliseconds. Default: 600_000 (10 min) */
  timeoutMs: number;
  /** Context window size in tokens. Default: 32_000 */
  numCtx: number;
  /** Maximum tokens to generate. Undefined = model default. */
  maxTokens?: number;
  /** Temperature (0–2). Undefined = model default. */
  temperature?: number;
}

/** A single LLM completion request. */
export interface LLMRequest {
  model: string;
  prompt: string;
  /** Caller-owned abort signal. The client links this into its internal controller. */
  signal?: AbortSignal;
  /** Per-request overrides on top of LLMClientConfig. */
  overrides?: Partial<Pick<LLMClientConfig, 'maxTokens' | 'numCtx' | 'timeoutMs'>>;
}

/**
 * Unified LLM client interface.
 * Implementations must own the full AbortController lifecycle (via makeAbortPair).
 * No AbortController construction is permitted outside makeAbortPair.
 */
export interface LLMClient {
  complete(request: LLMRequest): Promise<string>;
}

/**
 * Constructs a linked AbortController that:
 * 1. Self-aborts after timeoutMs milliseconds.
 * 2. Forwards abort from an optional external signal.
 *
 * Callers MUST call cleanup() in a finally block to prevent timer leaks.
 *
 * This is the sole site in src/ where new AbortController() is constructed
 * for LLM network requests (T3 / E2 compliance).
 */
export function makeAbortPair(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = (): void => { controller.abort(); };
  externalSignal?.addEventListener('abort', forwardAbort);

  const cleanup = (): void => {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', forwardAbort);
  };

  return { controller, cleanup };
}

/**
 * Reads environment config for the LM Studio chat completions client.
 * Call once at startup; pass the result to callLMStudio or a client constructor.
 */
export function readLMStudioConfig(): LLMClientConfig {
  return {
    baseUrl: process.env['LM_STUDIO_URL'] ?? 'http://localhost:1234/v1/chat/completions',
    timeoutMs: Number(process.env['LM_STUDIO_TIMEOUT_MS'] ?? 600_000),
    numCtx: Number(process.env['LM_STUDIO_NUM_CTX'] ?? 32_000),
    maxTokens: process.env['LM_STUDIO_MAX_TOKENS'] !== undefined
      ? Number(process.env['LM_STUDIO_MAX_TOKENS'])
      : undefined,
  };
}

/** Reads environment config for the LMS REST management client. */
export function readLMSRestConfig(): Pick<LLMClientConfig, 'baseUrl' | 'timeoutMs'> {
  return {
    baseUrl: process.env['LMS_API_BASE'] ?? 'http://localhost:1234/api/v1',
    timeoutMs: Number(process.env['LMS_REST_TIMEOUT_MS'] ?? 10_000),
  };
}
```

### 4. Implementation Notes

- `makeAbortPair` is pure — no imports from other `src/` files. Prevents circular imports.
- `readLMStudioConfig`/`readLMSRestConfig` should be called once at module load in the consuming file, not per-request.
- Defaults match the original hardcoded values exactly — no behavioral change when env vars are absent.
- `LLMClientConfig` intentionally excludes retry counts — those belong to `PhaseOrchestrator` (Phase 1b.2).

### 5. Validation & Testing

- `npx tsc --noEmit` — no errors
- `npx madge --circular src/` — clean
- Unit test: call `makeAbortPair(50)`, confirm controller aborts after 50ms, cleanup removes listener

### 6. Idempotency & Safety Checks

- File does not exist — no overwrite risk
- No side effects at module load
- Revertable independently of the other two files

---

## File 2: `src/lm-studio.ts` (MODIFY)

### 1. File Overview

`callLMStudio` is the sole LLM completion entry point used by all four phase files. After this change it delegates `AbortController` lifecycle to `makeAbortPair` and sources all config from env via `readLMStudioConfig`.

**Backward-compatibility constraint**: Call signature unchanged — `callLMStudio(model, prompt, lmUrl, timeoutMs, numCtx, signal, maxTokens?)`. No changes to any phase file.

### 2. Change Summary

- Remove `DEFAULT_TIMEOUT_MS`, `DEFAULT_NUM_CTX` constants
- Add import from `./llm-client.js`
- Add `const _envDefaults = readLMStudioConfig()` (module-level)
- Replace default parameter hardcoded values with `_envDefaults.*`
- Replace inline `AbortController` block with `makeAbortPair` + single `cleanup()` per exit path
- `readStream` function: **no changes**

### 3. Detailed Code — Full File Rewrite

```typescript
// src/lm-studio.ts
import { makeAbortPair, readLMStudioConfig } from './llm-client.js';

// Read env config once at module load. Defaults match original hardcoded values.
const _envDefaults = readLMStudioConfig();

interface StreamChunk {
  choices: Array<{ delta: { content?: string }; finish_reason: string | null }>;
}

// readStream is unchanged. The try/catch JSON.parse here is a malformed SSE frame
// guard — not a C4 violation (it is not complex state-based extraction).
async function readStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  try {
    while (true) {
      if (signal.aborted) throw new Error('LM Studio request cancelled');
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6).trim();
        if (data === '[DONE]') return content;
        try {
          const chunk = JSON.parse(data) as StreamChunk;
          content += chunk.choices[0]?.delta?.content ?? '';
        } catch { /* skip malformed SSE lines */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return content;
}

export async function callLMStudio(
  model: string,
  prompt: string,
  url: string = _envDefaults.baseUrl,
  timeoutMs: number = _envDefaults.timeoutMs,
  numCtx: number = _envDefaults.numCtx,
  signal?: AbortSignal,
  maxTokens?: number,
): Promise<string> {
  if (signal?.aborted) throw new Error('LM Studio request cancelled');

  const { controller, cleanup } = makeAbortPair(timeoutMs, signal);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        thinking: { type: 'disabled' },
        reasoning_effort: 'none',
        num_ctx: numCtx,
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        cache_prompt: true,
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    cleanup();
    if (err instanceof Error && err.name === 'AbortError') {
      if (signal?.aborted) throw new Error('LM Studio request cancelled');
      throw new Error(`LM Studio request timed out after ${timeoutMs / 1000}s`);
    }
    if (err instanceof Error) {
      const cause = (err as NodeJS.ErrnoException).cause;
      const causeMsg = cause instanceof Error ? ` (${cause.message})` : '';
      throw new Error(`LM Studio connection failed${causeMsg} — is LM Studio running on ${url}?`);
    }
    throw err;
  }

  if (!res.ok) {
    cleanup();
    throw new Error(`LM Studio returned ${res.status}: ${await res.text()}`);
  }

  try {
    const raw = await readStream(res.body!, controller.signal);
    let cleaned = raw.trim();
    const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenceMatch) cleaned = fenceMatch[1].trim();
    return cleaned;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      if (signal?.aborted) throw new Error('LM Studio request cancelled');
      throw new Error(`LM Studio request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    cleanup();
  }
}
```

**Key diffs from original**:

| Original | Refactored | Reason |
|----------|-----------|--------|
| `DEFAULT_TIMEOUT_MS = 10 * 60 * 1000` | Removed → `_envDefaults.timeoutMs` | C1 |
| `DEFAULT_NUM_CTX = 32000` | Removed → `_envDefaults.numCtx` | C1 |
| `url = 'http://localhost:1234/...'` default | `url = _envDefaults.baseUrl` | C1 |
| `new AbortController()` + `setTimeout` + 3 separate cleanup branches | `makeAbortPair()` + `cleanup()` per exit path | T3/E2 |
| Fetch-catch branch missing `clearTimeout` | `cleanup()` called in all branches | Bug fix |

### 4. Implementation Notes

- Original fetch-catch branch did not call `clearTimeout` — this is a timer leak fix bundled with the refactor.
- `readStream` is NOT changed. SSE streaming behavior changes risk p99 latency regression.
- `_envDefaults` read at module load matches original behavior (constants were also module-level).

### 5. Validation & Testing

- `npx tsc --noEmit` — no new errors
- All existing integration tests pass without modification
- **p99 latency baseline**: measure 10 requests before and after; confirm within 5% (document in PR)
- Manually confirm `cleanup()` runs in all three exit paths

### 6. Idempotency & Safety Checks

- `LM_STUDIO_URL` absent → falls back to original default. No behavioral change.
- Rollback: revert this file alone; downstream callers unaffected.

---

## File 3: `src/lms-rest.ts` (MODIFY)

### 1. File Overview

LMS REST management plane client. Fixes C1 (hardcoded `API_BASE`, timeout constants) and T3 (inline `AbortController`). Does NOT add `LLMClient.complete()` — `lms-rest.ts` is a management plane, not a completion backend.

### 2. Change Summary

- Remove `API_BASE`, `DEFAULT_LOAD_TIMEOUT_MS` constants
- Add import from `./llm-client.js`
- Add `const _restDefaults = readLMSRestConfig()`
- Replace inline `AbortController` in `apiFetch` with `makeAbortPair`
- Replace all `API_BASE` / timeout references with `_restDefaults.*`

### 3. Detailed Code — Full File Rewrite

```typescript
// src/lms-rest.ts
import { runLms, estimateTotalGB } from './lms.js';
import type { LoadedModel, LoadOpts, RunLms, Lms } from './lms.js';
import { makeAbortPair, readLMSRestConfig } from './llm-client.js';

const _restDefaults = readLMSRestConfig();

interface ApiInstance {
  id: string;
  config: { context_length: number };
}

interface ApiModel {
  type: 'llm' | 'embedding';
  key: string;
  loaded_instances: ApiInstance[];
}

async function apiFetch(
  path: string,
  init: RequestInit = {},
  timeoutMs = _restDefaults.timeoutMs,
): Promise<Response> {
  const { controller, cleanup } = makeAbortPair(timeoutMs);
  try {
    return await fetch(`${_restDefaults.baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers as Record<string, string> },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`LMS REST ${path} timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    cleanup();
  }
}

async function getModels(): Promise<ApiModel[]> {
  const res = await apiFetch('/models');
  if (!res.ok) throw new Error(`GET /api/v1/models returned ${res.status}`);
  const data = await res.json() as { models: ApiModel[] };
  return data.models ?? [];
}

export async function serverStatus(
  _deps?: { runLms: RunLms },
): Promise<{ running: boolean; port: number }> {
  try {
    const res = await apiFetch('/models', {}, 3_000);
    return { running: res.ok, port: 1234 };
  } catch {
    return { running: false, port: 0 };
  }
}

export async function startServer(
  deps?: { runLms: RunLms; serverStatus(_d?: { runLms: RunLms }): Promise<{ running: boolean; port: number }> },
  pollBudgetMs = 30_000,
  pollIntervalMs = 1_000,
): Promise<void> {
  await (deps?.runLms ?? runLms)(['server', 'start']);
  const deadline = Date.now() + pollBudgetMs;
  while (Date.now() < deadline) {
    const s = deps ? await deps.serverStatus() : await serverStatus();
    if (s.running) return;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`LMS server did not report running within ${pollBudgetMs / 1000}s`);
}

export async function listLoaded(
  _deps?: { runLms: RunLms },
): Promise<LoadedModel[]> {
  const models = await getModels();
  return models
    .filter((m) => m.loaded_instances.length > 0)
    .flatMap((m) =>
      m.loaded_instances.map((inst) => ({
        identifier: m.key,
        instance_id: inst.id,
      } as LoadedModel)),
    );
}

export async function unloadAll(_deps?: { runLms: RunLms }): Promise<void> {
  const models = await getModels();
  const instanceIds = models.flatMap((m) => m.loaded_instances.map((i) => i.id));
  await Promise.all(
    instanceIds.map((instance_id) =>
      apiFetch('/models/unload', {
        method: 'POST',
        body: JSON.stringify({ instance_id }),
      }),
    ),
  );
}

export async function load(
  loadKey: string,
  opts: LoadOpts,
  _deps?: { runLms: RunLms },
): Promise<void> {
  // Load timeout override chain: opts.timeoutMs → LMS_LOAD_TIMEOUT_MS env → default REST timeout
  const timeoutMs = opts.timeoutMs
    ?? Number(process.env['LMS_LOAD_TIMEOUT_MS'] ?? _restDefaults.timeoutMs);
  const res = await apiFetch(
    '/models/load',
    {
      method: 'POST',
      body: JSON.stringify({ model: loadKey, context_length: opts.contextLength }),
    },
    timeoutMs,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`LMS load failed (${res.status}): ${body}`);
  }
}

export const lmsRest: Lms = {
  serverStatus,
  startServer,
  listLoaded,
  unloadAll,
  estimateTotalGB,
  load,
};
```

### 4. Implementation Notes

- `DEFAULT_LOAD_TIMEOUT_MS` was 10 minutes. Default `LMS_REST_TIMEOUT_MS` is 10s — much shorter. **Add `LMS_LOAD_TIMEOUT_MS=600000` to `.env.example`** to preserve the effective default for load operations.
- `port: 1234` in `serverStatus` is informational metadata, not used to construct URLs. Left as-is.

### 5. Validation & Testing

- `npx tsc --noEmit` — no new errors
- Existing tests pass without modification
- Manual: `serverStatus()` returns `{ running: true, port: 1234 }` against live LMS server
- Manual: `apiFetch` with 50ms timeout throws correct timeout error message

### 6. Idempotency & Safety Checks

- `LMS_API_BASE` absent → falls back to `'http://localhost:1234/api/v1'`. No behavioral change.
- Rollback: revert this file alone.

---

## Execution Order

```
1. Read all files listed in Step 0.1 (mandatory)
2. Confirm Step 0.2 inventory against actual source
3. Create src/llm-client.ts
4. npx tsc --noEmit  [must pass]
5. npx madge --circular src/  [must be clean]
6. Modify src/lm-studio.ts
7. npx tsc --noEmit  [must pass]
8. Modify src/lms-rest.ts
9. npx tsc --noEmit  [must pass]
10. npx madge --circular src/  [must be clean]
11. Run full integration test suite
12. Run p99 latency baseline check (SSE path)
13. Run gitnexus_detect_changes() — confirm only expected symbols affected
14. Add LMS_LOAD_TIMEOUT_MS=600000 to .env.example
```

---

## Provides Manifest

| Export | File | Description |
|--------|------|-------------|
| `LLMClient` interface | `src/llm-client.ts` | `complete(request: LLMRequest): Promise<string>` |
| `LLMClientConfig` | `src/llm-client.ts` | Config shape |
| `LLMRequest` | `src/llm-client.ts` | Request shape |
| `makeAbortPair` | `src/llm-client.ts` | Sole `AbortController` constructor for LLM requests |
| `readLMStudioConfig` | `src/llm-client.ts` | Env-read LM Studio config |
| `readLMSRestConfig` | `src/llm-client.ts` | Env-read LMS REST config |
| `callLMStudio` | `src/lm-studio.ts` | Unchanged signature; C1/T3 compliant |
| `lmsRest` | `src/lms-rest.ts` | Unchanged export; C1/T3 compliant |

**T3 is now enforced**: any PR constructing `AbortController` for LLM requests outside `makeAbortPair` is a blocker.

## Requires Manifest

| Prerequisite | Required state |
|-------------|----------------|
| Phase 0 finding validation | Signed off by second engineer |
| Phase 1a bin fix | Merged (integration tests need working CLI) |
| `src/lm-studio.ts`, `src/lms-rest.ts` | No active in-flight edits (`git status` clean) |
| Integration test suite | Green on current `master` |

## Rollback Plan

Revert all three files in one commit. Call signatures at all four phase-module call sites are unchanged.
