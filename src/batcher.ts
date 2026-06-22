import type { FileEntry, BatchEntry } from './types.js';
import { BATCH_SIZE_LIMIT_BYTES } from '../config/constants.js';

export function createBatches(
  files: FileEntry[],
  phase: string,
  maxBatchBytes: number = BATCH_SIZE_LIMIT_BYTES
): BatchEntry[] {
  const eligible = files.filter(f => !f.skipped);
  const batches: BatchEntry[] = [];
  let current: string[] = [];
  let currentSize = 0;
  let num = 1;

  function flush() {
    if (current.length === 0) return;
    const id = `batch-${String(num).padStart(3, '0')}`;
    batches.push({
      id,
      files: current,
      size_bytes: currentSize,
      status: 'pending',
      attempts: 0,
      completed_at: null,
      output_file: `code-analysis/${phase}/${id}.json`,
    });
    num++;
    current = [];
    currentSize = 0;
  }

  for (const f of eligible) {
    if (f.size_bytes > maxBatchBytes) {
      flush();
      const id = `batch-${String(num).padStart(3, '0')}`;
      batches.push({
        id,
        files: [f.path],
        size_bytes: f.size_bytes,
        status: 'pending',
        attempts: 0,
        completed_at: null,
        output_file: `code-analysis/${phase}/${id}.json`,
      });
      num++;
    } else if (currentSize + f.size_bytes > maxBatchBytes) {
      flush();
      current = [f.path];
      currentSize = f.size_bytes;
    } else {
      current.push(f.path);
      currentSize += f.size_bytes;
    }
  }
  flush();
  return batches;
}
