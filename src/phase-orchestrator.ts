import {
  readManifest, manifestExists, createManifest, writeManifest,
  resetPhase, updatePhaseStatus,
} from './manifest.js';
import { createBatches } from './batcher.js';
import { withRetry } from './retry.js';
import { ensureModelReady, resolveLoadedIdentifier } from './preflight.js';
import { runUsesModel } from './run-plan.js';
import { runIndexPhase } from './phases/index.js';
import { runAnalyzePhase } from './phases/analyze.js';
import { runDedupPhase } from './phases/dedup.js';
import { runAggregatePhase } from './phases/aggregate.js';
import { discoverFiles } from './discovery.js';
import type { Logger } from './logger.js';
import type { Phase, PhaseStatus } from './types.js';
import type { GitNexusContext } from './gitnexus.js';
import type { PipelineOptions as _PipelineOptions, PhaseOrchestrator as _PhaseOrchestrator } from './phase-orchestrator-types.js';

// Re-export types for consumers
export type PipelineOptions = _PipelineOptions;

class PhaseOrchestratorImpl implements _PhaseOrchestrator {
  private readonly projectRoot: string;
  private readonly logger: Logger;
  public readonly maxAttempts: number;
  private readonly signal: AbortSignal | undefined;

  constructor(
    projectRoot: string,
    logger: Logger,
    maxAttempts = 3,
    signal?: AbortSignal,
  ) {
    this.projectRoot = projectRoot;
    this.logger = logger;
    this.maxAttempts = maxAttempts;
    this.signal = signal;
  }

  async runWithRetry<T>(
    fn: () => Promise<T>,
    onAttemptError: (attempt: number, err: unknown) => void,
  ): Promise<{ value: T; attempts: number } | null> {
    return withRetry(fn, this.maxAttempts, onAttemptError, this.signal);
  }

  readPhaseStatus(phase: Phase): PhaseStatus {
    return readManifest(this.projectRoot).phases[phase];
  }

  writePhaseStatus(phase: Phase, status: PhaseStatus): void {
    updatePhaseStatus(this.projectRoot, phase, status);
  }

  async runPipeline(opts: _PipelineOptions): Promise<void> {
    const { model, maxBatchSize, phase, resume, timeoutMs, numCtx, skipPreflight, gitNexusCtx } = opts;

    const hasManifest = manifestExists(this.projectRoot);

    if (!hasManifest) {
      const files = discoverFiles(this.projectRoot);
      const manifest = createManifest(this.projectRoot, files);
      manifest.batches.index = createBatches(files, 'index', maxBatchSize);
      writeManifest(this.projectRoot, manifest);
      this.logger.info('Discovery complete', { files: files.length });
    } else if (phase && !resume) {
      resetPhase(this.projectRoot, phase as Phase);
      this.logger.info(`Phase ${phase} reset`);
    }

    if (runUsesModel(phase) && !skipPreflight) {
      await ensureModelReady(model, numCtx, this.logger);
    }

    if (!phase || phase === 'index') {
      const m = readManifest(this.projectRoot);
      if (m.phases.index !== 'completed') {
        const resolvedModel = await resolveLoadedIdentifier(model, numCtx, this.logger, { readOnly: skipPreflight });
        await runIndexPhase(this, this.projectRoot, resolvedModel, this.logger, undefined, timeoutMs, numCtx, this.signal, gitNexusCtx);
      }
      if (readManifest(this.projectRoot).phases.index === 'failed') {
        this.logger.error('Phase 1 failed — halting'); process.exit(1);
      }
    }

    if (!phase || phase === 'analyze') {
      const m = readManifest(this.projectRoot);
      if (m.phases.analyze !== 'completed') {
        const resolvedModel = await resolveLoadedIdentifier(model, numCtx, this.logger, { readOnly: skipPreflight });
        await runAnalyzePhase(this, this.projectRoot, resolvedModel, this.logger, undefined, timeoutMs, numCtx, this.signal, gitNexusCtx);
      }
      if (readManifest(this.projectRoot).phases.analyze === 'failed') {
        this.logger.error('Phase 2 failed — halting'); process.exit(1);
      }
    }

    if (!phase || phase === 'dedup') {
      const m = readManifest(this.projectRoot);
      if (m.phases.dedup !== 'completed') {
        const resolvedModel = await resolveLoadedIdentifier(model, numCtx, this.logger, { readOnly: skipPreflight });
        await runDedupPhase(this, this.projectRoot, resolvedModel, this.logger, undefined, timeoutMs, numCtx, this.signal);
      }
      if (readManifest(this.projectRoot).phases.dedup === 'failed') {
        this.logger.error('Phase 2.5 failed — halting'); process.exit(1);
      }
    }

    if (!phase || phase === 'aggregate') {
      const m = readManifest(this.projectRoot);
      if (m.phases.aggregate !== 'completed') {
        const resolvedModel = await resolveLoadedIdentifier(model, numCtx, this.logger, { readOnly: skipPreflight });
        await runAggregatePhase(this, this.projectRoot, resolvedModel, this.logger, undefined, timeoutMs, numCtx, this.signal);
      }
      if (readManifest(this.projectRoot).phases.aggregate === 'failed') {
        this.logger.error('Phase 3 failed — halting'); process.exit(1);
      }
    }

    this.logger.info('Pipeline complete');
  }
}

// Re-export as PhaseOrchestrator for backward compatibility
export { PhaseOrchestratorImpl as PhaseOrchestrator };
