import kuzu from 'kuzu';
import type { QueryResult, KuzuValue } from 'kuzu';
import { existsSync } from 'fs';
import { join, relative } from 'path';

export interface GitNexusContext {
  db: InstanceType<typeof kuzu.Database>;
  conn: InstanceType<typeof kuzu.Connection>;
  projectRoot: string;
}

export interface FileStructure {
  imports: string[];  // POSIX-relative paths this file imports
  calls: string[];    // POSIX-relative paths of files containing called symbols
}

export interface ImpactResult {
  impactedPaths: string[];  // files that directly import this file (depth 1)
}

export function toPosixRelative(projectRoot: string, filePath: string): string {
  // Case-insensitive startsWith for Windows (paths are case-insensitive on NTFS)
  const rootNorm = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const pathNorm = filePath.replace(/\\/g, '/');
  const rel = pathNorm.toLowerCase().startsWith(rootNorm.toLowerCase())
    ? pathNorm.slice(rootNorm.length).replace(/^\//, '')
    : pathNorm;
  return rel.replace(/^\.\//, '');
}

function unwrap(r: QueryResult | QueryResult[]): QueryResult {
  return Array.isArray(r) ? r[0] : r;
}

async function execParams(
  conn: InstanceType<typeof kuzu.Connection>,
  statement: string,
  params: Record<string, KuzuValue>,
): Promise<QueryResult> {
  const ps = await conn.prepare(statement);
  const r = await conn.execute(ps, params);
  return unwrap(r);
}

async function validateSchema(ctx: GitNexusContext): Promise<boolean> {
  try {
    const r = await ctx.conn.query('MATCH (f:File) RETURN f.path LIMIT 1');
    unwrap(r).getAllSync();
    return true;
  } catch {
    return false;
  }
}

export function closeGitNexus(ctx: GitNexusContext): void {
  try { ctx.conn.closeSync(); } catch {}
  try { ctx.db.closeSync(); } catch {}
}

export async function openGitNexus(projectRoot: string): Promise<GitNexusContext | null> {
  try {
    const dbPath = join(projectRoot, '.gitnexus');
    if (!existsSync(dbPath)) return null;
    // readOnly=true — prevents write-lock conflicts with the MCP server
    // constructor: (path, bufferManagerSize?, enableCompression?, readOnly?, maxDBSize?, ...)
    const db = new kuzu.Database(dbPath, undefined, undefined, true);
    const conn = new kuzu.Connection(db);
    const ctx = { db, conn, projectRoot };
    const valid = await validateSchema(ctx);
    if (!valid) { closeGitNexus(ctx); return null; }
    return ctx;
  } catch {
    return null;
  }
}

export async function getFileStructure(
  ctx: GitNexusContext,
  paths: string[],
): Promise<Map<string, FileStructure> | null> {
  try {
    const normalized = paths.map(p => toPosixRelative(ctx.projectRoot, p));

    // Run both queries in parallel; prepare+execute for parameterized form (no injection)
    const [importResult, callResult] = await Promise.all([
      execParams(ctx.conn,
        `MATCH (f:File)-[:CodeRelation {type: 'IMPORTS'}]->(dep:File)
         WHERE f.path IN $paths
         RETURN f.path AS src, dep.path AS dep`,
        { paths: normalized },
      ),
      execParams(ctx.conn,
        `MATCH (f:File)-[:CodeRelation {type: 'CALLS'}]->(sym)
         WHERE f.path IN $paths
         RETURN f.path AS src, sym.filePath AS dep`,
        { paths: normalized },
      ),
    ]);

    const importRows = importResult.getAllSync() as Array<{ src: string; dep: string }>;
    const callRows = callResult.getAllSync() as Array<{ src: string; dep: string }>;

    const result = new Map<string, FileStructure>();
    for (const p of normalized) result.set(p, { imports: [], calls: [] });

    for (const row of importRows) {
      if (!row.src || !row.dep) continue;
      const s = result.get(row.src);
      if (s && !s.imports.includes(row.dep)) s.imports.push(row.dep);
    }
    for (const row of callRows) {
      if (!row.src || !row.dep) continue;
      const s = result.get(row.src);
      if (s && !s.calls.includes(row.dep)) s.calls.push(row.dep);
    }
    return result;
  } catch {
    return null;
  }
}

export async function getCommunities(
  ctx: GitNexusContext,
): Promise<Map<string, string[]> | null> {
  try {
    const raw = await ctx.conn.query(
      `MATCH (f:File)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
       RETURN f.path AS filePath, c.name AS community`,
    );
    const rows = unwrap(raw).getAllSync() as Array<{ filePath: string; community: string }>;

    const communities = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.filePath || !row.community) continue;
      if (!communities.has(row.community)) communities.set(row.community, []);
      communities.get(row.community)!.push(row.filePath);
    }
    return communities;
  } catch {
    return null;
  }
}

export async function getImpact(
  ctx: GitNexusContext,
  filePath: string,
): Promise<ImpactResult | null> {
  try {
    const normalized = toPosixRelative(ctx.projectRoot, filePath);
    // prepare+execute for parameterized form — no string interpolation of file paths
    const result = await execParams(ctx.conn,
      `MATCH (dep:File)-[:CodeRelation {type: 'IMPORTS'}]->(f:File)
       WHERE f.path = $path
       RETURN DISTINCT dep.path AS depPath`,
      { path: normalized },
    );
    const rows = result.getAllSync() as Array<{ depPath: string }>;
    const impactedPaths = rows.map(r => r.depPath).filter(Boolean);
    return { impactedPaths };
  } catch {
    return null;
  }
}
