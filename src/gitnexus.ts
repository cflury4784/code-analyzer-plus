/**
 * GitNexus adapter — queries the local .gitnexus/ knowledge graph via the
 * `gitnexus cypher` CLI subprocess. All public functions return T | null and
 * never throw; callers use null as a signal to fall back to existing behaviour.
 *
 * GitNexus uses LadybugDB (not KuzuDB). The CLI is the supported interface
 * for external processes; there is no public Node.js SDK to import directly.
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface GitNexusContext {
  projectRoot: string;
  repoName: string;  // basename used as the --repo flag value
}

export interface FileStructure {
  imports: string[];  // cross-file call targets (CALLS edges, proxy for dependencies)
  calls: string[];    // alias — same data, kept for API compatibility
}

export interface ImpactResult {
  impactedPaths: string[];  // files whose symbols call into this file (depth 1)
}

/** Normalise an absolute or mixed-separator path to a POSIX-relative path. */
export function toPosixRelative(projectRoot: string, filePath: string): string {
  const rootNorm = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const pathNorm = filePath.replace(/\\/g, '/');
  const rel = pathNorm.toLowerCase().startsWith(rootNorm.toLowerCase())
    ? pathNorm.slice(rootNorm.length).replace(/^\//, '')
    : pathNorm;
  return rel.replace(/^\.\//, '');
}

function escapeCypherString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

interface CypherOutput {
  markdown?: string;
  row_count?: number;
  error?: string;
}

/**
 * Run a Cypher query via `gitnexus cypher` and return parsed row objects.
 * Returns null on process error or schema error; returns [] for empty results.
 */
function runCypher(ctx: GitNexusContext, query: string): Record<string, string>[] | null {
  try {
    const raw = execFileSync(
      'gitnexus',
      ['cypher', '--repo', ctx.repoName, query],
      {
        cwd: ctx.projectRoot,
        encoding: 'utf8',
        timeout: 30_000,
        // stdout is captured; stderr is ignored (gitnexus writes progress to stderr)
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );

    const trimmed = raw.trim();
    if (!trimmed) return [];

    const parsed = JSON.parse(trimmed) as CypherOutput | unknown[];

    // Empty result set
    if (Array.isArray(parsed)) return [];

    // Cypher error
    if ('error' in parsed && parsed.error) return null;

    // Parse markdown table: "| col | col |\n| --- | --- |\n| val | val |"
    const md = parsed.markdown;
    if (!md) return [];

    const lines = md.split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];

    const headers = lines[0]
      .split('|')
      .slice(1, -1)
      .map(h => h.trim());

    // lines[1] is the separator row — skip it
    return lines.slice(2).map(line => {
      const values = line.split('|').slice(1, -1).map(v => v.trim());
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = values[i] ?? ''; });
      return row;
    });
  } catch {
    return null;
  }
}

/** Close any resources. No-op for the CLI adapter (no persistent connection). */
export function closeGitNexus(_ctx: GitNexusContext): void {}

/**
 * Open a GitNexus context for the given project root.
 * Returns null if no .gitnexus index exists or the cypher probe fails.
 */
export async function openGitNexus(projectRoot: string): Promise<GitNexusContext | null> {
  try {
    const metaPath = join(projectRoot, '.gitnexus', 'meta.json');
    if (!existsSync(metaPath)) return null;

    // Derive the repo name (used as the --repo flag) from the directory basename
    const repoName = projectRoot.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop();
    if (!repoName) return null;

    const ctx: GitNexusContext = { projectRoot, repoName };

    // Validate: run a trivial query to confirm the index is readable
    const probe = runCypher(ctx, 'MATCH (f:File) RETURN f.filePath LIMIT 1');
    if (probe === null) return null;

    return ctx;
  } catch {
    return null;
  }
}

/**
 * Return cross-file call dependencies for a set of files.
 * Uses CALLS edges (symbol → symbol across files) as a proxy for imports.
 * Returns null on error; returns a map with empty structures when there are no edges.
 */
export async function getFileStructure(
  ctx: GitNexusContext,
  paths: string[],
): Promise<Map<string, FileStructure> | null> {
  try {
    const normalized = paths.map(p => toPosixRelative(ctx.projectRoot, p));
    const pathList = normalized.map(p => `'${escapeCypherString(p)}'`).join(', ');

    const rows = runCypher(
      ctx,
      `MATCH (a)-[r:CodeRelation {type:'CALLS'}]->(b)
       WHERE a.filePath IN [${pathList}]
       AND b.filePath IS NOT NULL
       AND a.filePath <> b.filePath
       RETURN DISTINCT a.filePath AS src, b.filePath AS dep`,
    );

    if (rows === null) return null;

    const result = new Map<string, FileStructure>();
    for (const p of normalized) result.set(p, { imports: [], calls: [] });

    if (rows.length > 0) {
      for (const row of rows) {
        const src = row['src'];
        const dep = row['dep'];
        if (!src || !dep) continue;
        const s = result.get(src);
        if (s && !s.imports.includes(dep)) {
          s.imports.push(dep);
          s.calls.push(dep);
        }
      }
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * Return a map of community label → file paths belonging to that community.
 * Community membership is derived via symbol MEMBER_OF edges (symbols carry filePath).
 */
export async function getCommunities(
  ctx: GitNexusContext,
): Promise<Map<string, string[]> | null> {
  try {
    const rows = runCypher(
      ctx,
      `MATCH (sym)-[r:CodeRelation {type:'MEMBER_OF'}]->(c:Community)
       WHERE sym.filePath IS NOT NULL
       RETURN DISTINCT sym.filePath AS filePath, c.label AS community`,
    );
    if (rows === null) return null;

    const communities = new Map<string, string[]>();
    for (const row of rows) {
      const fp = row['filePath'];
      const comm = row['community'];
      if (!fp || !comm) continue;
      if (!communities.has(comm)) communities.set(comm, []);
      const files = communities.get(comm)!;
      if (!files.includes(fp)) files.push(fp);
    }
    return communities;
  } catch {
    return null;
  }
}

/**
 * Return the set of files that call into symbols defined in filePath (depth 1).
 */
export async function getImpact(
  ctx: GitNexusContext,
  filePath: string,
): Promise<ImpactResult | null> {
  try {
    const normalized = toPosixRelative(ctx.projectRoot, filePath);
    const rows = runCypher(
      ctx,
      `MATCH (a)-[r:CodeRelation {type:'CALLS'}]->(b)
       WHERE b.filePath = '${escapeCypherString(normalized)}'
       AND a.filePath IS NOT NULL
       AND a.filePath <> b.filePath
       RETURN DISTINCT a.filePath AS depPath`,
    );
    if (rows === null) return null;
    const impactedPaths = rows.map(r => r['depPath']).filter(Boolean);
    return { impactedPaths };
  } catch {
    return null;
  }
}
