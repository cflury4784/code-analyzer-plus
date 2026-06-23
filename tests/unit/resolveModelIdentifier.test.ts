import { describe, it, expect } from 'vitest';
import { resolveModelIdentifier } from '../../src/utils/index.js';

describe('resolveModelIdentifier', () => {
  it('returns known=true for a registered model', () => {
    const { known } = resolveModelIdentifier('qwen3.6-35b-a3b');
    expect(known).toBe(true);
  });
  it('returns known=false for unrecognized model', () => {
    const { known, spec } = resolveModelIdentifier('some-custom-model');
    expect(known).toBe(false);
    expect(spec.loadKey).toBe('some-custom-model');
    expect(spec.requiredTotalGB).toBe(0);
  });
  it('identifierMatch for unknown model is case-insensitive', () => {
    const { spec } = resolveModelIdentifier('my-custom-model');
    expect(spec.identifierMatch.test('MY-CUSTOM-MODEL')).toBe(true);
    expect(spec.identifierMatch.test('other')).toBe(false);
  });
  it('escapes regex metacharacters in unknown model names', () => {
    const { spec } = resolveModelIdentifier('model.v2+special');
    expect(() => spec.identifierMatch.test('model.v2+special')).not.toThrow();
    expect(spec.identifierMatch.test('model.v2+special')).toBe(true);
    expect(spec.identifierMatch.test('modelXv2Yspecial')).toBe(false);
  });
});
