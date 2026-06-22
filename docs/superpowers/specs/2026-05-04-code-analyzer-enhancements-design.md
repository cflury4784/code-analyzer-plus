# Code Analyzer Enhancements — Design Spec

**Date:** 2026-05-04  
**Status:** Approved

---

## Background

A review of the analyzer's output on the voyagedesk project identified six gaps that reduce the actionability of final recommendations:

1. Every finding is equally weighted — no severity or frequency signal
2. Doc/archive `.md` files leak into the index, polluting findings with non-source references
3. Analyzer groups run independently, so the same issue is flagged multiple times across groups with no deduplication
4. Before/After blocks in refactor plans contain paraphrased pseudo-code rather than verbatim source lines
5. Candidate component/utility proposals have no proposed TypeScript signatures
6. NO_CHANGES_NEEDED entries are opaque HTML comments with no structured content

This spec describes enhancements to address all six.

---

## Pipeline Overview

The new pipeline adds Phase 2.5 (Dedup) and changes what data flows between existing phases:

```
Phase 1 — Index      (LM Studio)   file content → IndexOutput per batch
Phase 2 — Analyze    (LM Studio)   IndexOutput groups → AnalysisOutput per group  [+severity, +signatures]
Phase 2.5 — Dedup    (LM Studio)   all AnalysisOutput groups → DedupOutput         [NEW — two-pass batched]
Phase 3 — Aggregate  (Claude CLI)  DedupOutput → standards.md + refactor-strategy.md
Phase 4 — Refactor   (LM Studio)   IndexOutput + raw file content → RefactorPlan   [+verbatim code]
```

**Key flow changes:**
- Phase 3 reads a single `code-analysis/dedup/findings.json` instead of all group files
- Phase 4 receives raw file content alongside index summaries
- `.md` files are excluded at the discovery layer before Phase 1

---

## 1. Discovery — Doc File Exclusion

**File:** `src/discovery.ts`

Add `.md` to `EXCLUDED_EXTENSIONS`. Markdown files are documentation; the refactor phase should never act on them. This is the correct layer — stripping before batching means no downstream phase ever sees them.

No CLI flag needed. This is unconditional.

---

## 2. Type System Changes

**File:** `src/types.ts`

### 2.1 Replace inline shapes in `AnalysisOutput`

Extract `Finding` and `Candidate` interfaces:

```typescript
export interface Finding {
  description: string;
  files: string[];
  severity: 'high' | 'medium' | 'low';
  severity_rationale: string;
  occurrence_count: number;
}

export interface Candidate {
  name: string;
  rationale: string;
  files: string[];
  proposed_signature: string;
}

export interface AnalysisOutput {
  duplication_clusters: Finding[];
  ui_inconsistencies: Finding[];
  architecture_inconsistencies: Finding[];
  candidate_shared_components: Candidate[];
  candidate_utility_functions: Candidate[];
}
```

### 2.2 Add `DedupOutput`

```typescript
export interface DedupFinding extends Finding {
  convergence_count: number;
}

export interface DedupOutput {
  duplication_clusters: DedupFinding[];
  ui_inconsistencies: DedupFinding[];
  architecture_inconsistencies: DedupFinding[];
  candidate_shared_components: Candidate[];
  candidate_utility_functions: Candidate[];
}
```

### 2.3 Update `RefactorPlanEntry`

```typescript
export interface RefactorPlanEntry {
  file: string;
  change: string;
  before: string;
  before_lines?: string;          // 1-indexed, e.g. "47-52"; "NEEDS_VERIFICATION" if not found
  after: string;
  dependencies_impacted: string[];
  tests_to_validate: string[];
  // NO_CHANGES_NEEDED fields (mutually exclusive with change/before/after)
  verdict?: 'no_violations';
  checks_performed?: string[];
  confidence?: 'high' | 'medium' | 'low';
  note?: string;
}
```

### 2.4 Update `Manifest`

Add `dedup` to `phases` and `batches`:

```typescript
phases: {
  index: PhaseStatus;
  analyze: PhaseStatus;
  dedup: PhaseStatus;       // new
  aggregate: PhaseStatus;
  refactor: PhaseStatus;
};
batches: {
  index: BatchEntry[];
  analyze: BatchEntry[];
  dedup: BatchEntry[];      // new — tracks partial dedup batches
  refactor: BatchEntry[];
};
```

The dedup partial files write to `code-analysis/dedup/partial-NNN.json`. The final merged output writes to `code-analysis/dedup/findings.json` (not a BatchEntry — written after Pass B completes).

**Backward compatibility:** `readManifest` must initialize missing fields when loading manifests created before this change: `phases.dedup` defaults to `'pending'`, `batches.dedup` defaults to `[]`.

---

## 3. Prompt Changes

**File:** `src/prompts/templates.ts`

### 3.1 `analyzePrompt` — severity, occurrence count, proposed signatures

Update the schema section to require the new fields on every finding and candidate:

```
For each finding (duplication_clusters, ui_inconsistencies, architecture_inconsistencies):
- "severity": "high" | "medium" | "low"
    high   = affects multiple features or is a correctness/data risk
    medium = inconsistent UX or meaningful maintainability debt
    low    = style or naming only
- "severity_rationale": one sentence explaining the rating
- "occurrence_count": estimated number of call sites or instances across the codebase

For each candidate (candidate_shared_components, candidate_utility_functions):
- "proposed_signature": TypeScript function or component signature you recommend.
    Quote actual type names you see in the summaries.
    Write "NEEDS_VERIFICATION" if you cannot determine the signature from the summaries.
```

