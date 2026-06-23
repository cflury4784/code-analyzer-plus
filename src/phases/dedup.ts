import { readManifest, writeManifest, updateBatchStatus, updatePhaseStatus } from '../manifest.js';
import { callLMStudio } from '../lm-studio.js';
import { deduplicatePromptPassA, deduplicatePromptPassB } from '../prompts/templates.js';
import type { Logger } from '../logger.js';
import type { AnalysisOutput, BatchEntry, DedupOutput } from '../types.js';
import { extractJson } from '../utils/index.js';
import { calculateSafeMaxTokens } from '../utils.js';
import type { FileSystemService } from '../fs-service.js';
import type { PhaseOrchestrator } from '../phase-orchestrator-types.js';
import { runPhaseBatches } from './phase-runner.js';
const MAX_GROUP_BYTES = 12000;  // smaller batches → smaller output → less truncation risk
const DEFAULT_NUM_CTX = 32000;
const MAX_OUTPUT_TOKENS = 6000;  // dedup responses are large JSON objects



function buildDedupBatches(projectRoot: string, fs: FileSystemService): { batches: BatchEntry[]; passAGroups: AnalysisOutput[][] } {
  const manifest = readManifest(projectRoot);
  const allGroups: AnalysisOutput[] = [];

  for (const batch of manifest.batches.analyze) {
    if (batch.status === 'completed') {
      allGroups.push(JSON.parse(fs.readFileSync(fs.join(projectRoot, batch.output_file))) as AnalysisOutput);
    }
  }

  const passAGroups: AnalysisOutput[][] = [];
  let current: AnalysisOutput[] = [];
  let currentSize = 0;

  for (const group of allGroups) {
    const size = JSON.stringify(group).length;
    if (currentSize + size > MAX_GROUP_BYTES && current.length > 0) {
      passAGroups.push(current);
      current = [group];
      currentSize = size;
    } else {
      current.push(group);
      currentSize += size;
    }
  }
  if (current.length > 0) passAGroups.push(current);

  const batches: BatchEntry[] = passAGroups.map((group, i) => ({
    id: `partial-${String(i + 1).padStart(3, '0')}`,
    files: [],
    size_bytes: JSON.stringify(group).length,
    status: 'pending' as const,
    attempts: 0,
    completed_at: null,
    output_file: `code-analysis/dedup/partial-${String(i + 1).padStart(3, '0')}.json`,
  }));

  return { batches, passAGroups };
}

export async function runDedupPhase(
  orchestrator: PhaseOrchestrator,
  projectRoot: string,
  model: string,
  logger: Logger,
  fs: FileSystemService,
  lmUrl?: string,
  timeoutMs?: number,
  numCtx?: number,
  signal?: AbortSignal,
): Promise<void> {
  if (readManifest(projectRoot).phases.dedup === 'completed') {
    logger.info('Phase 2.5 already complete — skipping');
    return;
  }

  logger.info('Phase 2.5 — Dedup', { model });

  // Pass A: batch dedup
  let m = readManifest(projectRoot);
  const { batches: computedBatches, passAGroups } = buildDedupBatches(projectRoot, fs);
  const noDedupProgress = m.batches.dedup.length === 0 ||
    m.batches.dedup.every(b => b.status !== 'completed');
  if (noDedupProgress) {
    m.batches.dedup = computedBatches;
    writeManifest(projectRoot, m);
    m = readManifest(projectRoot);
  }
  const total = m.batches.dedup.length;
  const pending = m.batches.dedup.filter(b => b.status !== 'completed').length;
  logger.info('Phase 2.5 Pass A', { batches: total, pending });

  const { failedCount: passAFailed } = await runPhaseBatches<DedupOutput>({
    orchestrator,
    projectRoot,
    phase: 'dedup',
    batches: m.batches.dedup,
    logger,
    work: async (batch, i) => {
      const groupItems = passAGroups[i] ?? [];
      const prompt = deduplicatePromptPassA(groupItems);
      const maxTokens = calculateSafeMaxTokens(prompt.length, numCtx ?? DEFAULT_NUM_CTX, MAX_OUTPUT_TOKENS);
      const raw = await callLMStudio(model, prompt, lmUrl, timeoutMs, numCtx, signal, maxTokens);
      const parsed = extractJson(raw) as DedupOutput;
      fs.mkdirSync(fs.join(projectRoot, 'code-analysis', 'dedup'));
      fs.writeFileSync(fs.join(projectRoot, batch.output_file), JSON.stringify(parsed, null, 2));
      return parsed;
    },
  });

  if (passAFailed > 0) {
    logger.error('Phase 2.5 Pass A had failures — cannot proceed to Pass B', { failed: passAFailed });
    updatePhaseStatus(projectRoot, 'dedup', 'failed');
    return;
  }

  // Pass B: hierarchical pair-merge until one result remains
  logger.info('Phase 2.5 Pass B — merging partials');
  const findingsPath = fs.join(projectRoot, 'code-analysis', 'dedup', 'findings.json');
  if (fs.existsSync(findingsPath)) {
    updatePhaseStatus(projectRoot, 'dedup', 'completed');
    logger.info('Phase 2.5 Pass B already written — skipping LM call');
    return;
  }

  const afterPassA = readManifest(projectRoot);
  let pool: DedupOutput[] = afterPassA.batches.dedup
    .filter(b => b.status === 'completed')
    .map(b => JSON.parse(fs.readFileSync(fs.join(projectRoot, b.output_file))) as DedupOutput);

  let round = 0;
  while (pool.length > 1) {
    round++;
    const nextRound: DedupOutput[] = [];
    for (let i = 0; i < pool.length; i += 2) {
      const chunk = pool.slice(i, i + 2);
      if (chunk.length === 1) { nextRound.push(chunk[0]); continue; }
      const merged = await orchestrator.runWithRetry(
        async () => {
          const prompt = deduplicatePromptPassB(chunk);
        const maxTokens = calculateSafeMaxTokens(prompt.length, numCtx ?? DEFAULT_NUM_CTX, MAX_OUTPUT_TOKENS);
          const raw = await callLMStudio(model, prompt, lmUrl, timeoutMs, numCtx, signal, maxTokens);
          return extractJson(raw) as DedupOutput;
        },
        (attempt, err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`Pass B r${round} pair ${Math.floor(i / 2) + 1} failed (attempt ${attempt}/${orchestrator.maxAttempts})`, { error: msg });
        },
      );
      if (!merged) {
        logger.error('Phase 2.5 Pass B failed');
        updatePhaseStatus(projectRoot, 'dedup', 'failed');
        throw new Error('Phase 2.5 Pass B failed');
      }
      nextRound.push(merged.value);
    }
    pool = nextRound;
    logger.info(`Pass B round ${round} done`, { remaining: pool.length });
  }

  fs.mkdirSync(fs.join(projectRoot, 'code-analysis', 'dedup'));
  fs.writeFileSync(findingsPath, JSON.stringify(pool[0], null, 2));
  updatePhaseStatus(projectRoot, 'dedup', 'completed');
  logger.info('Phase 2.5 completed');
}
