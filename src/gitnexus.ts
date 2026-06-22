import kuzu from 'kuzu';
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

async function validateSchema(ctx: GitNexusContext): Promise<boolean> {
  try {
    const r = await ctx.conn.query('MATCH (f:File) RETURN f.path LIMIT 1');
    r.getAll();
    return true;
  } catch {
    return false;
  }
}

export function closeGitNexus(ctx: GitNexusContext): void {
  try {
    (ctx.conn as { close?: () => void }).close?.();
    (ctx.db as { close?: () => void }).close?.();
  } catch {}
}

export async function openGitNexus(projectRoot: string): Promise<GitNexusContext | null> {
  try {
    const dbPath = join(projectRoot, '.gitnexus');
    if (!existsSync(dbPath)) return null;
    // readOnly=true (5th arg) prevents write-lock conflicts with the MCP server
    // NOTE: verify constructor signature against installed kuzu version before use:
    //   check node_modules/kuzu/README.md or kuzu.d.ts — signature varies by release
    const db = new kuzu.Database(dbPath, 0, 0, true, true);
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

    // Run both queries in parallel; use parameterized form to avoid Cypher injection
    const [importResult, callResult] = await Promise.all([
      ctx.conn.query(
        `MATCH (f:File)-[:CodeRelation {type: 'IMPORTS'}]->(dep:File)
         WHERE f.path IN $paths
         RETURN f.path AS src, dep.path AS dep`,
        { paths: normalized },
      ),
      ctx.conn.query(
        `MATCH (f:File)-[:CodeRelation {type: 'CALLS'}]->(sym)
         WHERE f.path IN $paths
         RETURN f.path AS src, sym.filePath AS dep`,
        { paths: normalized },
      ),
    ]);

    const importRows = importResult.getAll() as Array<{ src: string; dep: string }>;
    const callRows = callResult.getAll() as Array<{ src: string; dep: string }>;

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
    const result = await ctx.conn.query(
      `MATCH (f:File)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
       RETURN f.path AS filePath, c.name AS community`,
    );
    const rows = result.getAll() as Array<{ filePath: string; community: string }>;

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
    // Parameterized query — no string interpolation of file paths
    const result = await ctx.conn.query(
      `MATCH (dep:File)-[:CodeRelation {type: 'IMPORTS'}]->(f:File)
       WHERE f.path = $path
       RETURN DISTINCT dep.path AS depPath`,
      { path: normalized },
    );
    const rows = result.getAll() as Array<{ depPath: string }>;
    const impactedPaths = rows.map(r => r.depPath).filter(Boolean);
    return { impactedPaths };
  } catch {
    return null;
  }
}
