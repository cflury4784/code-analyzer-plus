# LM Studio Inference Parameters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--num-ctx` CLI flag (default 64000) and hardcode `thinking: {type: "disabled"}` in every LM Studio request.

**Architecture:** The `numCtx` value flows from CLI arg in `index.ts` → phase runners → `callLMStudio`, which adds both `num_ctx` and `thinking` to the request body. No new files needed — all changes are additive to existing signatures.

**Tech Stack:** TypeScript, Node.js, Vitest, msw (mock service worker for HTTP mocking in tests)

---

### Task 1: Update `callLMStudio` — add `numCtx` param and request fields

**Files:**
- Modify: `src/lm-studio.ts`
- Modify: `tests/unit/lm-studio.test.ts`

- [ ] **Step 1: Write failing tests for the new behaviour**

Open `tests/unit/lm-studio.test.ts` and add these two tests inside the existing `describe('callLMStudio')` block:

```ts
  it('sends thinking:disabled and num_ctx in request body', async () => {
    let capturedBody: unknown;
    server.use(
      http.post('http://localhost:1234/v1/chat/completions', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ choices: [{ message: { content: 'ok' } }] });
      })
    );
    await callLMStudio('qwen/qwen3.5-9b', 'prompt', 'http://localhost:1234/v1/chat/completions', undefined, 32000);
    expect(capturedBody).toMatchObject({
      thinking: { type: 'disabled' },
      num_ctx: 32000,
    });
  });

  it('defaults num_ctx to 64000', async () => {
    let capturedBody: unknown;
    server.use(
      http.post('http://localhost:1234/v1/chat/completions', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ choices: [{ message: { content: 'ok' } }] });
      })
    );
    await callLMStudio('qwen/qwen3.5-9b', 'prompt', 'http://localhost:1234/v1/chat/completions');
    expect(capturedBody).toMatchObject({
      thinking: { type: 'disabled' },
      num_ctx: 64000,
    });
  });
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test:run -- tests/unit/lm-studio.test.ts
```

Expected: 2 new tests FAIL (num_ctx and thinking not present in request body yet)

- [ ] **Step 3: Update `callLMStudio` signature and request body**

Replace the contents of `src/lm-studio.ts` with:

```ts
interface LMStudioResponse {
  choices: Array<{ message: { content: string } }>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_NUM_CTX = 64000;

export async function callLMStudio(
  model: string,
  prompt: string,
  url: string = 'http://localhost:1234/v1/chat/completions',
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  numCtx: number = DEFAULT_NUM_CTX
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        thinking: { type: 'disabled' },
        num_ctx: numCtx,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`LM Studio request timed out after ${timeoutMs / 1000}s`);
    }
    if (err instanceof Error) {
      const cause = (err as NodeJS.ErrnoException).cause;
      const causeMsg = cause instanceof Error ? ` (${cause.message})` : '';
      throw new Error(`LM Studio connection failed${causeMsg} — is LM Studio running on ${url}?`);
    }
    throw err;
  }
  clearTimeout(timer);

  if (!res.ok) throw new Error(`LM Studio returned ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as LMStudioResponse;
  return data.choices[0].message.content;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm run test:run -- tests/unit/lm-studio.test.ts
```

Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lm-studio.ts tests/unit/lm-studio.test.ts
git commit -m "feat: add num_ctx and thinking:disabled to LM Studio requests"
```

---

### Task 2: Thread `numCtx` through the three phase runners

**Files:**
- Modify: `src/phases/index.ts:12-18`
- Modify: `src/phases/analyze.ts:57-63`
- Modify: `src/phases/refactor.ts:55-61`

- [ ] **Step 1: Update `runIndexPhase` signature**

In `src/phases/index.ts`, change the function signature from:

```ts
export async function runIndexPhase(
  projectRoot: string,
  model: string,
  logger: ReturnType<typeof createLogger>,
  lmUrl?: string,
  timeoutMs?: number
): Promise<void> {
```

to:

