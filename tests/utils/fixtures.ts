import { HttpResponse } from 'msw';
import type { BatchEntry } from '../../src/types.js';

/**
 * Generate a minimal MSW HttpResponse simulating an LM Studio SSE streaming reply.
 * Note: despite the name `generatePromptFixture`, this produces an HTTP response
 * fixture (not a text prompt) — the name follows the project spec.
 *
 * @param content - The string to embed in the SSE delta.content field.
 *   Typically a JSON-serialized payload (e.g. JSON.stringify([indexItem])).
 */
export function generatePromptFixture(content: string): HttpResponse {
  const chunk = JSON.stringify({
    choices: [{ delta: { content }, finish_reason: null }],
  });
  return new HttpResponse(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/**
 * Create a BatchEntry test fixture with sensible defaults.
 * Supply only the fields relevant to the specific assertion.
 */
export function createTestManifestFixture(overrides: Partial<BatchEntry> = {}): BatchEntry {
  return {
    id: 'batch-001',
    files: [],
    size_bytes: 0,
    status: 'pending',
    attempts: 0,
    completed_at: null,
    output_file: 'code-analysis/index/batch-001.json',
    ...overrides,
  };
}
