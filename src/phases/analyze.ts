import { readManifest, writeManifest, updateBatchStatus, updatePhaseStatus } from '../manifest.js';
import { callLMStudio } from '../lm-studio.js';
import { analyzePrompt } from '../prompts/templates.js';
import { getCommunities } from '../gitnexus.js';
import type { Logger } from '../logger.js';
import type { AnalysisOutput, BatchEntry, IndexOutput } from '../types.js';
import type { GitNexusContext } from '../gitnexus.js';
import { calculateSafeMaxTokens } from '../utils.js';
import { extractJson, groupByByteSize } from '../utils/index.js';
import type { FileSystemService } from '../fs-service.js';
import type { PhaseOrchestrator } from '../phase-orchestrator-types.js';
import { runPhaseBatches } from './phase-runner.js';
const MAX_GROUP_BYTES = 20000;
const DEFAULT_NUM_CTX = 32000;

async function groupIndexOutputs(
  projectRoot: string,
  fs: FileSystemService,
  gitNexusCtx?: GitNexusContext | null,
): Promise<{ batches: BatchEntry[]; groups: IndexOutput[][] }> {
  const manifest = readManifest(projectRoot);
  const allItems: IndexOutput[] = [];

  for (const batch of manifest.batches.index) {
    if (batch.status === 'completed') {
      const raw = JSON.parse(fs.readFileSync(fs.join(projectRoot, batch.output_file)));
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
        groups.push(...groupByByteSize(items, MAX_GROUP_BYTES));
      }

      // Overflow items: fallback byte grouping
      groups.push(...groupByByteSize(overflow, MAX_GROUP_BYTES));
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
  const groups = groupByByteSize(allItems, MAX_GROUP_BYTES);

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
  let manifest = readManifest(projectRoot);

  const noAnalyzeProgress = manifest.batches.analyze.length === 0 ||
    manifest.batches.analyze.every(b => b.status !== 'completed');

  // Single call -> reuse batches for manifest and groups for processing
  const { batches: computedBatches, groups } = await groupIndexOutputs(projectRoot, fs, gitNexusCtx);

  if (noAnalyzeProgress) {
    manifest.batches.analyze = computedBatches;
    writeManifest(projectRoot, manifest);
    manifest = readManifest(projectRoot);
  }
  const total = manifest.batches.analyze.length;
  const pending = manifest.batches.analyze.filter(b => b.status !== 'completed').length;
  logger.info('Phase 2 — Analysis', { model, groups: total, pending });
  const { failedCount } = await runPhaseBatches<AnalysisOutput>({
    orchestrator,
    projectRoot,
    phase: 'analyze',
    batches: manifest.batches.analyze,
    logger,
    work: async (batch, i) => {
      const groupItems = groups[i] ?? [];
      const prompt = analyzePrompt(groupItems);
      const maxTokens = calculateSafeMaxTokens(prompt.length, numCtx ?? DEFAULT_NUM_CTX, 3000);
      const raw = await callLMStudio(model, prompt, lmUrl, timeoutMs, numCtx, signal, maxTokens);
      const parsed = extractJson(raw) as AnalysisOutput;
      fs.mkdirSync(fs.join(projectRoot, 'code-analysis', 'analyzer'));
      fs.writeFileSync(fs.join(projectRoot, batch.output_file), JSON.stringify(parsed, null, 2));
      return parsed;
    },
  });

  const finalStatus = failedCount > 0 ? 'failed' : 'completed';
  updatePhaseStatus(projectRoot, 'analyze', finalStatus);
  logger.info(`Phase 2 ${finalStatus}`, { groups: total, failed: failedCount });
}
