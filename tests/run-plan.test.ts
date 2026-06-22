import { describe, it, expect } from 'vitest';
import { runUsesModel } from '../src/run-plan.js';

describe('runUsesModel (F2 phase-set gate)', () => {
  it('11a. returns true for a full run (no phase given)', () => {
    expect(runUsesModel(undefined)).toBe(true);
  });
  it('11b. returns true for model-using phases', () => {
    for (const p of ['index', 'analyze', 'dedup']) expect(runUsesModel(p)).toBe(true);
  });
  it('11c. returns false for the model-free aggregate phase', () => {
    expect(runUsesModel('aggregate')).toBe(false);
  });
});
