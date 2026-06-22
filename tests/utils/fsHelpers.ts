import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export interface TempFsResult {
  /** Absolute path to the temporary root directory. */
  root: string;
  /** Removes the temporary root and all its contents. Call in afterEach. */
  cleanup: () => void;
}

/**
 * Creates a temporary directory under the OS temp folder and returns
 * its path plus a cleanup callback.
 *
 * @param baseDir - Logical name used as a suffix in the directory name
 *                  (e.g. "discovery-test" or "logger-test").
 */
export function createTempFileSystemSetup(baseDir: string): TempFsResult {
  const root = join(tmpdir(), `${baseDir}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
