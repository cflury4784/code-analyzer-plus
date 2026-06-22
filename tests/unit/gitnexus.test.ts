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
import { openGitNexus, getFileStructure, getCommunities, getImpact } from '../../src/gitnexus.js';
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

describe('getCommunities', () => {
  it('returns null when query throws', async () => {
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: { query: vi.fn().mockRejectedValue(new Error('fail')) } as never,
      projectRoot: '/project',
    };
    expect(await getCommunities(ctx)).toBeNull();
  });

  it('groups file paths by community name', async () => {
    const rows = [
      { filePath: 'src/auth/login.ts', community: 'auth' },
      { filePath: 'src/auth/logout.ts', community: 'auth' },
      { filePath: 'src/ui/button.ts', community: 'ui' },
    ];
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: {
        query: vi.fn().mockResolvedValue({ getAll: vi.fn().mockReturnValue(rows) }),
      } as never,
      projectRoot: '/project',
    };
    const result = await getCommunities(ctx);
    expect(result!.get('auth')).toEqual(['src/auth/login.ts', 'src/auth/logout.ts']);
    expect(result!.get('ui')).toEqual(['src/ui/button.ts']);
  });

  it('returns empty map when no community edges', async () => {
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: {
        query: vi.fn().mockResolvedValue({ getAll: vi.fn().mockReturnValue([]) }),
      } as never,
      projectRoot: '/project',
    };
    expect((await getCommunities(ctx))!.size).toBe(0);
  });
});

describe('getImpact', () => {
  it('returns null when query throws', async () => {
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: { query: vi.fn().mockRejectedValue(new Error('fail')) } as never,
      projectRoot: '/project',
    };
    expect(await getImpact(ctx, 'src/utils.ts')).toBeNull();
  });

  it('returns list of files that import this file', async () => {
    const rows = [
      { depPath: 'src/components/Header.tsx' },
      { depPath: 'src/pages/Home.tsx' },
    ];
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: {
        query: vi.fn().mockResolvedValue({ getAll: vi.fn().mockReturnValue(rows) }),
      } as never,
      projectRoot: '/project',
    };
    const result = await getImpact(ctx, 'src/utils.ts');
    expect(result!.impactedPaths).toEqual(['src/components/Header.tsx', 'src/pages/Home.tsx']);
  });

  it('normalizes filePath before querying', async () => {
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: {
        query: vi.fn().mockResolvedValue({ getAll: vi.fn().mockReturnValue([]) }),
      } as never,
      projectRoot: 'C:/project',
    };
    await getImpact(ctx, 'C:\\project\\src\\utils.ts');
    const params = (ctx.conn.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(params.path).toBe('src/utils.ts');
  });

  it('returns empty impactedPaths when no dependents', async () => {
    const ctx: GitNexusContext = {
      db: {} as never,
      conn: {
        query: vi.fn().mockResolvedValue({ getAll: vi.fn().mockReturnValue([]) }),
      } as never,
      projectRoot: '/project',
    };
    const result = await getImpact(ctx, 'src/leaf.ts');
    expect(result!.impactedPaths).toEqual([]);
  });
});
