import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverFiles } from '../../src/discovery.js';
import { createManifest, writeManifest, readManifest } from '../../src/manifest.js';
import { createBatches } from '../../src/batcher.js';
import { runIndexPhase } from '../../src/phases/index.js';
import { NodeFileSystemService } from '../../src/fs-service.js';
import { PhaseOrchestrator } from '../../src/phase-orchestrator.js';
import { createLogger } from '../../src/logger.js';
import { setupTempFs, type TempFsResult } from '../utils/TestEnvironmentManager.js';
import { generatePromptFixture } from '../utils/fixtures.js';

const MOCK_INDEX_ITEM = {
  module: 'src/utils/helper.ts',
  responsibilities: ['format date', 'truncate string'],
  ui_patterns: [],
  data_flow: [],
  dependencies: [],
  duplicated_logic_candidates: [],
  inconsistencies: [],
};

const LM_URL = 'http://localhost:1234/v1/chat/completions';
const server = setupServer();
let testRoot: string;
let tempFs: TempFsResult | undefined;

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function setupProject() {
  tempFs = setupTempFs('phase1-test');
  testRoot = tempFs.root;
  mkdirSync(join(testRoot, 'src', 'utils'), { recursive: true });
  writeFileSync(join(testRoot, 'src', 'utils', 'helper.ts'), 'export const x = 1;');

  const files = discoverFiles(testRoot);
  const manifest = createManifest(testRoot, files);
  manifest.batches.index = createBatches(files, 'index');
  writeManifest(testRoot, manifest);

  server.use(
    http.post(LM_URL, () => generatePromptFixture(JSON.stringify([MOCK_INDEX_ITEM])))
  );
}

afterEach(() => {
  if (tempFs) tempFs.cleanup();
});

describe('runIndexPhase', () => {
  it('writes batch output file and marks batch completed', async () => {
    setupProject();
    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));

    const orchestrator = new PhaseOrchestrator(testRoot, logger);
    const fsService = new NodeFileSystemService();
    await runIndexPhase(orchestrator, testRoot, 'qwen/qwen3.5-9b', logger, fsService, LM_URL);

    const manifest = readManifest(testRoot);
    expect(manifest.phases.index).toBe('completed');
    expect(manifest.batches.index[0].status).toBe('completed');
    expect(existsSync(join(testRoot, 'code-analysis', 'index', 'batch-001.json'))).toBe(true);
  });

  it('skips already-completed batches on re-run', async () => {
    setupProject();
    let callCount = 0;
    server.use(
      http.post(LM_URL, () => {
        callCount++;
        return HttpResponse.json({ choices: [{ message: { content: JSON.stringify([MOCK_INDEX_ITEM]) } }] });
      })
    );

    const manifest = readManifest(testRoot);
    manifest.batches.index[0].status = 'completed';
    manifest.batches.index[0].completed_at = new Date().toISOString();
    mkdirSync(join(testRoot, 'code-analysis', 'index'), { recursive: true });
    writeFileSync(join(testRoot, 'code-analysis', 'index', 'batch-001.json'), JSON.stringify([MOCK_INDEX_ITEM]));
    writeManifest(testRoot, manifest);

    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
    const orchestrator = new PhaseOrchestrator(testRoot, logger);
    const fsService = new NodeFileSystemService();
    await runIndexPhase(orchestrator, testRoot, 'qwen/qwen3.5-9b', logger, fsService, LM_URL);

    expect(callCount).toBe(0);
  });

  it('skips a batch whose files are all missing without calling the model', async () => {
    setupProject();
    // Point the batch at a file that does not exist on disk.
    const manifest = readManifest(testRoot);
    manifest.batches.index[0].files = ['src/utils/does-not-exist.ts'];
    writeManifest(testRoot, manifest);

    let callCount = 0;
    server.use(http.post(LM_URL, () => {
      callCount++;
      return generatePromptFixture(JSON.stringify([MOCK_INDEX_ITEM]));
    }));

    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
    const orchestrator = new PhaseOrchestrator(testRoot, logger);
    const fsService = new NodeFileSystemService();
    await runIndexPhase(orchestrator, testRoot, 'qwen/qwen3.5-9b', logger, fsService, LM_URL);

    expect(callCount).toBe(0);
    const after = readManifest(testRoot);
    expect(after.batches.index[0].status).toBe('completed');
    expect(after.batches.index[0].attempts).toBe(0);
    expect(after.phases.index).toBe('completed');
  });

  it('marks phase failed when all batches fail', async () => {
    setupProject();
    server.use(
      http.post(LM_URL, () => new HttpResponse('error', { status: 500 }))
    );

    const logger = createLogger(join(testRoot, 'code-analysis', 'logs', 'run.log'));
    const orchestrator = new PhaseOrchestrator(testRoot, logger);
    const fsService = new NodeFileSystemService();
    await runIndexPhase(orchestrator, testRoot, 'qwen/qwen3.5-9b', logger, fsService, LM_URL);

    expect(readManifest(testRoot).phases.index).toBe('failed');
  }, 15000);
});