```ts
export async function runIndexPhase(
  projectRoot: string,
  model: string,
  logger: ReturnType<typeof createLogger>,
  lmUrl?: string,
  timeoutMs?: number,
  numCtx?: number
): Promise<void> {
```

Then update the `callLMStudio` call in that same file from:

```ts
const raw = await callLMStudio(model, indexPrompt(fileContents), lmUrl, timeoutMs);
```

to:

```ts
const raw = await callLMStudio(model, indexPrompt(fileContents), lmUrl, timeoutMs, numCtx);
```

- [ ] **Step 2: Update `runAnalyzePhase` signature**

In `src/phases/analyze.ts`, change the function signature from:

```ts
export async function runAnalyzePhase(
  projectRoot: string,
  model: string,
  logger: ReturnType<typeof createLogger>,
  lmUrl?: string,
  timeoutMs?: number
): Promise<void> {
```

to:

```ts
export async function runAnalyzePhase(
  projectRoot: string,
  model: string,
  logger: ReturnType<typeof createLogger>,
  lmUrl?: string,
  timeoutMs?: number,
  numCtx?: number
): Promise<void> {
```

Then update the `callLMStudio` call in that same file from:

```ts
const raw = await callLMStudio(model, analyzePrompt(groupItems), lmUrl, timeoutMs);
```

to:

```ts
const raw = await callLMStudio(model, analyzePrompt(groupItems), lmUrl, timeoutMs, numCtx);
```

- [ ] **Step 3: Update `runRefactorPhase` signature**

In `src/phases/refactor.ts`, change the function signature from:

```ts
export async function runRefactorPhase(
  projectRoot: string,
  model: string,
  logger: ReturnType<typeof createLogger>,
  lmUrl?: string,
  timeoutMs?: number
): Promise<void> {
```

to:

```ts
export async function runRefactorPhase(
  projectRoot: string,
  model: string,
  logger: ReturnType<typeof createLogger>,
  lmUrl?: string,
  timeoutMs?: number,
  numCtx?: number
): Promise<void> {
```

Then update the `callLMStudio` call in that same file from:

```ts
const raw = await callLMStudio(model, refactorPrompt(standardsMd, moduleItems), lmUrl, timeoutMs);
```

to:

```ts
const raw = await callLMStudio(model, refactorPrompt(standardsMd, moduleItems), lmUrl, timeoutMs, numCtx);
```

- [ ] **Step 4: Build to verify no type errors**

```bash
npm run build
```

Expected: exits with no errors

- [ ] **Step 5: Commit**

```bash
git add src/phases/index.ts src/phases/analyze.ts src/phases/refactor.ts
git commit -m "feat: thread numCtx through phase runners to callLMStudio"
```

---

### Task 3: Add `--num-ctx` CLI flag in `index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Parse the flag and pass it to phase runners**

In `src/index.ts`, add `numCtx` alongside the existing arg parsing. After this line:

```ts
const timeoutMs: number = args['timeout'] !== undefined ? Number(args['timeout']) * 1000 : 10 * 60 * 1000;
```

Add:

```ts
const numCtx: number = args['num-ctx'] !== undefined ? Number(args['num-ctx']) : 64000;
```

Then update each phase runner call to pass `numCtx` as the last argument:

```ts
await runIndexPhase(projectRoot, model, logger, undefined, timeoutMs, numCtx);
```

```ts
await runAnalyzePhase(projectRoot, model, logger, undefined, timeoutMs, numCtx);
```

```ts
await runRefactorPhase(projectRoot, model, logger, undefined, timeoutMs, numCtx);
```

- [ ] **Step 2: Build to verify no type errors**

```bash
npm run build
```

Expected: exits with no errors

- [ ] **Step 3: Run full test suite**

```bash
npm run test:run
```

Expected: all tests PASS

- [ ] **Step 4: Smoke test the flag is accepted**

```bash
node dist/index.js --help 2>&1 || node dist/index.js --num-ctx 32000 --phase index 2>&1 | head -5
```

Expected: no "unknown option" error; process either starts or exits cleanly (LM Studio may not be running)

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: add --num-ctx CLI flag (default 64000) for LM Studio context window"
```
