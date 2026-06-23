import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Abstraction over Node.js file system operations used by phase modules.
 * Inject a mock in unit tests to avoid real disk I/O.
 * All methods mirror the Node.js fs/path signatures that phase modules use.
 */
export interface FileSystemService {
  readFileSync(path: string): string;
  writeFileSync(path: string, content: string): void;
  /** Creates directory and all intermediate directories (mkdir -p). Does not throw if exists. */
  mkdirSync(path: string): void;
  existsSync(path: string): boolean;
  join(...segments: string[]): string;
}

/**
 * Production implementation — delegates to Node.js built-ins.
 * Construct once per run; share across all phase calls.
 */
export class NodeFileSystemService implements FileSystemService {
  readFileSync(path: string): string {
    return readFileSync(path, 'utf8');
  }
  writeFileSync(path: string, content: string): void {
    writeFileSync(path, content, 'utf8');
  }
  mkdirSync(path: string): void {
    mkdirSync(path, { recursive: true });
  }
  existsSync(path: string): boolean {
    return existsSync(path);
  }
  join(...segments: string[]): string {
    return join(...segments);
  }
}
