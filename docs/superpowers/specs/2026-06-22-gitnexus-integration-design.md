# code-analyzer+ × GitNexus Integration

**Date:** 2026-06-22
**Status:** Approved for planning

---

## Overview

`code-analyzer+` is a new project forked from `code-analyzer`. It integrates GitNexus as a structural pre-processor to eliminate token waste on facts the knowledge graph already knows precisely — dependency graphs, call chains, community clusters, impact paths.

The original `code-analyzer` project is left untouched as a permanent standalone fallback.

GitNexus enrichment is strictly additive: if `.gitnexus/` is absent or any query fails, every phase falls back to the existing `code-analyzer` behavior. No existing output schemas or CLI flags change.

---

## Goals

1. **Token efficiency** — remove LLM derivation of structural fields (`dependencies`, `data_flow`) that GitNexus knows exactly.
2. **Analysis quality** — group semantically related files together in the analyze phase using community clusters instead of byte-based batching.
3. **Refactor safety & speed** — inject impact chains into refactor prompts; sort candidates by blast radius so the most impactful improvements surface first.

---

## Project Setup

### Backup / origin

`code-analyzer` stays untouched at `C:\Users\cflur\projects\code-analyzer\`.

`code-analyzer+` is created by copying `code-analyzer` (excluding `node_modules\` and `code-analysis\`) to `C:\Users\cflur\projects\code-analyzer+\`. Fresh `git init` + initial commit. All integration work happens in `code-analyzer+`.

### New dependency

```
npm install kuzu
```

`kuzu` is the Node.js client for KuzuDB, the database GitNexus writes to `.gitnexus/` in the project root.

---

## Architecture

### New file: `src/gitnexus.ts`

Single adapter layer. All KuzuDB access is isolated here. No other module imports `kuzu` directly.

Public API (all functions return `T | null` — never throw):

```typescript
export interface GitNexusContext { db: kuzu.Database; conn: kuzu.Connection; }

export async function openGitNexus(projectRoot: string): Promise<GitNexusContext | null>
export async function getFileStructure(ctx: GitNexusContext, paths: string[]): Promise<Map<string, FileStructure> | null>
export async function getCommunities(ctx: GitNexusContext): Promise<Map<string, string[]> | null>
export async function getImpact(ctx: GitNexusContext, filePath: string): Promise<ImpactResult | null>

export interface FileStructure {
  imports: string[];   // file paths this file imports
  calls: string[];     // file paths containing symbols this file calls
}

export interface ImpactResult {
  impactedPaths: string[];  // files that depend on this file (depth 1–2)
}
```

### Modified files

| File | Change |
|---|---|
| `src/index.ts` | GitNexus detection + update at startup; thread `gitNexusCtx` through phases |
| `src/gitnexus.ts` | New — KuzuDB adapter |
| `src/phases/index.ts` | Pass `gitNexusCtx` to `runIndexPhase`; call `getFileStructure` per batch |
| `src/prompts/templates.ts` | `indexPrompt()` gains optional `graphData` param; omits structural fields from LLM schema when present |
| `src/phases/analyze.ts` | Pass `gitNexusCtx` to `runAnalyzePhase`; call `getCommunities` for batch formation |
| `src/phases/refactor.ts` | Pass `gitNexusCtx` to `runRefactorPhase`; call `getImpact` per file; sort by blast radius |
| `src/prompts/templates.ts` | `refactorPrompt()` gains optional `impactChain` param; adds "Known dependents" section when present |

No changes to: `src/types.ts`, `src/manifest.ts`, `src/batcher.ts` (byte batcher kept as fallback), `src/models.ts`, `src/lm-studio.ts`, `src/retry.ts`.

---

## Startup Flow

```
index.ts (main)
  1. existsSync(join(projectRoot, '.gitnexus'))
     → YES:
         a. spawn `npx gitnexus analyze` (shell: true), await exit 0
            - non-zero exit → log warning, gitNexusCtx = null, continue
         b. openGitNexus(projectRoot)
            - returns null → log warning, gitNexusCtx = null, continue
         c. gitNexusCtx = context  (enrichment active)
     → NO:
         a. print:
            "GitNexus index not found. Run: npx gitnexus analyze
             This enables smarter batching and faster results.
             Continue without GitNexus? [y/N]"
         b. read stdin
            - Y/y → gitNexusCtx = null, continue (existing behavior)
            - N/n / default → process.exit(0)
