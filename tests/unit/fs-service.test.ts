import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { NodeFileSystemService } from '../../src/fs-service.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fs-service-test-'));
}

describe('NodeFileSystemService', () => {
  let tmp: string;
  let fs: NodeFileSystemService;

  beforeEach(() => {
    tmp = tempDir();
    fs = new NodeFileSystemService();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes and reads back file content', () => {
    const p = join(tmp, 'test.txt');
    fs.writeFileSync(p, 'hello world');
    expect(fs.readFileSync(p)).toBe('hello world');
  });

  it('existsSync returns false for missing file, true after write', () => {
    const p = join(tmp, 'missing.txt');
    expect(fs.existsSync(p)).toBe(false);
    fs.writeFileSync(p, 'data');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('mkdirSync creates nested directories and is idempotent', () => {
    const nested = join(tmp, 'a', 'b', 'c');
    fs.mkdirSync(nested);
    expect(fs.existsSync(nested)).toBe(true);
    // calling again should not throw
    fs.mkdirSync(nested);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('join concatenates path segments', () => {
    expect(fs.join('a', 'b', 'c')).toBe('a\\b\\c');
  });

  it('join handles mixed segments', () => {
    expect(fs.join('a', 'b', 'c', 'd.txt')).toBe('a\\b\\c\\d.txt');
  });
});
