import { describe, it, expect, vi } from 'vitest';
import {
  ensureModelReady,
  resolveLoadedIdentifier,
  InsufficientResourcesError,
  type PreflightDeps,
} from '../src/preflight.js';
import { type Lms } from '../src/lms.js';
import type { Logger } from '../src/logger.js';
import { PosixPlatformAdapter } from '../src/platform-adapter.js';

const GiB = 1024 ** 3;
const noopLogger: Logger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };

/** Build a fake lms bundle; `calls` records invocation order. */
function makeLms(overrides: Partial<Lms> = {}, calls: string[] = []): Lms {
  return {
    serverStatus: vi.fn(async () => { calls.push('serverStatus'); return { running: true, port: 1234 }; }),
    startServer: vi.fn(async () => { calls.push('startServer'); }),
    listLoaded: vi.fn(async () => { calls.push('listLoaded'); return []; }),
    unloadAll: vi.fn(async () => { calls.push('unloadAll'); }),
    estimateTotalGB: vi.fn(async () => { calls.push('estimateTotalGB'); return 18.5; }),
    load: vi.fn(async () => { calls.push('load'); }),
    ...overrides,
  } as Lms;
}

function makeDeps(lms: Lms, totalGiB = 31.15, freeGiB = 21.6): PreflightDeps {
  return { lms, totalmem: () => totalGiB * GiB, freemem: () => freeGiB * GiB, platform: new PosixPlatformAdapter() };
}

const M = 'qwen3.6-35b-a3b';
const ID = 'qwen3.6-35b-a3b@q3_k_s';

describe('ensureModelReady', () => {
  it('1. short-circuits when the desired model is already loaded', async () => {
    const calls: string[] = [];
    const lms = makeLms({ listLoaded: vi.fn(async () => { calls.push('listLoaded'); return [{ identifier: ID }]; }) }, calls);
    const id = await ensureModelReady(M, 64000, noopLogger, makeDeps(lms));
    expect(id).toBe(ID);
    expect(lms.unloadAll).not.toHaveBeenCalled();
    expect(lms.load).not.toHaveBeenCalled();
  });

  it('2. cold load: unload -> resource check -> load, with parallel 1 and no --gpu', async () => {
    const calls: string[] = [];
    let psCall = 0;
    const lms = makeLms({
      listLoaded: vi.fn(async () => { calls.push('listLoaded'); return psCall++ === 0 ? [] : [{ identifier: ID }]; }),
    }, calls);
    const id = await ensureModelReady(M, 64000, noopLogger, makeDeps(lms));
    expect(id).toBe(ID);
    // ordering: unloadAll before load
    expect(calls.indexOf('unloadAll')).toBeLessThan(calls.indexOf('load'));
    // load called with parallel 1 and contextLength; the wrapper omits --gpu (asserted in wrapper tests)
    expect(lms.load).toHaveBeenCalledWith(ID, { contextLength: 64000, parallel: 1 });
  });

  it('3. throws InsufficientResourcesError when totalmem < requiredTotalGB; no load', async () => {
    const lms = makeLms();
    await expect(ensureModelReady(M, 64000, noopLogger, makeDeps(lms, 16))).rejects.toBeInstanceOf(InsufficientResourcesError);
    expect(lms.unloadAll).not.toHaveBeenCalled();
    expect(lms.load).not.toHaveBeenCalled();
  });

  it('4. throws on free-floor breach even when totalmem is OK; no load', async () => {
    const lms = makeLms();
    await expect(ensureModelReady(M, 64000, noopLogger, makeDeps(lms, 31.15, 1.0))).rejects.toBeInstanceOf(InsufficientResourcesError);
    expect(lms.load).not.toHaveBeenCalled();
  });

  it('5. starts the server when it is down, then proceeds', async () => {
    const calls: string[] = [];
    const lms = makeLms({
      serverStatus: vi.fn(async () => { calls.push('serverStatus'); return { running: false, port: 1234 }; }),
      listLoaded: vi.fn(async () => { calls.push('listLoaded'); return [{ identifier: ID }]; }),
    }, calls);
    await ensureModelReady(M, 64000, noopLogger, makeDeps(lms));
    expect(lms.startServer).toHaveBeenCalled();
  });

  it('6. throws when load succeeds but the model is not visible afterward', async () => {
    const lms = makeLms({ listLoaded: vi.fn(async () => []) }); // never matches
    await expect(ensureModelReady(M, 64000, noopLogger, makeDeps(lms))).rejects.toThrow(/not visible/);
  });

  it('7a. unknown override: uses estimateTotalGB + margin for the requirement', async () => {
    const calls: string[] = [];
    let psCall = 0;
    const lms = makeLms({
      estimateTotalGB: vi.fn(async () => { calls.push('estimateTotalGB'); return 18.5; }),
      listLoaded: vi.fn(async () => { calls.push('listLoaded'); return psCall++ === 0 ? [] : [{ identifier: 'some-custom-model' }]; }),
    }, calls);
    const id = await ensureModelReady('some-custom-model', 64000, noopLogger, makeDeps(lms, 31.15));
    expect(id).toBe('some-custom-model');
    expect(lms.estimateTotalGB).toHaveBeenCalled();
  });

  it('7b. unknown override with unparseable estimate: skips capacity gate, still loads', async () => {
    let psCall = 0;
    const lms = makeLms({
      estimateTotalGB: vi.fn(async () => { throw new Error('could not parse'); }),
      listLoaded: vi.fn(async () => psCall++ === 0 ? [] : [{ identifier: 'custom' }]),
    });
    // totalmem deliberately tiny — capacity gate must be skipped, so no throw
    const id = await ensureModelReady('custom', 64000, noopLogger, makeDeps(lms, 4));
    expect(id).toBe('custom');
    expect(lms.load).toHaveBeenCalled();
  });
});

describe('resolveLoadedIdentifier (F3)', () => {
  it('10a. returns the live identifier when still loaded', async () => {
    const lms = makeLms({ listLoaded: vi.fn(async () => [{ identifier: ID }]) });
    const id = await resolveLoadedIdentifier(M, 64000, noopLogger, { readOnly: false }, makeDeps(lms));
    expect(id).toBe(ID);
    expect(lms.unloadAll).not.toHaveBeenCalled();
  });

  it('10b. readOnly:true throws when the model vanished (never reloads)', async () => {
    const lms = makeLms({ listLoaded: vi.fn(async () => []) });
    await expect(resolveLoadedIdentifier(M, 64000, noopLogger, { readOnly: true }, makeDeps(lms)))
      .rejects.toThrow(/no longer loaded/);
    expect(lms.unloadAll).not.toHaveBeenCalled();
    expect(lms.load).not.toHaveBeenCalled();
  });

  it('10c. readOnly:false self-heals via ensureModelReady when the match disappears', async () => {
    let psCall = 0;
    const lms = makeLms({
      // calls 0+1: revalidation + ensureModelReady pre-load check → empty; call 2: post-load readback
      listLoaded: vi.fn(async () => psCall++ < 2 ? [] : [{ identifier: ID }]),
    });
    const id = await resolveLoadedIdentifier(M, 64000, noopLogger, { readOnly: false }, makeDeps(lms));
    expect(id).toBe(ID);
    expect(lms.load).toHaveBeenCalled();
  });
});
