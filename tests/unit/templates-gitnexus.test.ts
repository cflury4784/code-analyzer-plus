import { describe, it, expect } from 'vitest';
import { indexPrompt, refactorPrompt } from '../../src/prompts/templates.js';
import type { FileStructure } from '../../src/gitnexus.js';
import type { IndexOutput } from '../../src/types.js';

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

const emptyModules: IndexOutput[] = [];
const emptyContents = new Map<string, string>();
const stdMd = '# Standards\n- no globals';

describe('refactorPrompt with impactedPaths', () => {
  it('does not include dependents section when impactedPaths is absent', () => {
    const prompt = refactorPrompt(stdMd, emptyModules, emptyContents);
    expect(prompt).not.toContain('Known dependents');
  });

  it('includes dependents section when impactedPaths provided', () => {
    const prompt = refactorPrompt(stdMd, emptyModules, emptyContents, ['src/a.ts', 'src/b.ts']);
    expect(prompt).toContain('Known dependents');
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toContain('src/b.ts');
  });

  it('does not include dependents section when impactedPaths is empty array', () => {
    const prompt = refactorPrompt(stdMd, emptyModules, emptyContents, []);
    expect(prompt).not.toContain('Known dependents');
  });
});