### 3.2 `deduplicatePrompt` — new function

Two variants: one for Pass A (batch dedup), one for Pass B (merge).

**Pass A instruction:**
```
You are a code architect. Deduplicate these analysis findings from one batch of groups.
Merge findings that share the same root cause (≥2 shared files OR same description intent).
- Combine file lists, take the higher severity, set convergence_count to number of groups that flagged it.
- Keep single-group findings (convergence_count: 1).
- Do NOT invent new findings.
- Sort each category: severity desc, then convergence_count desc.
Return a single JSON object matching the DedupOutput schema.
```

**Pass B instruction:**
```
You are a code architect. Merge these partially-deduplicated analysis reports into one final report.
Apply the same dedup rules: merge on shared root cause, combine file lists, take higher severity,
sum convergence_counts. Sort: severity desc, convergence_count desc.
Return a single JSON object matching the DedupOutput schema.
```

### 3.3 `aggregatePrompt` — use convergence and severity for ordering

Add to the prompt:
```
The input is a single deduplicated findings object. Each finding has:
- convergence_count: how many independent analysis passes flagged it (higher = more certain)
- severity: high | medium | low

When producing refactor-strategy.md:
- Order phases by severity desc, then convergence_count desc within each severity tier.
- Call out findings with convergence_count > 1 as "confirmed cross-cutting" issues.
```

### 3.4 `refactorPrompt` — verbatim code + structured NO_CHANGES_NEEDED

Add a `File Contents` section to the prompt after File Summaries:

```
File Contents:
=== path/to/file.ts ===
[raw source]

=== path/to/other.ts ===
[raw source]
```

Add to instructions:
```
For "before" and "after" fields: quote verbatim lines from the File Contents above.
Set "before_lines" to the line range you are quoting (e.g. "47-52").
If you cannot locate the exact lines, set before_lines to "NEEDS_VERIFICATION".
Do NOT paraphrase or invent code. Use exact source text.

For files with no standards violations, return a structured entry:
{
  "file": "path",
  "verdict": "no_violations",
  "checks_performed": ["list of standards checked"],
  "confidence": "high" | "medium" | "low",
  "note": "one sentence explaining why no changes are needed"
}
```

---

## 4. Phase 2.5 — Dedup (`src/phases/dedup.ts`)

New file. Structure mirrors `phases/aggregate.ts`.

### Pass A — Batch dedup

1. Load all completed `analyzer/group-NNN.json` files
2. Pack into batches using `MAX_GROUP_BYTES` (same limit as analyze phase)
3. For each batch: call LM Studio with `deduplicatePrompt` (Pass A variant)
4. Write partial to `code-analysis/dedup/partial-NNN.json`
5. Track in `manifest.batches.dedup`

### Pass B — Merge

1. Load all completed `dedup/partial-NNN.json` files
2. Send all partials in one call to LM Studio with `deduplicatePrompt` (Pass B variant)
3. Write final output to `code-analysis/dedup/findings.json`
4. Set `manifest.phases.dedup = 'completed'`

Phase skips entirely if `manifest.phases.dedup === 'completed'`.

---

## 5. Phase 3 — Aggregate Changes (`src/phases/aggregate.ts`)

- Read `code-analysis/dedup/findings.json` instead of iterating all `analyzer/group-NNN.json` files
- Gate on `manifest.phases.dedup === 'completed'`; throw if not
- Remove the chunking loop — single input, single Claude CLI call
- Pass the `DedupOutput` object to `aggregatePrompt`

---

## 6. Phase 4 — Refactor Changes (`src/phases/refactor.ts`)

### File content injection

`buildRefactorGroups` returns both `IndexOutput[]` and a `Map<string, string>` of `module → raw source`. Raw source is loaded with `readFileSync` for each module path at group-build time, skipping files that are missing or exceed `MAX_BYTES`.

`runRefactorPhase` passes the file content map to `refactorPrompt` as the `File Contents` section. Files are serialized as `=== path ===\n[content]` blocks, matching the format used in `indexPrompt`.

### `toMarkdown` — structured NO_CHANGES_NEEDED rendering

Verdict entries render as a single compact line:

```
## path/to/file.ts

✓ No violations — [note] (confidence: high | checks: duplication, naming, error_handling)
```

Full plan entries render unchanged (Change / Before / After / Dependencies / Tests sections).

---

## Files Changed

| File | Change |
|---|---|
| `src/discovery.ts` | Add `.md` to `EXCLUDED_EXTENSIONS` |
| `src/types.ts` | Add `Finding`, `Candidate`, `DedupFinding`, `DedupOutput`; update `AnalysisOutput`, `RefactorPlanEntry`, `Manifest` |
| `src/prompts/templates.ts` | Update `analyzePrompt`, `aggregatePrompt`, `refactorPrompt`; add `deduplicatePrompt` |
| `src/manifest.ts` | Handle new `phases.dedup` and `batches.dedup` fields |
| `src/phases/dedup.ts` | New file — two-pass batched dedup |
| `src/phases/aggregate.ts` | Read from `dedup/findings.json`, remove chunking loop |
| `src/phases/refactor.ts` | Load raw file content, inject into prompt, update `toMarkdown` |
| `src/index.ts` | Wire Phase 2.5 between analyze and aggregate |

---

## Out of Scope

- Changes to the index prompt schema (already captures sufficient detail)
- UI or reporting layer (plain file outputs are sufficient)
- LM Studio model selection (unchanged)
