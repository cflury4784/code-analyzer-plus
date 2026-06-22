# code-analyzer+

A local, LLM-powered codebase analysis and refactor-planning tool. Runs a five-phase pipeline against any TypeScript/JavaScript project and produces a structured refactor plan grounded in your own coding standards.

Extends [code-analyzer](https://github.com/cflury4784/code-analyzer) with optional **GitNexus** integration — when a `.gitnexus/` knowledge graph is present, the pipeline uses structural graph data to group related files together, inject accurate dependency lists, and surface blast-radius context in every refactor prompt.

---

## Prerequisites

- **Node.js 20+**
- **[LM Studio](https://lmstudio.ai)** running locally with a supported model loaded (see [Models](#models))
- **GitNexus** *(optional, but recommended)* — `npm install -g gitnexus` — enables graph-enriched analysis

---

## Installation

```bash
git clone https://github.com/cflury4784/code-analyzer-plus
cd code-analyzer+
npm install
npm run build
```

To use as a global CLI:

```bash
npm link
```

---

## Quick Start

Navigate to the project you want to analyze, then run:

```bash
cd /path/to/your/project
node /path/to/code-analyzer+/dist/index.js
```

Or if installed globally:

```bash
cd /path/to/your/project
code-analyzer
```

On first run, the tool:
1. Checks for a `.gitnexus/` index in the target project — prompts to continue without it if absent
2. Verifies LM Studio is running and the model is loaded (auto-loads if needed)
3. Discovers source files and creates `code-analysis/manifest.json`
4. Runs all five phases sequentially, writing results to `code-analysis/`

---

## GitNexus Enrichment

If the target project has been indexed by GitNexus (`npx gitnexus analyze`), code-analyzer+ automatically:

- **Refreshes the index** before the pipeline starts (`npx gitnexus analyze`)
- **Index phase** — injects graph-derived `dependencies` (actual import paths from the AST) into each file's index entry instead of asking the LLM to infer them
- **Analyze phase** — groups files by their community cluster (modules that import each other heavily) instead of naive byte-size grouping; related files are analyzed together, improving cross-file pattern detection
- **Refactor phase** — fetches the reverse-dependency graph for each batch and injects a "Known dependents" section into each prompt so the LLM accounts for downstream impact

Without a `.gitnexus/` index, the tool falls back to the original behavior: byte-based batching, LLM-inferred dependencies, no impact context. The fallback is transparent — no features are removed, only enrichment is skipped.

### First-time GitNexus setup for a target project

```bash
cd /path/to/your/project
npm install -g gitnexus   # if not already installed
npx gitnexus analyze
```

Then run code-analyzer+ — it picks up the index automatically.

---

## Pipeline Phases

| Phase | Output | What happens |
|---|---|---|
| **1 — Index** | `code-analysis/index/` | Each file is summarized: responsibilities, UI patterns, duplication candidates, inconsistencies. With GitNexus: accurate `dependencies` injected from the import graph. |
| **2 — Analyze** | `code-analysis/analyzer/` | Index entries are grouped and cross-analyzed for patterns, shared anti-patterns, and architectural inconsistencies. With GitNexus: files grouped by community cluster. |
| **2.5 — Dedup** | `code-analysis/dedup/` | Duplicate findings across analyze batches are merged and deduplicated. |
| **3 — Aggregate** | `code-analysis/aggregate/` | All findings consolidated into a single ranked summary. |
| **4 — Refactor** | `code-analysis/refactor/` | Per-file refactor plans generated against your `standards.md`. With GitNexus: "Known dependents" section added to each prompt so impact is considered. |

Results accumulate in `code-analysis/` inside the target project. Logs are written to `code-analysis/logs/run.log`.

---

## CLI Flags

```
--model-override <name>   Use a specific model key (default: qwen3.6-35b-a3b)
--phase <name>            Run only one phase: index | analyze | dedup | aggregate | refactor
--resume                  Resume an in-progress phase (skip completed batches)
--max-batch-size <bytes>  Max bytes per index batch (default: 8000)
--timeout <seconds>       Per-batch LLM timeout (default: 600)
--num-ctx <tokens>        Context window size (default: 32000)
--skip-preflight          Skip LM Studio model-ready check
--version / -v            Print version and exit
```

### Examples

Run only the refactor phase (assumes index/analyze/dedup/aggregate are done):

```bash
node dist/index.js --phase refactor
```

Resume a failed index phase:

```bash
node dist/index.js --phase index --resume
```

Use a smaller model with a tighter context window:

```bash
node dist/index.js --model-override qwen/qwen3.5-9b --num-ctx 16000
```

---

## Models

The tool uses LM Studio's local inference API. Supported model keys:

| Key | Quant | Min RAM |
|---|---|---|
| `qwen3.6-35b-a3b` *(default)* | Q3_K_S | 30 GB |
| `qwen3.6-27b-mtp` | Q3_K_M | 24 GB |
| `qwen/qwen3.5-9b` | — | 18 GB |

At startup, the tool checks whether the model is loaded in LM Studio and loads it automatically if not. Ensure LM Studio's local server is running on port 1234 (the default).

---

## Output Structure

```
code-analysis/
├── manifest.json          # pipeline state — batch tracking and phase status
├── logs/
│   └── run.log
├── index/
│   └── batch-001.json     # per-file summaries
├── analyzer/
│   └── group-001.json     # cross-file analysis
├── dedup/
│   └── dedup-001.json
├── aggregate/
│   └── summary.json
└── refactor/
    └── plan-001.md        # refactor plans (one per analyze group)
```

Each refactor plan entry includes:
- `file` — relative path
- `change` — exact description of what to change
- `before` / `after` — verbatim lines from the source
- `before_lines` — 1-indexed line range
- `dependencies_impacted` — files the change may affect
- `tests_to_validate` — suggested test cases

Files with no violations produce a `no_violations` entry with a confidence rating.

---

## Standards File

The refactor phase looks for a `standards.md` in the target project root. This file defines your coding standards — naming conventions, architectural rules, patterns to enforce or avoid. If absent, the LLM uses general best practices.

Example `standards.md` excerpt:

```markdown
# Standards

- No default exports — use named exports only
- All async functions must have explicit return types
- React components: props interface declared above the component
- No inline styles — use CSS modules or Tailwind only
```

---

## Resuming a Run

The manifest tracks the status of every batch. If a run is interrupted:

```bash
node dist/index.js --resume
```

This skips completed batches and retries failed ones. To reset a specific phase and re-run it from scratch:

```bash
node dist/index.js --phase analyze
```

(Omitting `--resume` resets the phase before running it.)

---

## Development

```bash
npm run dev        # run via tsx (no build step)
npm test           # vitest in watch mode
npm run test:run   # single test run
npm run build      # tsc compile to dist/
```
