import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'path';
import { createManifest, writeManifest, readManifest } from '../../src/manifest.js';
import { createLogger } from '../../src/logger.js';
import { runPhaseBatches } from '../../src/phases/phase-runner.js';
import { setupTempFs, type TempFsResult } from '../utils/TestEnvironmentManager.js';
import type { BatchEntry } from '../../src/types.js';
import type { PhaseOrchestrator } from '../../src/phase-orchestrator-types.js';

let tempFs: TempFsResult | undefined;
let testRoot: string;

function makeBatch(id: string, status: BatchEntry['status']): BatchEntry {
  return {
    id,
    files: [`src/${id}.ts`],
    size_bytes: 10,
    status,
    attempts: 0,
    completed_at: null,
    output_file: `code-analysis/analyze/${id}.json`,
  };
}

function seed(batches: BatchEntry[]) {
  tempFs = setupTempFs('phase-runner-test');
  testRoot = tempFs.root;
  const manifest = createManifest(testRoot, []);
  manifest.batches.analyze = batches;
  writeManifest(testRoot, manifest);
}

const okOrchestrator: PhaseOrchestrator = {
  maxAttempts: 3,
  runWithRetry: async (fn) => ({ value: await fn(), attempts: 1 }),
  readPhaseStatus: () => 'pending',
  writePhaseStatus: () => {},
};

const failOrchestrator: PhaseOrchestrator = {
  maxAttempts: 3,
  runWithRetry: async (_fn, onAttemptError) => {
    onAttemptError(3, new Error('boom'));
    return null;
  },
  readPhaseStatus: () => 'pending',
  writePhaseStatus: () => {},
};

afterEach(() => {
  if (tempFs) tempFs.cleanup();
});