```

`gitNexusCtx` is passed as an optional parameter to all phase runners. `null` means fallback.

---

## Enrichment Details

### Phase 1 — Index (structural field injection)

**When:** `gitNexusCtx !== null`

**Path normalization:** Before querying, all file paths must be normalized to POSIX-style paths relative to `projectRoot` (forward slashes, no leading `./`) to match how GitNexus indexes them. `gitnexus.ts` handles this normalization internally.

**Query (`getFileStructure`):**
```cypher
MATCH (f:File)-[:CodeRelation {type: 'IMPORTS'}]->(dep:File)
WHERE f.path IN $paths
RETURN f.path AS src, dep.path AS dep

MATCH (f:File)-[:CodeRelation {type: 'CALLS'}]->(sym)
WHERE f.path IN $paths
RETURN f.path AS src, sym.filePath AS dep
```

**Prompt change:** `indexPrompt(fileContents, graphData?)` — when `graphData` is provided, removes `dependencies` and `data_flow` from the LLM output schema. LLM produces only:
- `module`
- `responsibilities`
- `ui_patterns`
- `inconsistencies`
- `duplicated_logic_candidates`

**Merge:** After LLM response, inject `dependencies` and `data_flow` from graph data before writing `IndexOutput` to disk. Final `IndexOutput` shape is unchanged.

**Fallback:** `graphData` absent → existing full prompt, LLM derives all fields.

---

### Phase 2 — Analyze (community-cluster batching)

**When:** `gitNexusCtx !== null`

**Query (`getCommunities`):**
```cypher
MATCH (f:File)-[:MEMBER_OF]->(c:Community)
RETURN f.path AS filePath, c.name AS community
```

**Batch formation:** Group `IndexOutput` items by community. If a community group exceeds `MAX_GROUP_BYTES` (20 000 bytes), sub-split by bytes within the community. Files with no community assignment fall into a byte-grouped overflow batch.

**Fallback:** `gitNexusCtx` null → existing `groupIndexOutputs` byte-based logic unchanged.

---

### Phase 4 — Refactor (impact enrichment + ordering)

**When:** `gitNexusCtx !== null`

**Query (`getImpact`):**
```cypher
MATCH (f:File {path: $path})<-[:CodeRelation*1..2]-(dep)
RETURN DISTINCT dep.path AS depPath
```

**Ordering:** Sort refactor candidate files by `impactedPaths.length` descending before generating plans. Highest blast-radius files are planned first.

**Prompt change:** `refactorPrompt(standardsMd, modules, fileContents, impactChain?)` — when `impactChain` is provided, prepends a "Known dependents" section listing `impactedPaths`. LLM uses this to populate `dependencies_impacted` and `tests_to_validate` accurately.

**Fallback:** `impactChain` absent → existing prompt, LLM guesses dependencies.

---

## Error Handling

All `gitnexus.ts` functions are wrapped in try/catch and return `null` on any failure (DB open error, Cypher syntax error, schema mismatch, locked file). Callers treat `null` as "no enrichment available" and use the fallback path. GitNexus failures never propagate as thrown errors to the pipeline.

| Failure | Behavior |
|---|---|
| `.gitnexus/` exists, KuzuDB won't open | Log warning, `gitNexusCtx = null`, run proceeds |
| `npx gitnexus analyze` non-zero exit | Log warning + stderr, skip enrichment, run proceeds |
| KuzuDB query error | Return `null` for that query, phase uses fallback |
| File not in any community | Falls into byte-grouped overflow batch |
| Impact query returns nothing | Refactor prompt runs without impact section |

---

## Out of Scope

- Embedding-based semantic search (GitNexus `--embeddings` flag) — not used.
- `gitnexus wiki` generation — not used.
- Changes to `code-analyzer` (the original) — zero.
- New CLI flags on `code-analyzer+` — `--skip-gitnexus` is not added; the Y/N prompt at startup is sufficient.
- Automated `npx gitnexus analyze` on first run if `.gitnexus/` is absent — user must opt in manually.

---

## Validation & Testing

- Run `code-analyzer+` against `fcc-site` (already indexed in GitNexus) — confirm enriched index output has `dependencies` populated from graph, not LLM.
- Run against a repo with no `.gitnexus/` — confirm Y/N prompt appears and Y proceeds normally.
- Run against a repo where `npx gitnexus analyze` exits non-zero — confirm warning logged, run completes.
- Compare analyze-phase batch groupings (community vs. byte) on `fcc-site` — community groups should correlate to functional areas visible in `gitnexus://repo/fcc-site/clusters`.
- Inspect a refactor plan output — `dependencies_impacted` should match GitNexus impact chains for the same file.
