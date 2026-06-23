import { describe, it, expect } from 'vitest';
import { extractJson } from '../../src/utils/extractJson.js';

describe('extractJson', () => {
  it('parses a bare JSON array', () => {
    expect(extractJson('[{"a":1}]')).toEqual([{ a: 1 }]);
  });
  it('parses a bare JSON object', () => {
    expect(extractJson('{"key":"val"}')).toEqual({ key: 'val' });
  });
  it('strips json code fences', () => {
    expect(extractJson('```json\n[1,2,3]\n```')).toEqual([1, 2, 3]);
  });
  it('extracts array embedded in prose', () => {
    expect(extractJson('Here: [{"a":1}] done.')).toEqual([{ a: 1 }]);
  });
  it('handles escaped quotes inside strings', () => {
    expect(extractJson('{"key":"val\\"ue"}')).toEqual({ key: 'val"ue' });
  });
  it('handles nested objects', () => {
    expect(extractJson('{"a":{"b":1}}')).toEqual({ a: { b: 1 } });
  });
  it('throws on empty string', () => {
    expect(() => extractJson('')).toThrow('no valid JSON found in model response');
  });
  it('throws on unbalanced braces', () => {
    expect(() => extractJson('{"a":1')).toThrow();
  });
});
