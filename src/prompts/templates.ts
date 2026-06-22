import type { AnalysisOutput, DedupOutput, IndexOutput } from '../types.js';

/**
 * Schema version for all prompt templates in this module.
 * Increment when a prompt's output contract (field names, types) changes.
 */
export const SCHEMA_VERSION = 'v1';

/** @schemaVersion v1 — Output contract: IndexOutput[] */
export function indexPrompt(fileContents: Array<{ path: string; content: string }>): string {
  const block = fileContents.map(f => `=== ${f.path} ===\n${f.content}`).join('\n\n');
  return `Analyze each source file below. Return a JSON array where each element has this exact schema:
{
  "module": "relative/path",
  "responsibilities": ["string"],
  "ui_patterns": ["string"],
  "data_flow": ["string"],
  "dependencies": ["relative/path"],
  "duplicated_logic_candidates": [{"description": "string", "similar_to": ["path"]}],
  "inconsistencies": [{"type": "UI|architecture|naming", "issue": "string"}]
}
Rules: Be concise. Each array: maximum 5 items, one short phrase each. Return ONLY a JSON array. No explanation.

${block}`;
}

/** @schemaVersion v1 — Output contract: AnalysisOutput */
export function analyzePrompt(indexItems: unknown[]): string {
  return `You are a code architect. Analyze these file summaries and identify cross-cutting patterns.
Return a single JSON object with this exact schema:
{
  "duplication_clusters": [{"description": "string", "files": ["path"], "severity": "high|medium|low", "severity_rationale": "string", "occurrence_count": N}],
  "ui_inconsistencies": [{"description": "string", "files": ["path"], "severity": "high|medium|low", "severity_rationale": "string", "occurrence_count": N}],
  "architecture_inconsistencies": [{"description": "string", "files": ["path"], "severity": "high|medium|low", "severity_rationale": "string", "occurrence_count": N}],
  "candidate_shared_components": [{"name": "string", "rationale": "string", "files": ["path"], "proposed_signature": "string"}],
  "candidate_utility_functions": [{"name": "string", "rationale": "string", "files": ["path"], "proposed_signature": "string"}]
}

Severity guide:
  high   = affects multiple features or is a correctness/data risk
  medium = inconsistent UX or meaningful maintainability debt
  low    = style or naming only

For proposed_signature: quote actual type names you see in the summaries.
Write "NEEDS_VERIFICATION" if the signature cannot be determined from the summaries.
Return ONLY JSON. No explanation.

${JSON.stringify(indexItems, null, 2)}`;
}

const DEDUP_SCHEMA = `{
  "duplication_clusters": [{"description": "string", "files": ["path"], "severity": "high|medium|low", "severity_rationale": "string", "occurrence_count": N, "convergence_count": N}],
  "ui_inconsistencies": [{"description": "string", "files": ["path"], "severity": "high|medium|low", "severity_rationale": "string", "occurrence_count": N, "convergence_count": N}],
  "architecture_inconsistencies": [{"description": "string", "files": ["path"], "severity": "high|medium|low", "severity_rationale": "string", "occurrence_count": N, "convergence_count": N}],
  "candidate_shared_components": [{"name": "string", "rationale": "string", "files": ["path"], "proposed_signature": "string"}],
  "candidate_utility_functions": [{"name": "string", "rationale": "string", "files": ["path"], "proposed_signature": "string"}]
}`;

/** @schemaVersion v1 — Output contract: DedupOutput (pass-A) */
export function deduplicatePromptPassA(groups: AnalysisOutput[]): string {
  return `You are a code architect. Deduplicate these analysis findings from one batch of groups.
Merge findings that share the same root cause (≥2 shared files OR same description intent).
- Combine file lists, take the higher severity, set convergence_count to the number of groups that flagged it.
- Keep single-group findings with convergence_count: 1.
- Do NOT invent new findings.
- Sort each category: severity desc, then convergence_count desc.
- Limit each category array to 8 items maximum. Keep only the most significant.
- Descriptions: 10 words or fewer. severity_rationale: 6 words or fewer.
Return a single JSON object matching this schema:
${DEDUP_SCHEMA}
Return ONLY JSON. No explanation.

${JSON.stringify(groups, null, 2)}`;
}

/** @schemaVersion v1 — Output contract: DedupOutput (pass-B) */
export function deduplicatePromptPassB(partials: DedupOutput[]): string {
  return `You are a code architect. Merge these partially-deduplicated analysis reports into one final report.
Apply the same dedup rules: merge on shared root cause, combine file lists, take higher severity,
sum convergence_counts. Sort: severity desc, convergence_count desc.
- Limit each category array to 10 items maximum. Keep only the most significant.
- Descriptions: 10 words or fewer. severity_rationale: 6 words or fewer.
Return a single JSON object matching this schema:
${DEDUP_SCHEMA}
Return ONLY JSON. No explanation.

${JSON.stringify(partials, null, 2)}`;
}

/** @schemaVersion v1 — Output contract: standards.md + refactor-strategy.md text */
export function aggregatePrompt(deduped: DedupOutput): string {
  return `You are a senior engineer. Based on these deduplicated analysis findings, produce two documents.
Format your response exactly as:

=== standards.md ===
[opinionated codebase standards document]

=== refactor-strategy.md ===
[high-level refactor strategy]

The input is a single deduplicated findings object. Each finding has:
- convergence_count: how many independent analysis passes flagged it (higher = more certain)
- severity: high | medium | low

When producing refactor-strategy.md:
- Order phases by severity desc, then convergence_count desc within each severity tier.
- Call out findings with convergence_count > 1 as "confirmed cross-cutting" issues.

Input:
${JSON.stringify(deduped, null, 2)}`;
}

/** @schemaVersion v1 — Output contract: JSON plan array */
export function refactorPrompt(
  standardsMd: string,
  modules: IndexOutput[],
  fileContents: Map<string, string>
): string {
  const fileBlock = [...fileContents.entries()]
    .map(([path, content]) => `=== ${path} ===\n${content}`)
    .join('\n\n');

  return `You are a senior engineer. Using the standards, module summaries, and file contents below, create a refactor plan.
Return a JSON array where each element is one of:

Full plan entry:
{
  "file": "relative/path",
  "change": "exact description of what to change",
  "before": "verbatim lines from the source file",
  "before_lines": "47-52",
  "after": "updated code",
  "dependencies_impacted": ["path"],
  "tests_to_validate": ["description"]
}

No-violations entry:
{
  "file": "path",
  "verdict": "no_violations",
  "checks_performed": ["list of standards checked"],
  "confidence": "high" | "medium" | "low",
  "note": "one sentence explaining why no changes are needed"
}

Rules:
- For "before" and "after": quote verbatim lines from File Contents below. Do NOT paraphrase or invent code.
- Set "before_lines" to the 1-indexed line range you are quoting (e.g. "47-52").
- If you cannot locate the exact lines, set before_lines to "NEEDS_VERIFICATION".
- For files with no standards violations, use the no-violations entry format.
Return ONLY a JSON array.

Standards:
${standardsMd}

Module Summaries:
${JSON.stringify(modules, null, 2)}

File Contents:
${fileBlock}`;
}
