import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(), readFileSync: vi.fn() };
});

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import {
  openGitNexus,
  closeGitNexus,
  getFileStructure,
  getCommunities,
  getImpact,
  toPosixRelative,
} from '../../src/gitnexus.js';
import type { GitNexusContext } from '../../src/gitnexus.js';

const mockExec = vi.mocked(execFileSync);
const mockExists = vi.mocked(existsSync);

// Helpers — build gitnexus cypher CLI output
function cypherRows(headers: string[], rows: string[][]): string {
  const header = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const data = rows.map(r => `| ${r.join(' | ')} |`).join('\n');
  return JSON.stringify({ markdown: [header, sep, data].join('\n'), row_count: rows.length });
}
const cypherEmpty = () => '[]';
const cypherError = (msg: string) => JSON.stringify({ error: msg });

const CTX: GitNexusContext = { projectRoot: '/project', repoName: 'project' };

beforeEach(() => { vi.clearAllMocks(); });

// ─── toPosixRelative ───────────────────────────────────────────────────────

describe('toPosixRelative', () => {
  it('strips project root prefix', () => {
    expect(toPosixRelative('/project', '/project/src/foo.ts')).toBe('src/foo.ts');
  });
  it('is case-insensitive on Windows paths', () => {
    expect(toPosixRelative('C:/Project', 'C:\\project\\src\\foo.ts')).toBe('src/foo.ts');
  });
  it('returns path unchanged when not under root', () => {
    expect(toPosixRelative('/project', 'src/bar.ts')).toBe('src/bar.ts');
  });
});

// ─── openGitNexus ──────────────────────────────────────────────────────────

describe('openGitNexus', () => {
  it('returns null when .gitnexus/meta.json does not exist', async () => {
    mockExists.mockReturnValue(false);
    expect(await openGitNexus('/project')).toBeNull();
  });

  it('returns context when index exists and probe succeeds', async () => {
    mockExists.mockReturnValue(true);
    mockExec.mockReturnValue(cypherRows(['f.filePath'], [['src/foo.ts']]) as never);
    const ctx = await openGitNexus('/project');
    expect(ctx).not.toBeNull();
    expect(ctx?.repoName).toBe('project');
    expect(ctx?.projectRoot).toBe('/project');
  });

  it('returns null when cypher probe returns an error', async () => {
    mockExists.mockReturnValue(true);
    mockExec.mockReturnValue(cypherError('Table not found') as never);
    expect(await openGitNexus('/project')).toBeNull();
  });

  it('returns null when execFileSync throws', async () => {
    mockExists.mockReturnValue(true);
    mockExec.mockImplementation(() => { throw new Error('spawn error'); });
    expect(await openGitNexus('/project')).toBeNull();
  });
});

// ─── closeGitNexus ─────────────────────────────────────────────────────────

describe('closeGitNexus', () => {
  it('is a no-op (CLI adapter has no persistent connection)', () => {
    expect(() => closeGitNexus(CTX)).not.toThrow();
  });
});

// ─── getFileStructure ──────────────────────────────────────────────────────

describe('getFileStructure', () => {
  it('returns null when execFileSync throws', async () => {
    mockExec.mockImplementation(() => { throw new Error('spawn'); });
    expect(await getFileStructure(CTX, ['src/foo.ts'])).toBeNull();
  });

  it('returns null when cypher returns an error', async () => {
    mockExec.mockReturnValue(cypherError('db error') as never);
    expect(await getFileStructure(CTX, ['src/foo.ts'])).toBeNull();
  });

  it('maps CALLS edges to imports', async () => {
    mockExec.mockReturnValue(
      cypherRows(['src', 'dep'], [
        ['src/foo.ts', 'src/bar.ts'],
        ['src/foo.ts', 'src/baz.ts'],
      ]) as never,
    );
    const result = await getFileStructure(CTX, ['src/foo.ts']);
    expect(result?.get('src/foo.ts')?.imports).toEqual(['src/bar.ts', 'src/baz.ts']);
  });

  it('returns empty structure when no CALLS edges', async () => {
    mockExec.mockReturnValue(cypherEmpty() as never);
    const result = await getFileStructure(CTX, ['src/isolated.ts']);
    expect(result?.get('src/isolated.ts')).toEqual({ imports: [], calls: [] });
  });

  it('normalises Windows absolute paths to POSIX relative before querying', async () => {
    mockExec.mockReturnValue(cypherEmpty() as never);
    const result = await getFileStructure(
      { projectRoot: 'C:/project', repoName: 'project' },
      ['C:\\project\\src\\foo.ts'],
    );
    expect(result?.has('src/foo.ts')).toBe(true);
  });
});

// ─── getCommunities ────────────────────────────────────────────────────────

describe('getCommunities', () => {
  it('returns null when cypher returns an error', async () => {
    mockExec.mockReturnValue(cypherError('fail') as never);
    expect(await getCommunities(CTX)).toBeNull();
  });

  it('groups file paths by community label', async () => {
    mockExec.mockReturnValue(
      cypherRows(['filePath', 'community'], [
        ['src/auth/login.ts', 'Cluster_1'],
        ['src/auth/logout.ts', 'Cluster_1'],
        ['src/ui/button.ts', 'Cluster_2'],
      ]) as never,
    );
    const result = await getCommunities(CTX);
    expect(result?.get('Cluster_1')).toEqual(['src/auth/login.ts', 'src/auth/logout.ts']);
    expect(result?.get('Cluster_2')).toEqual(['src/ui/button.ts']);
  });

  it('returns empty map when no MEMBER_OF edges', async () => {
    mockExec.mockReturnValue(cypherEmpty() as never);
    expect((await getCommunities(CTX))?.size).toBe(0);
  });
});

// ─── getImpact ─────────────────────────────────────────────────────────────

describe('getImpact', () => {
  it('returns null when execFileSync throws', async () => {
    mockExec.mockImplementation(() => { throw new Error('spawn'); });
    expect(await getImpact(CTX, 'src/utils.ts')).toBeNull();
  });

  it('returns impacted file paths', async () => {
    mockExec.mockReturnValue(
      cypherRows(['depPath'], [
        ['src/components/Header.tsx'],
        ['src/pages/Home.tsx'],
      ]) as never,
    );
    const result = await getImpact(CTX, 'src/utils.ts');
    expect(result?.impactedPaths).toEqual(['src/components/Header.tsx', 'src/pages/Home.tsx']);
  });

  it('normalises filePath in the cypher query', async () => {
    mockExec.mockReturnValue(cypherEmpty() as never);
    await getImpact({ projectRoot: 'C:/project', repoName: 'project' }, 'C:\\project\\src\\utils.ts');
    const query = (mockExec as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    // The cypher query arg should contain the normalised path
    expect(query[query.length - 1]).toContain("'src/utils.ts'");
  });

  it('returns empty impactedPaths when no callers', async () => {
    mockExec.mockReturnValue(cypherEmpty() as never);
    const result = await getImpact(CTX, 'src/leaf.ts');
    expect(result?.impactedPaths).toEqual([]);
  });
});
