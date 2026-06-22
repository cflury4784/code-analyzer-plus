import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('kuzu', () => ({
  default: {
    Database: vi.fn(),
    Connection: vi.fn(),
  },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn() };
});

import { existsSync } from 'fs';
import { openGitNexus, getFileStructure } from '../../src/gitnexus.js';
import type { GitNexusContext } from '../../src/gitnexus.js';
import kuzu from 'kuzu';

const mockExistsSync = vi.mocked(existsSync);
const MockDatabase = vi.mocked(kuzu.Database);
const MockConnection = vi.mocked(kuzu.Connection);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('openGitNexus', () => {
  it('returns null when .gitnexus directory does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await openGitNexus('/project');
    expect(result).toBeNull();
  });

  it('returns context when .gitnexus exists and DB opens', async () => {
    mockExistsSync.mockReturnValue(true);
    const fakeDb = {};
    const fakeConn = { query: vi.fn().mockResolvedValue({ getAll: vi.fn().mockReturnValue([]) }) };
    MockDatabase.mockReturnValue(fakeDb as never);
    MockConnection.mockReturnValue(fakeConn as never);

    const result = await openGitNexus('/project');
    expect(result).not.toBeNull();
    expect(result?.projectRoot).toBe('/project');
    expect(result?.db).toBe(fakeDb);
    expect(result?.conn).toBe(fakeConn);
  });

  it('returns null when kuzu.Database throws', async () => {
    mockExistsSync.mockReturnValue(true);
    MockDatabase.mockImplementation(() => { throw new Error('lock error'); });

    const result = await openGitNexus('/project');
    expect(result).toBeNull();
  });
});

describe('getFileStructure', () => {
  it('returns null when query throws', async () => {
    const fakeConn = {
      query: vi.fn().mockRejectedValue(new Error('db error')),
    };
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: fakeConn as never,
      projectRoot: '/project',
    };
    const result = await getFileStructure(ctx, ['src/foo.ts']);
    expect(result).toBeNull();
  });

  it('maps import edges to FileStructure.imports', async () => {
    const fakeQueryResult = {
      getAll: vi.fn().mockReturnValue([
        { src: 'src/foo.ts', dep: 'src/bar.ts' },
        { src: 'src/foo.ts', dep: 'src/baz.ts' },
      ]),
    };
    const fakeConn = {
      query: vi.fn()
        .mockResolvedValueOnce(fakeQueryResult)   // IMPORTS query
        .mockResolvedValueOnce({ getAll: vi.fn().mockReturnValue([]) }), // CALLS query
    };
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: fakeConn as never,
      projectRoot: '/project',
    };
    const result = await getFileStructure(ctx, ['/project/src/foo.ts']);
    expect(result).not.toBeNull();
    expect(result!.get('src/foo.ts')?.imports).toEqual(['src/bar.ts', 'src/baz.ts']);
  });

  it('returns empty structure for paths with no edges', async () => {
    const fakeConn = {
      query: vi.fn().mockResolvedValue({ getAll: vi.fn().mockReturnValue([]) }),
    };
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: fakeConn as never,
      projectRoot: '/project',
    };
    const result = await getFileStructure(ctx, ['src/isolated.ts']);
    expect(result!.get('src/isolated.ts')).toEqual({ imports: [], calls: [] });
  });

  it('normalizes Windows absolute paths to POSIX relative', async () => {
    const fakeConn = {
      query: vi.fn().mockResolvedValue({ getAll: vi.fn().mockReturnValue([]) }),
    };
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: fakeConn as never,
      projectRoot: 'C:/project',
    };
    const result = await getFileStructure(ctx, ['C:\\project\\src\\foo.ts']);
    expect(result!.has('src/foo.ts')).toBe(true);
  });
});
