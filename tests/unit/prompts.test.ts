import { describe, it, expect } from 'vitest';
import {
  analyzePrompt,
  deduplicatePromptPassA,
  deduplicatePromptPassB,
  aggregatePrompt,
} from '../../src/prompts/templates.js';
import type { DedupOutput, AnalysisOutput } from '../../src/types.js';

const emptyDedup: DedupOutput = {
  duplication_clusters: [],
  ui_inconsistencies: [],
  architecture_inconsistencies: [],
  candidate_shared_components: [],
  candidate_utility_functions: [],
};

describe('analyzePrompt', () => {
  it('requires severity field in schema', () => {
    expect(analyzePrompt([])).toContain('"severity"');
  });
  it('requires severity_rationale field', () => {
    expect(analyzePrompt([])).toContain('"severity_rationale"');
  });
  it('requires occurrence_count field', () => {
    expect(analyzePrompt([])).toContain('"occurrence_count"');
  });
  it('requires proposed_signature for candidates', () => {
    expect(analyzePrompt([])).toContain('"proposed_signature"');
  });
});

describe('deduplicatePromptPassA', () => {
  it('mentions convergence_count', () => {
    expect(deduplicatePromptPassA([])).toContain('convergence_count');
  });
  it('instructs to merge on shared root cause', () => {
    expect(deduplicatePromptPassA([])).toContain('root cause');
  });
  it('serializes input into the prompt body', () => {
    const groups: AnalysisOutput[] = [{
      duplication_clusters: [{
        description: 'dup-test', files: ['a.ts'],
        severity: 'high', severity_rationale: 'r',
        occurrence_count: 1,
      }],
      ui_inconsistencies: [], architecture_inconsistencies: [],
      candidate_shared_components: [], candidate_utility_functions: [],
    }];
    expect(deduplicatePromptPassA(groups)).toContain('"dup-test"');
  });
});

describe('deduplicatePromptPassB', () => {
  it('mentions convergence_count', () => {
    expect(deduplicatePromptPassB([])).toContain('convergence_count');
  });
  it('instructs to merge on shared root cause', () => {
    expect(deduplicatePromptPassB([])).toContain('root cause');
  });
  it('serializes input into the prompt body', () => {
    const partials: DedupOutput[] = [{
      duplication_clusters: [{
        description: 'dedup-test', files: ['b.ts'],
        severity: 'medium', severity_rationale: 'r',
        occurrence_count: 2, convergence_count: 3,
      }],
      ui_inconsistencies: [], architecture_inconsistencies: [],
      candidate_shared_components: [], candidate_utility_functions: [],
    }];
    expect(deduplicatePromptPassB(partials)).toContain('"dedup-test"');
  });
});

describe('aggregatePrompt', () => {
  it('mentions convergence_count ordering', () => {
    expect(aggregatePrompt(emptyDedup)).toContain('convergence_count');
  });
  it('mentions confirmed cross-cutting', () => {
    expect(aggregatePrompt(emptyDedup)).toContain('confirmed cross-cutting');
  });
  it('includes standards.md delimiter', () => {
    expect(aggregatePrompt(emptyDedup)).toContain('=== standards.md ===');
  });
  it('includes refactor-strategy.md delimiter', () => {
    expect(aggregatePrompt(emptyDedup)).toContain('=== refactor-strategy.md ===');
  });
});
