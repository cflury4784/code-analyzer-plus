import { updateBatchStatus } from '../manifest.js';
import type { BatchEntry, BatchPhase } from '../types.js';
import type { Logger } from '../logger.js';
import type { PhaseOrchestrator } from '../phase-orchestrator-types.js';

export interface PhaseBatchLoopResult {
  total: number;
  doneCount: number;
  failedCount: number;
}

export interface PhaseBatchLoopOptions<T> {
  orchestrator: PhaseOrchestrator;
  projectRoot: string;
  phase: BatchPhase;
  /** In-memory snapshot of the batch list to iterate (status writes go to disk). */
  batches: BatchEntry[];
  logger: Logger;
  /** Per-batch work: build prompt, call the model, parse, write output, return the parsed result. */
  work: (batch: BatchEntry, index: number) => Promise<T>;
  /**
   * Optional pre-check run before `work`. May be async and may stash prepared
   * state via closure. Return a non-null object to mark the batch completed with
   * 0 attempts (no model call); `logSuffix` is appended to the standard done line.
   * Return null to proceed to `work`.
   */
  trySkip?: (batch: BatchEntry) => Promise<{ logSuffix: string } | null> | { logSuffix: string } | null;
  /** Optional extra meta for the success log line (e.g. index adds `{ files }`). */
  successMeta?: (batch: BatchEntry) => Record<string, unknown> | undefined;
}

/**
 * Shared per-batch execution loop for index/analyze/dedup-PassA phases.
 * Owns: skip-completed, retry invocation, manifest status writes, done/failed
 * counting, and the standard info/error log lines. Does NOT touch phase status —
 * callers keep their own `updatePhaseStatus`/`finalStatus` logic.
 */
export async function runPhaseBatches<T>(opts: PhaseBatchLoopOptions<T>): Promise<PhaseBatchLoopResult> {
  const { orchestrator, projectRoot, phase, batches, logger, work, trySkip, successMeta } = opts;

  const total = batches.length;
  const pending = batches.filter(b => b.status !== 'completed').length;
  let failedCount = 0;
  let doneCount = total - pending;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    if (batch.status === 'completed') continue;

    if (trySkip) {
      const skip = await trySkip(batch);
      if (skip) {
        doneCount++;
        updateBatchStatus(projectRoot, phase, batch.id, 'completed', 0);
        logger.info(`${batch.id} done (${doneCount}/${total})${skip.logSuffix}`);
        continue;
      }
    }

    const result = await orchestrator.runWithRetry(
      () => work(batch, i),
      (attempt, err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`${batch.id} failed (attempt ${attempt}/${orchestrator.maxAttempts})`, { error: msg });
      },
    );

    if (result) {
      doneCount++;
      updateBatchStatus(projectRoot, phase, batch.id, 'completed', result.attempts);
      const meta = successMeta ? successMeta(batch) : undefined;
      if (meta) logger.info(`${batch.id} done (${doneCount}/${total})`, meta);
      else logger.info(`${batch.id} done (${doneCount}/${total})`);
    } else {
      updateBatchStatus(projectRoot, phase, batch.id, 'failed', orchestrator.maxAttempts);
      failedCount++;
    }
  }

  return { total, doneCount, failedCount };
}
