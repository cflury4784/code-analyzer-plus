import { describe, it, expect } from 'vitest';
import { toMarkdown } from '../../src/phases/refactor.js';
import type { RefactorPlanEntry } from '../../src/types.js';

describe('toMarkdown — full plan entry', () => {
  it('renders file header, change, before, after, dependencies, tests', () => {
    const entry: RefactorPlanEntry = {
      file: 'src/foo.ts',
      change: 'Extract helper',
      before: 'const x = 1 + 1;',
      before_lines: '10-10',
      after: 'const x = add(1, 1);',
      dependencies_impacted: ['src/bar.ts'],
      tests_to_validate: ['addition works'],
    };
    const md = toMarkdown([entry]);
    expect(md).toContain('## src/foo.ts');
    expect(md).toContain('Extract helper');
    expect(md).toContain('lines 10-10');
    expect(md).toContain('const x = 1 + 1;');
    expect(md).toContain('src/bar.ts');
    expect(md).toContain('addition works');
  });

  it('omits before_lines annotation when field is absent', () => {
    const entry: RefactorPlanEntry = {
      file: 'src/foo.ts',
      change: 'Fix',
      before: 'old',
      before_lines: undefined,
      after: 'new',
      dependencies_impacted: [],
      tests_to_validate: [],
    };
    const md = toMarkdown([entry]);
    expect(md).not.toContain('lines');
  });
});

describe('toMarkdown — no_violations entry', () => {
  it('renders compact line with checkmark', () => {
    const entry: RefactorPlanEntry = {
      file: 'src/config.ts',
      verdict: 'no_violations',
      checks_performed: ['duplication', 'naming'],
      confidence: 'high',
      note: 'config-only file',
    };
    const md = toMarkdown([entry]);
    expect(md).toContain('## src/config.ts');
    expect(md).toContain('✓ No violations');
    expect(md).toContain('config-only file');
    expect(md).toContain('confidence: high');
    expect(md).toContain('duplication, naming');
  });

  it('does not contain Change/Before/After headers', () => {
    const entry: RefactorPlanEntry = {
      file: 'src/config.ts',
      verdict: 'no_violations',
      checks_performed: [],
      confidence: 'high',
      note: 'ok',
    };
    const md = toMarkdown([entry]);
    expect(md).not.toContain('**Change:**');
    expect(md).not.toContain('**Before');
    expect(md).not.toContain('**After:**');
  });

  it('renders cleanly when note is absent', () => {
    const entry: RefactorPlanEntry = {
      file: 'src/empty.ts',
      verdict: 'no_violations',
      checks_performed: ['duplication'],
      confidence: 'high',
    };
    const md = toMarkdown([entry]);
    expect(md).toContain('✓ No violations');
    expect(md).not.toContain('—  ');  // no double space / empty note dash
    expect(md).toContain('confidence: high');
  });
});

describe('toMarkdown — multiple entries', () => {
  it('separates entries with ---', () => {
    const entries: RefactorPlanEntry[] = [
      { file: 'a.ts', verdict: 'no_violations', checks_performed: [], confidence: 'high', note: 'ok' },
      { file: 'b.ts', verdict: 'no_violations', checks_performed: [], confidence: 'low', note: 'ok' },
    ];
    expect(toMarkdown(entries)).toContain('---');
  });
});
