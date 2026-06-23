import { readManifest, updatePhaseStatus } from '../manifest.js';
import { callLMStudio } from '../lm-studio.js';
import { aggregatePrompt } from '../prompts/templates.js';
import type { Logger } from '../logger.js';
import type { DedupOutput } from '../types.js';
import { calculateSafeMaxTokens } from '../utils.js';
import type { FileSystemService } from '../fs-service.js';
import type { PhaseOrchestrator } from '../phase-orchestrator-types.js';
const DEFAULT_NUM_CTX = 32000;

export async function runAggregatePhase(
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
  const manifest = readManifest(projectRoot);

  if (manifest.phases.aggregate === 'completed') {
    logger.info('Phase 3 already complete — skipping');
    return;
  }

  if (manifest.phases.dedup !== 'completed') {
    throw new Error('Phase 2.5 (dedup) must complete before Phase 3 (aggregate)');
  }

  const stdPath = fs.join(projectRoot, 'code-analysis', 'aggregate', 'standards.md');
  const refPath = fs.join(projectRoot, 'code-analysis', 'aggregate', 'refactor-strategy.md');
  if (fs.existsSync(stdPath) && fs.existsSync(refPath)) {
    updatePhaseStatus(projectRoot, 'aggregate', 'completed');
    logger.info('Phase 3 already written — skipping LM call');
    return;
  }

  logger.info('Phase 3 — Aggregate', { model });

  const deduped: DedupOutput = JSON.parse(
    fs.readFileSync(fs.join(projectRoot, 'code-analysis', 'dedup', 'findings.json'))
  );

  const result = await orchestrator.runWithRetry(
    async () => {
      const prompt = aggregatePrompt(deduped);
      const ctx = numCtx ?? DEFAULT_NUM_CTX;
      const maxTokens = calculateSafeMaxTokens(prompt.length, ctx, 3000);
      const combined = await callLMStudio(model, prompt, lmUrl, timeoutMs, ctx, signal, maxTokens);

      const stdMatch = combined.match(/=== standards\.md ===\n([\s\S]*?)(?==== |\s*$)/);
      const refMatch = combined.match(/=== refactor-strategy\.md ===\n([\s\S]*?)(?==== |\s*$)/);

      if (!stdMatch?.[1]?.trim() || !refMatch?.[1]?.trim()) {
        throw new Error(`aggregate response missing expected sections — got: ${combined.slice(0, 200)}`);
      }

        fs.mkdirSync(fs.join(projectRoot, 'code-analysis', 'aggregate'));
        fs.writeFileSync(stdPath, stdMatch[1].trim());
        fs.writeFileSync(refPath, refMatch[1].trim());
      return true;
    },
    (attempt, err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Phase 3 failed (attempt ${attempt}/${orchestrator.maxAttempts})`, { error: msg });
    },
  );

  if (result) {
    updatePhaseStatus(projectRoot, 'aggregate', 'completed');
    logger.info('Phase 3 completed');
  } else {
    logger.error('Phase 3 failed after all attempts');
    updatePhaseStatus(projectRoot, 'aggregate', 'failed');
    throw new Error('Phase 3 failed after all attempts');
  }
}
