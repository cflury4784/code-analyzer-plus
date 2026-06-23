#!/usr/bin/env node
import minimist from 'minimist';
import { createLogger } from './logger.js';
import { DEFAULT_MODEL } from './models.js';
import { join } from 'path';
import { closeGitNexus } from './gitnexus.js';
import { detectGitNexus } from './process-helpers.js';
import { killAll } from './child-registry.js';
import { PhaseOrchestrator } from './phase-orchestrator.js';

const args = minimist(process.argv.slice(2), {
  string: ['phase', 'model-override'],
  boolean: ['resume', 'skip-preflight', 'version'],
  alias: { v: 'version' },
});

if (args['version']) {
  const { createRequire } = await import('module');
  const req = createRequire(import.meta.url);
  const pkg = req('../../package.json') as { version: string };
  console.log(pkg.version);
  process.exit(0);
}

const projectRoot = process.cwd();
const model: string = (args['model-override'] as string | undefined) ?? DEFAULT_MODEL;
const maxBatchSize: number = args['max-batch-size'] !== undefined
  ? Number(args['max-batch-size'])
  : Number(process.env['MAX_BATCH_SIZE'] ?? 8000);
const phase: string | undefined = args['phase'] as string | undefined;
const resume: boolean = (args['resume'] as boolean | undefined) ?? false;
const timeoutMs: number = args['timeout'] !== undefined
  ? Number(args['timeout']) * 1000
  : Number(process.env['DEFAULT_TIMEOUT_MS'] ?? 600_000);
const numCtx: number = args['num-ctx'] !== undefined ? Number(args['num-ctx']) : 32000;
const skipPreflight: boolean = (args['skip-preflight'] as boolean | undefined) ?? false;

if (!Number.isInteger(numCtx) || numCtx <= 0) {
  console.error(`Invalid --num-ctx: must be a positive integer (got ${args['num-ctx']})`);
  process.exit(1);
}

const logger = createLogger(join(projectRoot, 'code-analysis', 'logs', 'run.log'));

const runController = new AbortController();
const handleSignal = (sig: string) => {
  logger.info(`${sig} received — cancelling run`);
  killAll();
  runController.abort();
  setTimeout(() => process.exit(sig === 'SIGINT' ? 130 : 143), 3000).unref();
};
process.once('SIGINT', () => handleSignal('SIGINT'));
process.once('SIGTERM', () => handleSignal('SIGTERM'));

async function main() {
  const gitNexusCtx = await detectGitNexus(projectRoot, logger, resume);
  process.once('exit', () => { if (gitNexusCtx) closeGitNexus(gitNexusCtx); });
  process.once('uncaughtException', (e) => { if (gitNexusCtx) closeGitNexus(gitNexusCtx); throw e; });

  const orchestrator = new PhaseOrchestrator(projectRoot, logger, 3, runController.signal);
  await orchestrator.runPipeline({ model, maxBatchSize, phase, resume, timeoutMs, numCtx, skipPreflight, gitNexusCtx });
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
