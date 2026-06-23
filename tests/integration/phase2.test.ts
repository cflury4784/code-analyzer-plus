import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createManifest, writeManifest, readManifest } from '../../src/manifest.js';
import { runAnalyzePhase } from '../../src/phases/analyze.js';
import { NodeFileSystemService } from '../../src/fs-service.js';
import { PhaseOrchestrator } from '../../src/phase-orchestrator.js';
import { createLogger } from '../../src/logger.js';
import { setupTempFs, type TempFsResult } from '../utils/TestEnvironmentManager.js';
import { generatePromptFixture } from '../utils/fixtures.js';

const MOCK_INDEX_ITEM = {
  module: 'src/utils/helper.ts',
  responsibilities: ['format date'],
  ui_patterns: [],
  data_flow: [],
  dependencies: [],
  duplicated_logic_candidates: [],
  inconsistencies: [],
};

const MOCK_ANALYSIS = { module_groups: [], cross_cutting: [] };

const LM_URL = 'http://localhost:1234/v1/chat/completions';
const server = setupServer();
let testRoot: string;
let tempFs: TempFsResult | undefined;

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function setupProjectWithCompletedIndex() {
  tempFs = setupTempFs('phase2-test');
  testRoot = tempFs.root;

  const manifest = createManifest(testRoot, []);
  manifest.batches.index = [{
    id: 'batch-001',
    files: ['src/utils/helper.ts'],
    size_bytes: 20,
    status: 'completed',
    attempts: 1,
    completed_at: new Date().toISOString(),
    output_file: 'code-analysis/index/batch-001.json',
  }];
  manifest.phases.index = 'completed';
  writeManifest(testRoot, manifest);

  mkdirSync(join(testRoot, 'code-analysis', 'index'), { recursive: true });
  writeFileSync(
    join(testRoot, 'code-analysis', 'index', 'batch-001.json'),
    JSON.stringify([MOCK_INDEX_ITEM]),
  );

  server.use(http.post(LM_URL, () => generatePromptFixture(JSON.stringify(MOCK_ANALYSIS))));
}

afterEach(() => {
  if (tempFs) tempFs.cleanup();
});

describe('runAnalyzePhase', () => {
  it('groups completed index output, writes a group file, and marks phase completed', async () => {
    setupProjectWithCompletedIndex();
    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
    const orchestrator = new PhaseOrchestrator(testRoot, logger);
    const fsService = new NodeFileSystemService();

    await runAnalyzePhase(orchestrator, testRoot, 'qwen/qwen3.5-9b', logger, fsService, LM_URL);

    const manifest = readManifest(testRoot);
    expect(manifest.phases.analyze).toBe('completed');
    expect(manifest.batches.analyze.length).toBeGreaterThan(0);
    expect(manifest.batches.analyze.every(b => b.status === 'completed')).toBe(true);
    expect(existsSync(join(testRoot, 'code-analysis', 'analyzer', 'group-001.json'))).toBe(true);
  });

  it('marks phase failed when the model call fails', async () => {
    setupProjectWithCompletedIndex();
    server.use(http.post(LM_URL, () => new HttpResponse('error', { status: 500 })));

    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
    const orchestrator = new PhaseOrchestrator(testRoot, logger);
    const fsService = new NodeFileSystemService();

    await runAnalyzePhase(orchestrator, testRoot, 'qwen/qwen3.5-9b', logger, fsService, LM_URL);

    expect(readManifest(testRoot).phases.analyze).toBe('failed');
  }, 15000);
});
