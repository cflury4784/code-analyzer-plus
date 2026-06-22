import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { readManifest, writeManifest, updateBatchStatus, updatePhaseStatus } from '../manifest.js';
import { callLMStudio } from '../lm-studio.js';
import { withRetry } from '../retry.js';
import { analyzePrompt } from '../prompts/templates.js';
import { getCommunities } from '../gitnexus.js';
import type { Logger } from '../logger.js';
import type { AnalysisOutput, BatchEntry, IndexOutput } from '../types.js';
import type { GitNexusContext } from '../gitnexus.js';
import { calculateSafeMaxTokens } from '../utils.js';

const MAX_ATTEMPTS = 3;
const MAX_GROUP_BYTES = 20000;
const DEFAULT_NUM_CTX = 32000;

async function groupIndexOutputs(
  projectRoot: string,
  gitNexusCtx?: GitNexusContext | null,
): Promise<{ batches: BatchEntry[]; groups: IndexOutput[][] }> {
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

  if (gitNexusCtx) {
    // Community-based grouping
    const communities = await getCommunities(gitNexusCtx);
    if (communities && communities.size > 0) {
      // Build reverse map: posix file path -> community name
      const fileToComm = new Map<string, string>();
      for (const [comm, files] of communities) {
        for (const f of files) fileToComm.set(f.replace(/\\/g, '/'), comm);
      }

      const commGroups = new Map<string, IndexOutput[]>();
      const overflow: IndexOutput[] = [];

      for (const item of allItems) {
        const posixPath = (item.module ?? '').replace(/\\/g, '/');
        const comm = fileToComm.get(posixPath);
        if (comm) {
          if (!commGroups.has(comm)) commGroups.set(comm, []);
          commGroups.get(comm)!.push(item);
        } else {
          overflow.push(item);
        }
      }

      // Sub-split each community by bytes if it exceeds MAX_GROUP_BYTES
      for (const [, items] of commGroups) {
        let current: IndexOutput[] = [];
        let currentSize = 0;
        for (const item of items) {
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
      }

      // Overflow items: fallback byte grouping
      let current: IndexOutput[] = [];
      let currentSize = 0;
      for (const item of overflow) {
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
    } else {
      // getCommunities returned null or empty -> fall through to byte grouping
      return byteGroupIndexOutputs(allItems);
    }
  } else {
    return byteGroupIndexOutputs(allItems);
  }

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

function byteGroupIndexOutputs(allItems: IndexOutput[]): { batches: BatchEntry[]; groups: IndexOutput[][] } {
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
  gitNexusCtx?: GitNexusContext | null,
): Promise<void> {
  let manifest = readManifest(projectRoot);

  const noAnalyzeProgress = manifest.batches.analyze.length === 0 ||
    manifest.batches.analyze.every(b => b.status !== 'completed');

  // Single call -> reuse batches for manifest and groups for processing
  const { batches: computedBatches, groups } = await groupIndexOutputs(projectRoot, gitNexusCtx);

  if (noAnalyzeProgress) {
    manifest.batches.analyze = computedBatches;
    writeManifest(projectRoot, manifest);
    manifest = readManifest(projectRoot);
  }
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
