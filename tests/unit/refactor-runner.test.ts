import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

function sseResponse(content: string): HttpResponse {
  const chunk = JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] });
  return new HttpResponse(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createManifest, writeManifest } from '../../src/manifest.js';
import { runRefactorPhase } from '../../src/phases/refactor.js';
import { createLogger } from '../../src/logger.js';
import type { Manifest, IndexOutput, RefactorPlanEntry } from '../../src/types.js';

const LM_URL = 'http://localhost:1234/v1/chat/completions';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const MOCK_INDEX_ITEM: IndexOutput = {
  module: 'src/utils/helper.ts',
  responsibilities: ['format date'],
  ui_patterns: [],
  data_flow: [],
  dependencies: [],
  duplicated_logic_candidates: [],
  inconsistencies: [],
};

const NORMAL_ENTRY: RefactorPlanEntry = {
  file: 'src/utils/helper.ts',
  change: 'Extract utility function',
  before: 'const x = 1;',
  after: 'export function helper() {}',
  dependencies_impacted: [],
  tests_to_validate: [],
};

const NO_VIOLATIONS_ENTRY: RefactorPlanEntry = {
  file: 'src/utils/helper.ts',
  verdict: 'no_violations',
  checks_performed: ['naming', 'duplication'],
  confidence: 'high',
  note: 'test reason',
};

function setupProjectRoot(): string {
  const testRoot = join(tmpdir(), `refactor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  // Create code-analysis directories
  mkdirSync(join(testRoot, 'code-analysis', 'index'), { recursive: true });
  mkdirSync(join(testRoot, 'code-analysis', 'aggregate'), { recursive: true });
  mkdirSync(join(testRoot, 'code-analysis', 'logs'), { recursive: true });

  // Write standards.md (required by runRefactorPhase)
  writeFileSync(join(testRoot, 'code-analysis', 'aggregate', 'standards.md'), '# Standards\n', 'utf8');

  // Write a completed index batch output file
  const indexOutputFile = 'code-analysis/index/batch-001.json';
  writeFileSync(join(testRoot, indexOutputFile), JSON.stringify([MOCK_INDEX_ITEM]), 'utf8');

  // Build manifest with a completed index batch
  const manifest: Manifest = createManifest(testRoot, []);
  manifest.batches.index = [
    {
      id: 'batch-001',
      files: ['src/utils/helper.ts'],
      size_bytes: 100,
      status: 'completed',
      attempts: 1,
      completed_at: new Date().toISOString(),
      output_file: indexOutputFile,
    },
  ];
  // Leave refactor batches empty so runRefactorPhase builds them
  manifest.batches.refactor = [];
  manifest.phases.index = 'completed';
  writeManifest(testRoot, manifest);

  return testRoot;
}

describe('runRefactorPhase — empty array causes retry', () => {
  it('marks batch as completed with no_violations entry when model returns empty array', async () => {
    const testRoot = setupProjectRoot();
    try {
      server.use(http.post(LM_URL, () => sseResponse('[]')));

      const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
      await runRefactorPhase(testRoot, 'qwen/qwen3.5-9b', logger, LM_URL, undefined, 64000);

      // Empty array is converted to a no_violations entry — batch should be completed
      const { readManifest } = await import('../../src/manifest.js');
      const manifest = readManifest(testRoot);
      expect(manifest.batches.refactor[0].status).toBe('completed');
      expect(manifest.phases.refactor).toBe('completed');
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  }, 20000);
});

describe('runRefactorPhase — no_violations entry', () => {
  it('writes markdown with checkmark when model returns no_violations entry', async () => {
    const testRoot = setupProjectRoot();
    try {
      server.use(http.post(LM_URL, () => sseResponse(JSON.stringify([NO_VIOLATIONS_ENTRY]))));

      const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
      await runRefactorPhase(testRoot, 'qwen/qwen3.5-9b', logger, LM_URL, undefined, 64000);

      const { readManifest } = await import('../../src/manifest.js');
      const manifest = readManifest(testRoot);
      expect(manifest.batches.refactor[0].status).toBe('completed');

      const outputPath = join(testRoot, manifest.batches.refactor[0].output_file);
      expect(existsSync(outputPath)).toBe(true);
      const content = readFileSync(outputPath, 'utf8');
      expect(content).toContain('✓ No violations');
      expect(content).toContain('## src/utils/helper.ts');
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });
});

describe('runRefactorPhase — normal entries', () => {
  it('writes markdown starting with ## for normal refactor entries', async () => {
    const testRoot = setupProjectRoot();
    try {
      server.use(http.post(LM_URL, () => sseResponse(JSON.stringify([NORMAL_ENTRY]))));

      const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
      await runRefactorPhase(testRoot, 'qwen/qwen3.5-9b', logger, LM_URL, undefined, 64000);

      const { readManifest } = await import('../../src/manifest.js');
      const manifest = readManifest(testRoot);
      expect(manifest.batches.refactor[0].status).toBe('completed');

      const outputPath = join(testRoot, manifest.batches.refactor[0].output_file);
      expect(existsSync(outputPath)).toBe(true);
      const content = readFileSync(outputPath, 'utf8');
      expect(content).toMatch(/^##/);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });
});
