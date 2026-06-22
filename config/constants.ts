/**
 * File-read gate: files larger than this are skipped during discovery
 * and marked skipped: true / skip_reason: 'size_exceeded'.
 */
export const FILE_SIZE_LIMIT_BYTES = 100 * 1024; // 102 400 bytes

/**
 * Prompt-batching budget: the maximum byte total for one batch of files
 * sent to the LLM. Files that individually exceed this get their own batch.
 */
export const BATCH_SIZE_LIMIT_BYTES = 8_000;
