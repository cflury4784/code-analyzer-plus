import { describe, it, expect } from 'vitest';
import { createBatches } from '../../src/batcher.js';
import type { FileEntry } from '../../src/types.js';

function file(path: string, size: number): FileEntry {
  return { path, size_bytes: size, skipped: false, skip_reason: null };
}

describe('createBatches', () => {
  it('groups files until byte limit is reached', () => {
    const batches = createBatches([file('a.ts', 20000), file('b.ts', 20000), file('c.ts', 20000)], 'index', 55000);
    expect(batches).toHaveLength(2);
    expect(batches[0].files).toEqual(['a.ts', 'b.ts']);
    expect(batches[1].files).toEqual(['c.ts']);
  });

  it('puts a file exceeding the limit in its own batch', () => {
    const batches = createBatches([file('a.ts', 20000), file('big.ts', 60000), file('b.ts', 20000)], 'index', 55000);
    expect(batches).toHaveLength(3);
    expect(batches[1].files).toEqual(['big.ts']);
  });

  it('skips files with skipped=true', () => {
    const skipped: FileEntry = { path: 'skip.ts', size_bytes: 600000, skipped: true, skip_reason: 'size_exceeded' };
    const batches = createBatches([file('a.ts', 1000), skipped], 'index', 55000);
    expect(batches).toHaveLength(1);
    expect(batches[0].files).toEqual(['a.ts']);
  });

  it('zero-pads batch IDs to 3 digits', () => {
    const files = Array.from({ length: 2 }, (_, i) => file(`f${i}.ts`, 30000));
    const batches = createBatches(files, 'index', 55000);
    expect(batches[0].id).toBe('batch-001');
    expect(batches[1].id).toBe('batch-002');
  });

  it('sets output_file to code-analysis/<phase>/<id>.json', () => {
    const batches = createBatches([file('a.ts', 1000)], 'index', 55000);
    expect(batches[0].output_file).toBe('code-analysis/index/batch-001.json');
  });

  it('returns empty array for empty input', () => {
    expect(createBatches([], 'index', 55000)).toHaveLength(0);
  });

  it('records correct size_bytes per batch', () => {
    const batches = createBatches([file('a.ts', 10000), file('b.ts', 20000)], 'index', 55000);
    expect(batches[0].size_bytes).toBe(30000);
  });
});
