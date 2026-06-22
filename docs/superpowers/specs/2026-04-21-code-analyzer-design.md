# Code Analyzer CLI — Design Spec
**Date:** 2026-04-21
**Status:** Approved

---

## Overview

A globally-installed TypeScript CLI (`code-analyzer`) that runs from the root of any project and performs a four-phase AI-assisted analysis pipeline: indexing, consistency analysis, aggregation into standards, and refactor planning.

The tool is fully resumable. All state is persisted in `<project-root>/code-analysis/manifest.json`. Every phase skips already-completed work, so the tool can be re-run safely after any failure or interruption.

---

## Goals

- Analyze any codebase for inconsistencies, duplication, and architectural drift
- Produce actionable refactor plans grounded in an auto-generated standards document
- Minimize per-call LLM context size (many small batches over few large ones)
- Never lose progress — idempotent, crash-safe, resumable at the batch level

---

## Non-Goals (v1)

- Parallel batch execution
- Web UI or progress dashboard
- Diff-based re-indexing (only changed files)
- `--claude-model` override for Phase 3
- Auto-applying refactor plans

---

## Project Structure

```
src/
  index.ts           # CLI entry point — arg parsing, phase orchestration
  manifest.ts        # Read/write manifest.json, atomic state updates
  discovery.ts       # Recursive file scan with exclusions and size filtering
  batcher.ts         # Group files into byte-bounded batches
  lm-studio.ts       # OpenAI-compatible REST client for localhost:1234
  claude-cli.ts      # Subprocess wrapper for `claude -p "..."`
  logger.ts          # Append-only logger → /code-analysis/logs/run.log
  phases/
    index.ts         # Phase 1: indexing
    analyze.ts       # Phase 2: analysis
    aggregate.ts     # Phase 3: aggregation
    refactor.ts      # Phase 4: refactor planning
  prompts/
    templates.ts     # Prompt templates per phase

dist/                # Compiled output (tsc)
tests/
  unit/
  integration/
  fixtures/          # Small sample project for integration tests
```

---

## Output Directory Structure (in target project)

```
code-analysis/
  manifest.json
  index/
    batch-001.json
    batch-002.json
    ...
  analyzer/
    group-001.json
    ...
  aggregate/
    standards.md
    refactor-strategy.md
  refactor/
    plan-001.md
    ...
  logs/
    run.log
```

---

## File Discovery

- Recursively scan project root
- **Excluded:** `node_modules`, `.git`, `dist`, `build`, `out`, `coverage`, `code-analysis`
- **Size limit:** files > 500KB are logged and skipped (`skip_reason: "size_exceeded"`)
- Results stored in `manifest.json` under `files[]`

---

## Manifest Schema

```json
{
  "version": 1,
  "created": "2026-04-21T00:00:00Z",
  "last_run": "2026-04-21T00:00:00Z",
  "project_root": "/absolute/path/to/project",
  "files": [
    {
      "path": "relative/path/to/file.ts",
      "size_bytes": 4200,
      "skipped": false,
      "skip_reason": null
    }
  ],
  "batches": {
    "index": [
      {
        "id": "batch-001",
        "files": ["src/components/Button.tsx", "src/components/Modal.tsx"],
        "size_bytes": 48200,
        "status": "completed",
        "attempts": 1,
        "completed_at": "2026-04-21T00:01:00Z",
        "output_file": "code-analysis/index/batch-001.json"
      }
    ],
    "analyze": [],
    "refactor": []
  },
  "phases": {
    "index": "completed",
    "analyze": "pending",
    "aggregate": "pending",
    "refactor": "pending"
  }
}
```

**Write discipline:** every status change flushes manifest to disk immediately. No buffering. A crash mid-batch leaves the batch as `pending`, never corrupt.

---

## Startup Logic

1. Check for `<project-root>/code-analysis/manifest.json`
2. **Missing** → run discovery, create manifest, proceed with phases
3. **Present + `--resume` or no `--phase`** → load manifest, skip completed batches
4. **Present + explicit `--phase` without `--resume`** → re-run that phase from scratch (reset phase status to `pending`)

---

## Phase 1: Indexing

**Model:** LM Studio `qwen/qwen3.5-9b` via REST (`localhost:1234/v1/chat/completions`)

**Batching:**
- Group files by accumulated byte size
- Default max batch size: 50,000–60,000 bytes
- Files exceeding the limit are processed individually
- Batch definitions stored in `manifest.batches.index`

**Execution:**
- Iterate batches sequentially
- Skip batches with `status: "completed"`
- POST prompt + file contents to LM Studio
- Validate response JSON against schema
- Write to `code-analysis/index/batch-XXX.json`
- Mark batch `completed` in manifest immediately on success

**Retry:** up to 2 retries (3 total attempts) with exponential backoff on failure. After 3rd failure: mark `failed`, log error, continue to next batch.

