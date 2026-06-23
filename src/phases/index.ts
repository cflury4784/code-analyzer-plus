import { readManifest, updateBatchStatus, updatePhaseStatus } from '../manifest.js';
import { callLMStudio } from '../lm-studio.js';
import { indexPrompt } from '../prompts/templates.js';
import { getFileStructure } from '../gitnexus.js';
import type { Logger } from '../logger.js';
import type { IndexOutput } from '../types.js';
import type { GitNexusContext } from '../gitnexus.js';
import type { FileSystemService } from '../fs-service.js';
import type { PhaseOrchestrator } from '../phase-orchestrator-types.js';

function extractJsonArray(raw: string): string {
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const start = stripped.indexOf('[');
  if (start === -1) throw new Error('no JSON array found in model response');
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        return stripped.slice(start, i + 1);
      }
    }
  }
  throw new Error('no JSON array found in model response');
}

function extractJsonFromResponse(raw: string): string {
  // Try the full response first (after cleaning code fences)
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch { /* fall through */ }

  // Try extracting a JSON array
  const start = cleaned.indexOf('[');
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          const slice = cleaned.slice(start, i + 1);
          try {
            JSON.parse(slice);
            return slice;
          } catch { /* fall through */ }
        }
      }
    }
  }

  // Try extracting a JSON object
  const oStart = cleaned.indexOf('{');
  if (oStart !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = oStart; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const slice = cleaned.slice(oStart, i + 1);
          try {
            JSON.parse(slice);
            return slice;
          } catch { /* fall through */ }
        }
      }
    }
  }

  throw new Error('no valid JSON found in model response');
}

export async function runIndexPhase(
  orchestrator: PhaseOrchestrator,
  projectRoot: string,
  model: string,
  logger: Logger,
  fs: FileSystemService,
  lmUrl?: string,
  timeoutMs?: number,
  numCtx?: number,
  signal?: AbortSignal,
  gitNexusCtx?: GitNexusContext | null,
): Promise<void> {
  updatePhaseStatus(projectRoot, 'index', 'pending');

  const manifest = readManifest(projectRoot);
  const total = manifest.batches.index.length;
  const pending = manifest.batches.index.filter(b => b.status !== 'completed').length;
  logger.info('Phase 1 — Indexing', { model, batches: total, pending });
  let failedCount = 0;
  let doneCount = total - pending;

  for (const batch of manifest.batches.index) {
    if (batch.status === 'completed') continue;

    const fileContents = batch.files
      .filter(filePath => {
        if (fs.existsSync(fs.join(projectRoot, filePath))) return true;
        logger.warn(`${batch.id} skipping missing file`, { path: filePath });
        return false;
      })
      .map(filePath => ({
        path: filePath,
        content: fs.readFileSync(fs.join(projectRoot, filePath)),
      }));

    if (fileContents.length === 0) {
      doneCount++;
      updateBatchStatus(projectRoot, 'index', batch.id, 'completed', 0);
      logger.info(`${batch.id} done (${doneCount}/${total}) — all files missing, skipped`);
      continue;
    }

    // Pre-fetch structural data from GitNexus if available
    const graphData = gitNexusCtx
      ? await getFileStructure(gitNexusCtx, batch.files)
      : null;

    const prompt = indexPrompt(fileContents, graphData);
    const estTokens = Math.ceil(prompt.length / 3.5);
    const ctxForEstimate = numCtx ?? 32000;
    if (estTokens > ctxForEstimate * 0.75) {
      logger.warn(`${batch.id} prompt estimate ~${estTokens} tokens exceeds 75% of ctx=${ctxForEstimate} — consider splitting`, { files: batch.files.length, size_bytes: batch.size_bytes });
    }

    const result = await orchestrator.runWithRetry(
      async () => {
        const raw = await callLMStudio(model, prompt, lmUrl, timeoutMs, numCtx, signal, 1500);
        const parsed = JSON.parse(extractJsonArray(raw)) as Partial<IndexOutput>[];

        // Guard: model sometimes returns a flat string[] (e.g. just the responsibilities
        // array) instead of an IndexOutput[]. Throwing here lets the orchestrator retry the batch.
        if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'object' || item === null || !('module' in item))) {
          throw new Error(`model returned invalid schema: expected IndexOutput[], got ${JSON.stringify(parsed).slice(0, 120)}`);
        }

        // Merge graph-sourced structural fields back into each item
        // data_flow is intentionally omitted — import paths are not data flow descriptions;
        // leave it for the LLM to infer from file contents
        const enriched: IndexOutput[] = parsed.map(item => {
          const posixModule = (item.module ?? '').replace(/\\/g, '/');
          const structure = graphData?.get(posixModule);
          if (!structure) return item as IndexOutput;
          return {
            ...item,
            dependencies: structure.imports,
          } as IndexOutput;
        });

        fs.mkdirSync(fs.join(projectRoot, 'code-analysis', 'index'));
        fs.writeFileSync(fs.join(projectRoot, batch.output_file), JSON.stringify(enriched, null, 2));
        return enriched;
      },
      (attempt, err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`${batch.id} failed (attempt ${attempt}/${orchestrator.maxAttempts})`, { error: msg });
      },
    );

    if (result) {
      doneCount++;
      updateBatchStatus(projectRoot, 'index', batch.id, 'completed', result.attempts);
      logger.info(`${batch.id} done (${doneCount}/${total})`, { files: batch.files.length });
    } else {
      updateBatchStatus(projectRoot, 'index', batch.id, 'failed', orchestrator.maxAttempts);
      failedCount++;
    }
  }

  const finalStatus = failedCount > 0 ? 'failed' : 'completed';
  updatePhaseStatus(projectRoot, 'index', finalStatus);
  logger.info(`Phase 1 ${finalStatus}`, { batches: total, failed: failedCount });
}
