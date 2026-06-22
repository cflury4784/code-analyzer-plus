import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  manifestExists,
  createManifest,
  readManifest,
  writeManifest,
  updateBatchStatus,
  updatePhaseStatus,
  resetPhase,
} from '../../src/manifest.js';
import type { FileEntry } from '../../src/types.js';

let testRoot: string;

beforeEach(() => {
  testRoot = join(tmpdir(), `manifest-test-${Date.now()}`);
  mkdirSync(testRoot, { recursive: true });
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('manifestExists', () => {
  it('returns false when no manifest present', () => {
    expect(manifestExists(testRoot)).toBe(false);
  });

  it('returns true after writing manifest', () => {
    writeManifest(testRoot, createManifest(testRoot, []));
    expect(manifestExists(testRoot)).toBe(true);
  });
});

describe('writeManifest / readManifest', () => {
  it('round-trips data correctly', () => {
    const files: FileEntry[] = [
      { path: 'src/a.ts', size_bytes: 1000, skipped: false, skip_reason: null },
    ];
    const m = createManifest(testRoot, files);
    writeManifest(testRoot, m);
    const read = readManifest(testRoot);
    expect(read.files).toEqual(files);
    expect(read.version).toBe(1);
    expect(read.phases.index).toBe('pending');
  });

  it('writes to code-analysis/manifest.json', () => {
    writeManifest(testRoot, createManifest(testRoot, []));
    expect(existsSync(join(testRoot, 'code-analysis', 'manifest.json'))).toBe(true);
  });

  it('does not leave .tmp file on disk', () => {
    writeManifest(testRoot, createManifest(testRoot, []));
    expect(existsSync(join(testRoot, 'code-analysis', 'manifest.json.tmp'))).toBe(false);
  });
});

describe('updateBatchStatus', () => {
  it('marks batch completed and sets completed_at', () => {
    const m = createManifest(testRoot, []);
    m.batches.index = [{
      id: 'batch-001', files: [], size_bytes: 0,
      status: 'pending', attempts: 0, completed_at: null,
      output_file: 'code-analysis/index/batch-001.json',
    }];
    writeManifest(testRoot, m);

    updateBatchStatus(testRoot, 'index', 'batch-001', 'completed', 1);

    const updated = readManifest(testRoot);
    expect(updated.batches.index[0].status).toBe('completed');
    expect(updated.batches.index[0].attempts).toBe(1);
    expect(updated.batches.index[0].completed_at).not.toBeNull();
  });

  it('marks batch failed with null completed_at', () => {
    const m = createManifest(testRoot, []);
    m.batches.index = [{
      id: 'batch-001', files: [], size_bytes: 0,
      status: 'pending', attempts: 0, completed_at: null,
      output_file: 'code-analysis/index/batch-001.json',
    }];
    writeManifest(testRoot, m);

    updateBatchStatus(testRoot, 'index', 'batch-001', 'failed', 3);

    const updated = readManifest(testRoot);
    expect(updated.batches.index[0].status).toBe('failed');
    expect(updated.batches.index[0].attempts).toBe(3);
    expect(updated.batches.index[0].completed_at).toBeNull();
  });
});

describe('updatePhaseStatus', () => {
  it('persists new phase status', () => {
    writeManifest(testRoot, createManifest(testRoot, []));
    updatePhaseStatus(testRoot, 'index', 'completed');
    expect(readManifest(testRoot).phases.index).toBe('completed');
  });
});

describe('resetPhase', () => {
  it('resets phase status and all its batches to pending', () => {
    const m = createManifest(testRoot, []);
    m.phases.index = 'completed';
    m.batches.index = [{
      id: 'batch-001', files: [], size_bytes: 0,
      status: 'completed', attempts: 2,
      completed_at: '2026-01-01T00:00:00Z',
      output_file: 'code-analysis/index/batch-001.json',
    }];
    writeManifest(testRoot, m);

    resetPhase(testRoot, 'index');

    const updated = readManifest(testRoot);
    expect(updated.phases.index).toBe('pending');
    expect(updated.batches.index[0].status).toBe('pending');
    expect(updated.batches.index[0].attempts).toBe(0);
    expect(updated.batches.index[0].completed_at).toBeNull();
  });
});

describe('createManifest — dedup fields', () => {
  it('initializes phases.dedup as pending', () => {
    const m = createManifest(testRoot, []);
    expect(m.phases.dedup).toBe('pending');
  });

  it('initializes batches.dedup as empty array', () => {
    const m = createManifest(testRoot, []);
    expect(m.batches.dedup).toEqual([]);
  });
});

describe('readManifest — backward compatibility', () => {
  it('populates missing phases.dedup with pending when field absent', () => {
    const m = createManifest(testRoot, []);
    // Simulate old manifest without dedup fields
    const raw = JSON.parse(JSON.stringify(m)) as Record<string, Record<string, unknown>>;
    delete (raw.phases as Record<string, unknown>).dedup;
    delete (raw.batches as Record<string, unknown>).dedup;
    mkdirSync(join(testRoot, 'code-analysis'), { recursive: true });
    writeFileSync(join(testRoot, 'code-analysis', 'manifest.json'), JSON.stringify(raw, null, 2), 'utf8');

    const read = readManifest(testRoot);
    expect(read.phases.dedup).toBe('pending');
    expect(read.batches.dedup).toEqual([]);
  });
});

describe('resetPhase — dedup', () => {
  it('resets dedup phase status and batches to pending', () => {
    const m = createManifest(testRoot, []);
    m.phases.dedup = 'completed';
    m.batches.dedup = [{
      id: 'partial-001', files: [], size_bytes: 0,
      status: 'completed', attempts: 1,
      completed_at: '2026-01-01T00:00:00Z',
      output_file: 'code-analysis/dedup/partial-001.json',
    }];
    writeManifest(testRoot, m);

    resetPhase(testRoot, 'dedup');

    const updated = readManifest(testRoot);
    expect(updated.phases.dedup).toBe('pending');
    expect(updated.batches.dedup[0].status).toBe('pending');
    expect(updated.batches.dedup[0].attempts).toBe(0);
    expect(updated.batches.dedup[0].completed_at).toBeNull();
  });
});