**Output schema per file:**
```json
{
  "module": "user-profile/page.tsx",
  "responsibilities": ["renders profile UI", "handles avatar upload"],
  "ui_patterns": ["modal", "form", "button.primary"],
  "data_flow": ["fetchUser()", "updateUser()"],
  "dependencies": ["api/user.ts", "components/Button.tsx"],
  "duplicated_logic_candidates": [
    { "description": "form validation logic", "similar_to": ["settings/page.tsx"] }
  ],
  "inconsistencies": [
    { "type": "UI", "issue": "Uses custom button instead of shared Button component" }
  ]
}
```

---

## Phase 2: Analysis

**Model:** LM Studio `qwen/qwen3.5-9b` (default) or `gemma-4-e4b` via `--model-override`

**Input:** all `index/batch-XXX.json` outputs

**Grouping:** accumulate index outputs into groups ≤ 80KB by JSON size

**Output per group:** `code-analysis/analyzer/group-XXX.json`
```json
{
  "duplication_clusters": [],
  "ui_inconsistencies": [],
  "architecture_inconsistencies": [],
  "candidate_shared_components": [],
  "candidate_utility_functions": []
}
```

**Retry/error policy:** same as Phase 1.

---

## Phase 3: Aggregation

**Model:** `claude` CLI subprocess (`claude -p "<prompt>"`)

**Input:** all `analyzer/group-XXX.json` outputs

**Chunking:** if combined analyzer output exceeds 100KB, split into ≤100KB chunks. Run `claude -p "<prompt>"` once per chunk, capturing stdout from each. Concatenate all responses before extracting `standards.md` and `refactor-strategy.md` content.

**Execution:** shell out to `claude` CLI once per chunk, capture and concatenate stdout

**Output:**
- `code-analysis/aggregate/standards.md` — opinionated codebase standards document
- `code-analysis/aggregate/refactor-strategy.md` — high-level refactor strategy

**Error policy:** no automatic retry. On failure, log error and halt. User re-runs with `--phase=aggregate`.

---

## Phase 4: Refactor Planning

**Model:** LM Studio `qwen/qwen3.5-9b`

**Input:** `standards.md` + module subsets grouped by feature/directory/dependency cluster

**Output per group:** `code-analysis/refactor/plan-XXX.md`

Each plan entry includes:
- File path
- Exact change description
- Before/after pattern
- Dependencies impacted
- Tests to validate

**Retry/error policy:** same as Phase 1.

---

## CLI Interface

```bash
# Run full pipeline (discovery + all 4 phases), resume if manifest exists
code-analyzer

# Run a single phase
code-analyzer --phase=index
code-analyzer --phase=analyze
code-analyzer --phase=aggregate
code-analyzer --phase=refactor

# Resume a phase (skip completed batches)
code-analyzer --phase=analyze --resume

# Overrides
code-analyzer --max-batch-size=40000
code-analyzer --model-override=gemma-4-e4b
```

**`--model-override` scope:** replaces the LM Studio model for Phases 1, 2, and 4. Phase 3 always uses the `claude` CLI.

---

## Logging

All activity appended to `code-analysis/logs/run.log`:

```
[2026-04-21T00:01:00Z] [INFO]  Phase 1 started | model=qwen/qwen3.5-9b
[2026-04-21T00:01:05Z] [INFO]  batch-001 completed | files=12 size_bytes=48200
[2026-04-21T00:01:10Z] [ERROR] batch-002 failed (attempt 1/3) | error=connection refused
[2026-04-21T00:01:15Z] [INFO]  batch-002 completed (attempt 2/3)
[2026-04-21T00:02:00Z] [INFO]  Phase 1 completed | batches=24 failed=0
```

Fields per line: timestamp, level, event, relevant metadata (batch ID, model, file count, error message).

---

## Error Handling Summary

| Scenario | Behavior |
|---|---|
| Batch LLM call fails | Retry up to 2× (3 total); mark `failed` on exhaustion; continue |
| JSON validation fails | Treat as LLM failure, retry |
| File > 500KB | Skip, log, continue |
| Phase 3 Claude CLI fails | Log, halt pipeline |
| Any phase fails | Downstream phases do not run |
| Crash mid-batch | Batch stays `pending`; safe to resume |

---

## Package Configuration

```json
{
  "name": "code-analyzer",
  "version": "0.1.0",
  "bin": { "code-analyzer": "./dist/index.js" },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "test": "vitest"
  }
}
```

**Install:** `npm install -g code-analyzer`
**Runtime requirement:** Node.js 20+, LM Studio running on `localhost:1234`, `claude` CLI installed and authenticated

---

## Testing Strategy

**Unit tests** (vitest):
- `batcher.ts` — byte boundary logic, oversized file handling
- `manifest.ts` — create, read, update, atomic write behavior
- `discovery.ts` — exclusion rules, size filtering

**Integration tests:**
- Fixture project (small set of `.ts` files in `tests/fixtures/`)
- Phase 1 against mocked LM Studio server (msw)
- Manifest state transitions across a full run

**Manual smoke test:**
- Install globally, run against a real project with LM Studio running
- Verify all four output directories populated correctly
- Kill mid-run, re-run with `--resume`, verify no duplicate work
