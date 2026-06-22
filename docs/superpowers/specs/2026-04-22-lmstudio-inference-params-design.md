# LM Studio Inference Parameter Tuning

**Date:** 2026-04-22
**Status:** Approved

## Problem

The LM Studio client currently sends requests with no inference parameters, causing the server to use its loaded defaults — a 128K token context window and thinking enabled (when not manually disabled in the UI). For code-analyzer batches (≤8KB input), a 128K KV cache is wasteful and slows inference. Thinking must be disabled at the API level rather than relying on UI state.

## Goals

- Disable thinking via the API on every request, regardless of LM Studio UI state
- Allow the context window size to be tuned via CLI flag, defaulting to 64,000 tokens
- Thread both parameters cleanly through the existing call stack without breaking the interface

## Design

### CLI Flag

A new `--num-ctx <n>` flag is added to `src/index.ts`, parsed alongside the existing `--timeout` and `--max-batch-size` flags.

- **Default:** 64,000 (fits all current batch sizes with room to spare; the largest files are ~41KB ≈ ~10K tokens)
- **Tunable:** users can pass `--num-ctx 32000` for faster throughput on small batches, or `--num-ctx 128000` for oversized files

### `callLMStudio` Signature Change

```ts
callLMStudio(model, prompt, url?, timeoutMs?, numCtx?)
```

- `numCtx` added as the last optional parameter, default 64000
- Request body gains two new fields:
  - `thinking: { type: "disabled" }` — hardcoded, always off (confirmed working via API probe)
  - `num_ctx: numCtx` — passed through from caller

### Threading

`numCtx` flows: `index.ts` → phase runner → `callLMStudio`. The three phase runners that call LM Studio (`runIndexPhase`, `runAnalyzePhase`, `runRefactorPhase`) each accept it as a new optional parameter.

### No Changes To

- Batch sizing logic
- Manifest or discovery
- Retry/timeout behaviour

## Trade-offs

- `thinking` is hardcoded rather than a flag because enabling it for JSON extraction tasks has no benefit and would only slow inference. If a future phase needs reasoning, this can be revisited.
- 64K default is conservative — sufficient for all current files and avoids re-tuning. Users can reduce it further with the flag if throughput is the priority.
