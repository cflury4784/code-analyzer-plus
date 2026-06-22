# code-analyzer

A globally-installed CLI that runs a five-phase AI-assisted analysis pipeline on any codebase: indexing, consistency analysis, deduplication, standards aggregation, and refactor planning.

All phases use LM Studio's local REST API — no cloud APIs required. State is persisted in `code-analysis/manifest.json`. Every phase skips already-completed work, so the tool is safe to re-run or resume after any interruption.

---

## Requirements

- Node.js 20+
- [LM Studio](https://lmstudio.ai) 0.3.x+ with the REST API enabled (`localhost:1234`)
- A loaded model — default: `qwen3.6-35b-a3b@q3_k_s`

The preflight step handles loading the model automatically if it is not already running.

---

## Installation

```bash
git clone <repo>
cd code-analyzer
npm install
npm run build
npm install -g .
```

---

## Usage

Run from the root of any project:

```bash
code-analyzer
```

Runs all five phases sequentially. If `code-analysis/manifest.json` exists, completed batches are skipped automatically.

```bash
code-analyzer --resume
```

Same as above — `--resume` is accepted as an explicit flag but the default behavior is already resumable.

---

## Phases

| Phase | Name | Output |
|-------|------|--------|
| 1 | Index | `code-analysis/index/batch-XXX.json` |
| 2 | Analyze | `code-analysis/analyzer/group-XXX.json` |
| 2.5 | Dedup | `code-analysis/dedup/partial-XXX.json`, `findings.json` |
| 3 | Aggregate | `code-analysis/aggregate/standards.md`, `refactor-strategy.md` |
| 4 | Refactor Plan | `code-analysis/refactor/plan-XXX.md` |

All phases call LM Studio. No external CLI dependencies.

**Context budget:** every LM call computes `max_tokens = floor(numCtx × 0.85) − estimated_input_tokens` (via `calculateSafeMaxTokens` in `src/utils.ts`) so the model always finishes within the context window. Truncated or malformed responses are retried up to 3×.

**Phase 2.5 (Dedup):** runs two passes. Pass A deduplicates analysis groups in parallel batches. Pass B merges the partials using a hierarchical pair-merge loop so no single call exceeds the context budget regardless of how many partials were produced.

---

## Output Directory

```
code-analysis/
  manifest.json
  index/
    batch-001.json
    ...
  analyzer/
    group-001.json
    ...
  dedup/
    partial-001.json
    ...
    findings.json
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

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--phase=<name>` | (all) | Run only `index`, `analyze`, `dedup`, `aggregate`, or `refactor` |
| `--resume` | false | Explicit resume flag — behavior is identical to a plain re-run |
| `--max-batch-size=<bytes>` | 8000 | Max bytes per index batch (Phase 1) — default is `BATCH_SIZE_LIMIT_BYTES` in `config/constants.ts` |
| `--model-override=<id>` | `qwen3.6-35b-a3b` | LM Studio model identifier |
| `--num-ctx=<tokens>` | 32000 | Context window size passed to the model |
| `--timeout=<seconds>` | 600 | Per-request timeout |
| `--skip-preflight` | false | Skip model load check — use if model is already loaded externally |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DEBUG=1` | Print debug-level log lines to stdout (response previews, etc.) — always written to `run.log` |

---

## Common Workflows

**Full run from scratch:**
```bash
code-analyzer
```

**Resume after interruption** (completed batches skipped automatically):
```bash
code-analyzer --resume
```

**Re-run a single phase from scratch:**
```bash
code-analyzer --phase=analyze
```

**Resume a specific phase:**
```bash
code-analyzer --phase=analyze --resume
```

**Use a different model:**
```bash
code-analyzer --model-override=qwen2.5-coder-14b
```

**Larger context window:**
```bash
code-analyzer --num-ctx=64000
```

**Debug LM responses:**
```bash
DEBUG=1 code-analyzer --phase=refactor
```

---

## What Gets Scanned

All files under the project root, recursively.

**Excluded directories:** `node_modules`, `.git`, `dist`, `build`, `out`, `coverage`, `code-analysis`, `.next`, `.nuxt`, `.turbo`, `.cache`, `__pycache__`, `.venv`, `venv`, `.svelte-kit`, `tmp`, `temp`

**Excluded files:** lock files (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, etc.), source maps (`.map`), minified files (`.min.js`, `.min.css`), snapshots (`.snap`)

**Size limit:** files over `FILE_SIZE_LIMIT_BYTES` (100 KB, defined in `config/constants.ts`) are skipped during discovery — they tend to be generated or too token-dense for a local model context window.

---

## Development

```bash
npm install
npm run dev      # run via tsx (no build needed)
npm test         # run test suite (95 tests across 12 files)
npm run build    # compile to dist/
```

**Tuning constants:** `config/constants.ts` is the single source of truth for size limits. Edit `FILE_SIZE_LIMIT_BYTES` to change the file-read gate, or `BATCH_SIZE_LIMIT_BYTES` to change the prompt-batching budget; both are imported by their respective modules automatically.

**Prompt schema version:** `src/prompts/templates.ts` exports `SCHEMA_VERSION = 'v1'`. Increment this when any prompt's output contract (field names or types) changes, so callers can detect incompatible outputs.

---

## Utility Scripts

One-off Python scripts for modifying an existing `manifest.json` (e.g., to retroactively skip directories after a run has started). All accept the manifest path as their first argument and share a common filter factory from `batch_filter.py`.

```bash
python patch_manifest2.py path/to/manifest.json   # exclude docs/, scripts/mobile-validation/
python patch_manifest3.py path/to/manifest.json   # exclude .superpowers/, .claude/, .vercel/, etc.
python patch_manifest4.py path/to/manifest.json   # exclude lib/db/migrations/meta/, .DS_Store
python list_dirs.py path/to/manifest.json         # print top-level directory counts
```
