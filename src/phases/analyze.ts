import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { readManifest, writeManifest, updateBatchStatus, updatePhaseStatus } from '../manifest.js';
import { callLMStudio } from '../lm-studio.js';
import { withRetry } from '../retry.js';
import { analyzePrompt } from '../prompts/templates.js';
import type { Logger } from '../logger.js';
import type { AnalysisOutput, BatchEntry, IndexOutput } from '../types.js';
import { calculateSafeMaxTokens } from '../utils.js';

const MAX_ATTEMPTS = 3;
const MAX_GROUP_BYTES = 20000;
const DEFAULT_NUM_CTX = 32000;

function groupIndexOutputs(projectRoot: string): { batches: BatchEntry[]; groups: IndexOutput[][] } {
  const manifest = readManifest(projectRoot);
  const allItems: IndexOutput[] = [];

  for (const batch of manifest.batches.index) {
    if (batch.status === 'completed') {
      const raw = JSON.parse(readFileSync(join(projectRoot, batch.output_file), 'utf8'));
      const items = Array.isArray(raw) ? raw as IndexOutput[] : [raw as IndexOutput];
      allItems.push(...items);
    }
  }

  const groups: IndexOutput[][] = [];
  let current: IndexOutput[] = [];
  let currentSize = 0;

  for (const item of allItems) {
    const size = JSON.stringify(item).length;
    if (currentSize + size > MAX_GROUP_BYTES && current.length > 0) {
      groups.push(current);
      current = [item];
      currentSize = size;
    } else {
      current.push(item);
      currentSize += size;
    }
  }
  if (current.length > 0) groups.push(current);

  const batches: BatchEntry[] = groups.map((group, i) => {
    const id = `group-${String(i + 1).padStart(3, '0')}`;
    return {
      id,
      files: [],
      size_bytes: JSON.stringify(group).length,
      status: 'pending' as const,
      attempts: 0,
      completed_at: null,
      output_file: `code-analysis/analyzer/${id}.json`,
    };
  });

  return { batches, groups };
}

export async function runAnalyzePhase(
  projectRoot: string,
  model: string,
  logger: Logger,
  lmUrl?: string,
  timeoutMs?: number,
  numCtx?: number,
  signal?: AbortSignal,
): Promise<void> {
  let manifest = readManifest(projectRoot);

  const noAnalyzeProgress = manifest.batches.analyze.length === 0 ||
    manifest.batches.analyze.every(b => b.status !== 'completed');
  if (noAnalyzeProgress) {
    const { batches } = groupIndexOutputs(projectRoot);
    manifest.batches.analyze = batches;
    writeManifest(projectRoot, manifest);
  }

  manifest = readManifest(projectRoot);
  const { groups } = groupIndexOutputs(projectRoot);
  const total = manifest.batches.analyze.length;
  const pending = manifest.batches.analyze.filter(b => b.status !== 'completed').length;
  logger.info('Phase 2 — Analysis', { model, groups: total, pending });
  let failedCount = 0;
  let doneCount = total - pending;

  for (let i = 0; i < manifest.batches.analyze.length; i++) {
    const batch = manifest.batches.analyze[i];
    if (batch.status === 'completed') continue;

    const groupItems = groups[i] ?? [];

    const result = await withRetry(
      async () => {
        const prompt = analyzePrompt(groupItems);
        const maxTokens = calculateSafeMaxTokens(prompt.length, numCtx ?? DEFAULT_NUM_CTX, 3000);
        const raw = await callLMStudio(model, prompt, lmUrl, timeoutMs, numCtx, signal, maxTokens);
        const parsed = JSON.parse(raw) as AnalysisOutput;
        mkdirSync(join(projectRoot, 'code-analysis', 'analyzer'), { recursive: true });
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
      updateBatchStatus(projectRoot, 'analyze', batch.id, 'completed', result.attempts);
      logger.info(`${batch.id} done (${doneCount}/${total})`);
    } else {
      updateBatchStatus(projectRoot, 'analyze', batch.id, 'failed', MAX_ATTEMPTS);
      failedCount++;
    }
  }

  const finalStatus = failedCount > 0 ? 'failed' : 'completed';
  updatePhaseStatus(projectRoot, 'analyze', finalStatus);
  logger.info(`Phase 2 ${finalStatus}`, { groups: total, failed: failedCount });
}
