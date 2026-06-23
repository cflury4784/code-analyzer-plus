import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export interface TempFsResult {
  root: string;
  cleanup: () => void;
}

/**
 * Creates a temporary directory. Returns fresh, independent state per call.
 * No shared mutable state in this module — test isolation is structural.
 */
export function setupTempFs(baseDir: string): TempFsResult {
  const root = join(tmpdir(), `${baseDir}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Captures a snapshot of named env vars and returns a restore function.
 * Call restore() in afterEach.
 */
export function snapshotEnv(keys: string[]): { restore: () => void } {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) saved[key] = process.env[key];
  return {
    restore: () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

/**
 * Restores process.env entries from a pre-captured snapshot object.
 * Re-exported for incremental migration; prefer snapshotEnv for new code.
 * TODO: remove after all callers use snapshotEnv.
 */
export function restoreEnvVars(envVars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(envVars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
