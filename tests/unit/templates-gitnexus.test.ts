import { describe, it, expect } from 'vitest';
import { indexPrompt } from '../../src/prompts/templates.js';
import type { FileStructure } from '../../src/gitnexus.js';

describe('indexPrompt with graphData', () => {
  it('includes dependencies and data_flow fields when graphData is absent', () => {
    const prompt = indexPrompt([{ path: 'src/foo.ts', content: 'export const x = 1;' }]);
    expect(prompt).toContain('"dependencies"');
    expect(prompt).toContain('"data_flow"');
  });

  it('omits dependencies and data_flow fields when graphData is provided', () => {
    const graphData = new Map<string, FileStructure>([
      ['src/foo.ts', { imports: ['src/bar.ts'], calls: [] }],
    ]);
    const prompt = indexPrompt(
      [{ path: 'src/foo.ts', content: 'export const x = 1;' }],
      graphData,
    );
    expect(prompt).not.toContain('"dependencies"');
    expect(prompt).not.toContain('"data_flow"');
  });

  it('notes that dependencies are injected from graph when graphData provided', () => {
    const graphData = new Map<string, FileStructure>();
    const prompt = indexPrompt(
      [{ path: 'src/foo.ts', content: '' }],
      graphData,
    );
    expect(prompt).toContain('dependencies and data_flow');
  });
});
