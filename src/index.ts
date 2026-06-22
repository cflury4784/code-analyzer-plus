#!/usr/bin/env node
import minimist from 'minimist';
import { discoverFiles } from './discovery.js';
import { manifestExists, createManifest, readManifest, writeManifest, resetPhase } from './manifest.js';
import { createBatches } from './batcher.js';
import { createLogger } from './logger.js';
import { runIndexPhase } from './phases/index.js';
import { runAnalyzePhase } from './phases/analyze.js';
import { runDedupPhase } from './phases/dedup.js';
import { runAggregatePhase } from './phases/aggregate.js';
import { runRefactorPhase } from './phases/refactor.js';
import { DEFAULT_MODEL } from './models.js';
import { ensureModelReady, resolveLoadedIdentifier } from './preflight.js';
import { runUsesModel } from './run-plan.js';
import { join } from 'path';

const args = minimist(process.argv.slice(2), {
  string: ['phase', 'model-override'],
  boolean: ['resume', 'skip-preflight', 'version'],
  alias: { v: 'version' },
});

if (args['version']) {
  const { createRequire } = await import('module');
  const req = createRequire(import.meta.url);
  const pkg = req('../package.json') as { version: string };
  console.log(pkg.version);
  process.exit(0);
}

const projectRoot = process.cwd();
const model: string = (args['model-override'] as string | undefined) ?? DEFAULT_MODEL;
const maxBatchSize: number = args['max-batch-size'] !== undefined ? Number(args['max-batch-size']) : 8000;
const phase: string | undefined = args['phase'] as string | undefined;
const resume: boolean = (args['resume'] as boolean | undefined) ?? false;
const timeoutMs: number = args['timeout'] !== undefined ? Number(args['timeout']) * 1000 : 10 * 60 * 1000;
const numCtx: number = args['num-ctx'] !== undefined ? Number(args['num-ctx']) : 32000;
const skipPreflight: boolean = (args['skip-preflight'] as boolean | undefined) ?? false;

if (!Number.isInteger(numCtx) || numCtx <= 0) {
  console.error(`Invalid --num-ctx: must be a positive integer (got ${args['num-ctx']})`);
  process.exit(1);
}

const logger = createLogger(join(projectRoot, 'code-analysis', 'logs', 'run.log'));

// Cancellation signal — aborted on SIGINT/SIGTERM so in-flight LMS requests stop immediately.
const runController = new AbortController();
const handleSignal = (sig: string) => {
  logger.info(`${sig} received — cancelling run`);
  runController.abort();
  // Force exit after 3 s if async teardown hangs.
  setTimeout(() => process.exit(sig === 'SIGINT' ? 130 : 143), 3000).unref();
};
process.once('SIGINT', () => handleSignal('SIGINT'));
process.once('SIGTERM', () => handleSignal('SIGTERM'));

async function main() {
  const hasManifest = manifestExists(projectRoot);

  if (!hasManifest) {
    const files = discoverFiles(projectRoot);
    const manifest = createManifest(projectRoot, files);
    manifest.batches.index = createBatches(files, 'index', maxBatchSize);
    writeManifest(projectRoot, manifest);
    logger.info('Discovery complete', { files: files.length });
  } else if (phase && !resume) {
    resetPhase(projectRoot, phase as 'index' | 'analyze' | 'dedup' | 'aggregate' | 'refactor');
    logger.info(`Phase ${phase} reset`);
  }

  // LM Studio preflight — only when the run actually uses the model (skips aggregate-only runs).
  if (runUsesModel(phase) && !skipPreflight) {
    await ensureModelReady(model, numCtx, logger);
  }

  if (!phase || phase === 'index') {
    const m = readManifest(projectRoot);
    if (m.phases.index !== 'completed') {
      const resolvedModel = await resolveLoadedIdentifier(model, numCtx, logger, { readOnly: skipPreflight });
      await runIndexPhase(projectRoot, resolvedModel, logger, undefined, timeoutMs, numCtx, runController.signal);
    }
    if (readManifest(projectRoot).phases.index === 'failed') {
      logger.error('Phase 1 failed — halting');
      process.exit(1);
    }
  }

  if (!phase || phase === 'analyze') {
    const m = readManifest(projectRoot);
    if (m.phases.analyze !== 'completed') {
      const resolvedModel = await resolveLoadedIdentifier(model, numCtx, logger, { readOnly: skipPreflight });
      await runAnalyzePhase(projectRoot, resolvedModel, logger, undefined, timeoutMs, numCtx, runController.signal);
    }
    if (readManifest(projectRoot).phases.analyze === 'failed') {
      logger.error('Phase 2 failed — halting');
      process.exit(1);
    }
  }

  if (!phase || phase === 'dedup') {
    const m = readManifest(projectRoot);
    if (m.phases.dedup !== 'completed') {
      const resolvedModel = await resolveLoadedIdentifier(model, numCtx, logger, { readOnly: skipPreflight });
      await runDedupPhase(projectRoot, resolvedModel, logger, undefined, timeoutMs, numCtx, runController.signal);
    }
    if (readManifest(projectRoot).phases.dedup === 'failed') {
      logger.error('Phase 2.5 failed — halting');
      process.exit(1);
    }
  }

  if (!phase || phase === 'aggregate') {
    const m = readManifest(projectRoot);
    if (m.phases.aggregate !== 'completed') {
      const resolvedModel = await resolveLoadedIdentifier(model, numCtx, logger, { readOnly: skipPreflight });
      await runAggregatePhase(projectRoot, resolvedModel, logger, undefined, timeoutMs, numCtx, runController.signal);
    }
    if (readManifest(projectRoot).phases.aggregate === 'failed') {
      logger.error('Phase 3 failed — halting');
      process.exit(1);
    }
  }

  if (!phase || phase === 'refactor') {
    const m = readManifest(projectRoot);
    if (m.phases.refactor !== 'completed') {
      const resolvedModel = await resolveLoadedIdentifier(model, numCtx, logger, { readOnly: skipPreflight });
      await runRefactorPhase(projectRoot, resolvedModel, logger, undefined, timeoutMs, numCtx, runController.signal);
    }
  }

  logger.info('Pipeline complete');
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
