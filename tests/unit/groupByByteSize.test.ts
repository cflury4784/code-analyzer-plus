import { describe, it, expect } from 'vitest';
import { groupByByteSize } from '../../src/utils/index.js';

describe('groupByByteSize', () => {
  it('returns empty array for empty input', () => {
    expect(groupByByteSize([], 1000)).toEqual([]);
  });
  it('groups items that fit within the byte limit', () => {
    const items = [{ a: 1 }, { b: 2 }, { c: 3 }];
    const groups = groupByByteSize(items, 100);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual(items);
  });
  it('splits when limit exceeded', () => {
    const big = { data: 'x'.repeat(50) };
    const groups = groupByByteSize([big, big, big], 60);
    expect(groups).toHaveLength(3);
  });
  it('puts oversized single item in its own group', () => {
    const huge = { data: 'x'.repeat(500) };
    const small = { a: 1 };
    const groups = groupByByteSize([small, huge, small], 100);
    expect(groups.some(g => g.length === 1 && g[0] === huge)).toBe(true);
  });
});
