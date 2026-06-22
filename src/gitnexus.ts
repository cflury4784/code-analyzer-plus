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
