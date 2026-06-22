import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { readManifest, updateBatchStatus, updatePhaseStatus } from '../manifest.js';
import { callLMStudio } from '../lm-studio.js';
import { withRetry } from '../retry.js';
import { indexPrompt } from '../prompts/templates.js';
import type { Logger } from '../logger.js';
import type { IndexOutput } from '../types.js';

const MAX_ATTEMPTS = 3;

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
  projectRoot: string,
  model: string,
  logger: Logger,
  lmUrl?: string,
  timeoutMs?: number,
  numCtx?: number,
  signal?: AbortSignal,
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
      .filter(path => {
        if (existsSync(join(projectRoot, path))) return true;
        logger.warn(`${batch.id} skipping missing file`, { path });
        return false;
      })
      .map(path => ({
        path,
        content: readFileSync(join(projectRoot, path), 'utf8'),
      }));

    if (fileContents.length === 0) {
      doneCount++;
      updateBatchStatus(projectRoot, 'index', batch.id, 'completed', 0);
      logger.info(`${batch.id} done (${doneCount}/${total}) — all files missing, skipped`);
      continue;
    }

    const prompt = indexPrompt(fileContents);
    const estTokens = Math.ceil(prompt.length / 3.5);
    const ctxForEstimate = numCtx ?? 32000;
    if (estTokens > ctxForEstimate * 0.75) {
      logger.warn(`${batch.id} prompt estimate ~${estTokens} tokens exceeds 75% of ctx=${ctxForEstimate} — consider splitting`, { files: batch.files.length, size_bytes: batch.size_bytes });
    }

    const result = await withRetry(
      async () => {
        const raw = await callLMStudio(model, prompt, lmUrl, timeoutMs, numCtx, signal, 1500);
        const parsed = JSON.parse(extractJsonArray(raw));
        mkdirSync(join(projectRoot, 'code-analysis', 'index'), { recursive: true });
        writeFileSync(join(projectRoot, batch.output_file), JSON.stringify(parsed, null, 2), 'utf8');
        return parsed;
      },
      MAX_ATTEMPTS,
      (attempt, err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`${batch.id} failed (attempt ${attempt}/${MAX_ATTEMPTS})`, { error: msg });
      },
      signal,
    );

    if (result) {
      doneCount++;
      updateBatchStatus(projectRoot, 'index', batch.id, 'completed', result.attempts);
      logger.info(`${batch.id} done (${doneCount}/${total})`, { files: batch.files.length });
    } else {
      updateBatchStatus(projectRoot, 'index', batch.id, 'failed', MAX_ATTEMPTS);
      failedCount++;
    }
  }

  const finalStatus = failedCount > 0 ? 'failed' : 'completed';
  updatePhaseStatus(projectRoot, 'index', finalStatus);
  logger.info(`Phase 1 ${finalStatus}`, { batches: total, failed: failedCount });
}