describe('runPhaseBatches', () => {
  it('runs work for each pending batch and marks them completed', async () => {
    seed([makeBatch('a', 'pending'), makeBatch('b', 'pending')]);
    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
    const seen: string[] = [];

    const result = await runPhaseBatches({
      orchestrator: okOrchestrator,
      projectRoot: testRoot,
      phase: 'analyze',
      batches: readManifest(testRoot).batches.analyze,
      logger,
      work: async (batch) => { seen.push(batch.id); return 1; },
    });

    expect(seen).toEqual(['a', 'b']);
    expect(result).toEqual({ total: 2, doneCount: 2, failedCount: 0 });
    const m = readManifest(testRoot);
    expect(m.batches.analyze.every(b => b.status === 'completed')).toBe(true);
    expect(m.batches.analyze[0].attempts).toBe(1);
  });

  it('skips already-completed batches', async () => {
    seed([makeBatch('a', 'completed'), makeBatch('b', 'pending')]);
    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
    const seen: string[] = [];

    const result = await runPhaseBatches({
      orchestrator: okOrchestrator,
      projectRoot: testRoot,
      phase: 'analyze',
      batches: readManifest(testRoot).batches.analyze,
      logger,
      work: async (batch) => { seen.push(batch.id); return 1; },
    });

    expect(seen).toEqual(['b']);
    expect(result).toEqual({ total: 2, doneCount: 2, failedCount: 0 });
  });

  it('marks failed batches and counts them without throwing', async () => {
    seed([makeBatch('a', 'pending')]);
    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));

    const result = await runPhaseBatches({
      orchestrator: failOrchestrator,
      projectRoot: testRoot,
      phase: 'analyze',
      batches: readManifest(testRoot).batches.analyze,
      logger,
      work: async () => 1,
    });

    expect(result).toEqual({ total: 1, doneCount: 0, failedCount: 1 });
    const m = readManifest(testRoot);
    expect(m.batches.analyze[0].status).toBe('failed');
    expect(m.batches.analyze[0].attempts).toBe(3);
  });

  it('honors trySkip: marks completed with 0 attempts and never calls work', async () => {
    seed([makeBatch('a', 'pending')]);
    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
    let workCalls = 0;

    const result = await runPhaseBatches({
      orchestrator: okOrchestrator,
      projectRoot: testRoot,
      phase: 'analyze',
      batches: readManifest(testRoot).batches.analyze,
      logger,
      trySkip: () => ({ logSuffix: ' — skipped' }),
      work: async () => { workCalls++; return 1; },
    });

    expect(workCalls).toBe(0);
    expect(result).toEqual({ total: 1, doneCount: 1, failedCount: 0 });
    const m = readManifest(testRoot);
    expect(m.batches.analyze[0].status).toBe('completed');
    expect(m.batches.analyze[0].attempts).toBe(0);
  });

  it('retries on failure and succeeds after maxAttempts', async () => {
    seed([makeBatch('a', 'pending')]);
    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
    const consoleSpy = vi.spyOn(console, 'info');
    let attemptCount = 0;

    const retryOrchestrator: PhaseOrchestrator = {
      maxAttempts: 3,
      runWithRetry: async (fn, onAttemptError) => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const value = await fn();
            return { value, attempts: attempt };
          } catch (err) {
            if (attempt < 3) {
              onAttemptError(attempt, err);
            } else {
              onAttemptError(attempt, err);
              return null;
            }
          }
        }
        return null;
      },
      readPhaseStatus: () => 'pending',
      writePhaseStatus: () => {},
    };

    const work = vi.fn(async (batch: BatchEntry) => {
      attemptCount++;
      if (attemptCount < 3) {
        throw new Error(`attempt ${attemptCount}`);
      }
      return 1;
    });

    const result = await runPhaseBatches({
      orchestrator: retryOrchestrator,
      projectRoot: testRoot,
      phase: 'analyze',
      batches: readManifest(testRoot).batches.analyze,
      logger,
      work,
    });

    expect(attemptCount).toBe(3);
    expect(result).toEqual({ total: 1, doneCount: 1, failedCount: 0 });
    const m = readManifest(testRoot);
    expect(m.batches.analyze[0].status).toBe('completed');
    expect(m.batches.analyze[0].attempts).toBe(3);
    expect(work).toHaveBeenCalledTimes(3);
    consoleSpy.mockRestore();
  });

  it('skips completed batches and only runs work for pending ones', async () => {
    seed([makeBatch('a', 'completed'), makeBatch('b', 'pending')]);
    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
    const consoleSpy = vi.spyOn(console, 'info');

    const work = vi.fn(async () => 1);

    const result = await runPhaseBatches({
      orchestrator: okOrchestrator,
      projectRoot: testRoot,
      phase: 'analyze',
      batches: readManifest(testRoot).batches.analyze,
      logger,
      work,
    });

    expect(work).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ total: 2, doneCount: 2, failedCount: 0 });
    consoleSpy.mockRestore();
  });

  it('marks batch failed after max retries', async () => {
    seed([makeBatch('a', 'pending')]);
    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
    const consoleSpy = vi.spyOn(console, 'info');
    let attemptCount = 0;

    const failOrchestrator: PhaseOrchestrator = {
      maxAttempts: 3,
      runWithRetry: async (_fn, onAttemptError) => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          attemptCount++;
          onAttemptError(attempt, new Error(`boom ${attempt}`));
        }
        return null;
      },
      readPhaseStatus: () => 'pending',
      writePhaseStatus: () => {},
    };

    const work = vi.fn(async () => { throw new Error('should not be called'); });

    const result = await runPhaseBatches({
      orchestrator: failOrchestrator,
      projectRoot: testRoot,
      phase: 'analyze',
      batches: readManifest(testRoot).batches.analyze,
      logger,
      work,
    });

    expect(result).toEqual({ total: 1, doneCount: 0, failedCount: 1 });
    const m = readManifest(testRoot);
    expect(m.batches.analyze[0].status).toBe('failed');
    expect(m.batches.analyze[0].attempts).toBe(3);
    consoleSpy.mockRestore();
  });

  it('processes multiple batches', async () => {
    seed([
      makeBatch('a', 'pending'),
      makeBatch('b', 'pending'),
      makeBatch('c', 'pending'),
    ]);
    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
    const consoleSpy = vi.spyOn(console, 'info');

    const work = vi.fn(async (batch: BatchEntry) => ({ count: batch.id }));

    const result = await runPhaseBatches({
      orchestrator: okOrchestrator,
      projectRoot: testRoot,
      phase: 'analyze',
      batches: readManifest(testRoot).batches.analyze,
      logger,
      work,
    });

    expect(work).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ total: 3, doneCount: 3, failedCount: 0 });
    consoleSpy.mockRestore();
  });
});
