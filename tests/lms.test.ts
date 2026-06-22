import { describe, it, expect } from 'vitest';
import { serverStatus, listLoaded, load, estimateTotalGB, type RunLms } from '../src/lms.js';

/** Default context window size used across lms wrapper tests. */
const TEST_CONTEXT_LENGTH = 64_000;

describe('lms wrappers (mocked runLms)', () => {
  it('8a. serverStatus throws a labeled error on non-JSON zero-exit output', async () => {
    const runLms: RunLms = (async () => 'not json at all') as unknown as RunLms;
    await expect(serverStatus({ runLms })).rejects.toThrow(/unparseable output/);
  });

  it('8b. listLoaded throws a labeled error on wrong shape', async () => {
    const runLms: RunLms = (async () => '{"foo":1}') as unknown as RunLms;
    await expect(listLoaded({ runLms })).rejects.toThrow(/unexpected shape/);
  });

  it('2b. load builds args with --parallel 1 and NO --gpu', async () => {
    const seen: string[][] = [];
    const runLms: RunLms = (async (args: string[]) => { seen.push(args); return ''; }) as unknown as RunLms;
    await load('qwen3.6-35b-a3b@q3_k_s', { contextLength: TEST_CONTEXT_LENGTH, parallel: 1 }, { runLms });
    const args = seen[0];
    expect(args).toContain('--parallel');
    expect(args[args.indexOf('--parallel') + 1]).toBe('1');
    expect(args).toContain('--context-length');
    expect(args).toContain('--yes');
    expect(args).not.toContain('--gpu');
  });

  it('7c. estimateTotalGB parses the Estimated Total Memory line', async () => {
    const runLms: RunLms = (async () => 'Model: x\nEstimated Total Memory: 18.52 GiB\n') as unknown as RunLms;
    await expect(estimateTotalGB('x', TEST_CONTEXT_LENGTH, { runLms })).resolves.toBeCloseTo(18.52, 2);
  });

  it('7d. estimateTotalGB throws when the line is absent', async () => {
    const runLms: RunLms = (async () => 'no estimate here') as unknown as RunLms;
    await expect(estimateTotalGB('x', TEST_CONTEXT_LENGTH, { runLms })).rejects.toThrow(/Estimated Total Memory/);
  });

  it('7e. estimateTotalGB parses through ANSI color codes', async () => {
    const ansi = '\x1b[31mEstimated Total Memory:\x1b[0m \x1b[1m18.52\x1b[0m GiB\n';
    const runLms: RunLms = (async () => ansi) as unknown as RunLms;
    await expect(estimateTotalGB('x', TEST_CONTEXT_LENGTH, { runLms })).resolves.toBeCloseTo(18.52, 2);
  });
});
