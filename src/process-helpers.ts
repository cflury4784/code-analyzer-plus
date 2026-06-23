import { existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import * as readline from 'readline';
import { openGitNexus } from './gitnexus.js';
import type { GitNexusContext } from './gitnexus.js';
import type { Logger } from './logger.js';

export function spawnAsync(
  cmd: string,
  args: string[],
  opts: { cwd: string; shell: boolean },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { ...opts, stdio: 'inherit' });
    proc.on('close', resolve);
    proc.on('error', reject);
  });
}

export async function detectGitNexus(
  projectRoot: string,
  logger: Logger,
): Promise<GitNexusContext | null> {
  const dbPath = join(projectRoot, '.gitnexus');

  if (!existsSync(dbPath)) {
    console.log(
      '\n\u26A0  GitNexus index not found.\n' +
      '   Run: npx gitnexus analyze\n' +
      '   This enables smarter batching and faster, more accurate results.\n',
    );
    if (!process.stdin.isTTY) {
      logger.info('Non-TTY stdin detected — continuing without GitNexus');
      return null;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(resolve => {
      rl.question('Continue without GitNexus? [y/N] ', resolve);
    });
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      process.exit(0);
    }
    return null;
  }

  logger.info('GitNexus index found — running npx gitnexus analyze to refresh');
  try {
    const exitCode = await spawnAsync('npx', ['gitnexus', 'analyze'], {
      cwd: projectRoot,
      shell: true,
    });
    if (exitCode !== 0) {
      logger.warn('npx gitnexus analyze exited non-zero — skipping GitNexus enrichment', {
        code: exitCode,
      });
      return null;
    }
  } catch {
    logger.warn('npx gitnexus analyze failed to spawn — skipping enrichment');
    return null;
  }

  const ctx = await openGitNexus(projectRoot);
  if (!ctx) {
    logger.warn('GitNexus schema probe failed or DB locked — skipping enrichment');
  }
  return ctx;
}
