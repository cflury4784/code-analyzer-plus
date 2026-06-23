import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { discoverFiles } from '../../src/discovery.js';
import { setupTempFs, type TempFsResult } from '../utils/TestEnvironmentManager.js';
import { FILE_SIZE_LIMIT_BYTES } from '../../config/constants.js';

let fs: TempFsResult;

beforeEach(() => {
  fs = setupTempFs('discovery-test');
});

afterEach(() => {
  fs.cleanup();
});

describe('discoverFiles', () => {
  it('finds files in subdirectories', () => {
    mkdirSync(join(fs.root, 'src'));
    writeFileSync(join(fs.root, 'src', 'a.ts'), 'export const x = 1;');
    const files = discoverFiles(fs.root);
    expect(files.some(f => f.path === 'src/a.ts')).toBe(true);
  });

  it('uses forward slashes on all platforms', () => {
    mkdirSync(join(fs.root, 'src', 'utils'), { recursive: true });
    writeFileSync(join(fs.root, 'src', 'utils', 'helper.ts'), 'x');
    const files = discoverFiles(fs.root);
    expect(files.find(f => f.path.includes('helper'))?.path).toBe('src/utils/helper.ts');
  });

  it('excludes node_modules, .git, dist, build, out, coverage, code-analysis', () => {
    for (const dir of ['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'code-analysis']) {
      mkdirSync(join(fs.root, dir), { recursive: true });
      writeFileSync(join(fs.root, dir, 'file.js'), 'x');
    }
    const files = discoverFiles(fs.root);
    expect(files).toHaveLength(0);
  });

  it('marks files over FILE_SIZE_LIMIT_BYTES as skipped with skip_reason size_exceeded', () => {
    writeFileSync(join(fs.root, 'big.ts'), 'x'.repeat(FILE_SIZE_LIMIT_BYTES + 1));
    const files = discoverFiles(fs.root);
    const big = files.find(f => f.path === 'big.ts');
    expect(big?.skipped).toBe(true);
    expect(big?.skip_reason).toBe('size_exceeded');
  });

  it('includes size_bytes for each file', () => {
    writeFileSync(join(fs.root, 'a.ts'), 'hello');
    const files = discoverFiles(fs.root);
    expect(files[0].size_bytes).toBe(5);
  });

  it('does not skip files under FILE_SIZE_LIMIT_BYTES', () => {
    writeFileSync(join(fs.root, 'normal.ts'), 'export const x = 1;');
    const files = discoverFiles(fs.root);
    expect(files[0].skipped).toBe(false);
    expect(files[0].skip_reason).toBeNull();
  });

  it('reads .gitignore and excludes matched directories', () => {
    writeFileSync(join(fs.root, '.gitignore'), 'custom-excluded/\n');
    mkdirSync(join(fs.root, 'custom-excluded'), { recursive: true });
    writeFileSync(join(fs.root, 'custom-excluded', 'file.ts'), 'x');
    writeFileSync(join(fs.root, 'keep.ts'), 'x');
    const files = discoverFiles(fs.root);
    expect(files.some(f => f.path.startsWith('custom-excluded/'))).toBe(false);
    expect(files.some(f => f.path === 'keep.ts')).toBe(true);
  });

  it('reads .gitignore and excludes matched files by glob', () => {
    writeFileSync(join(fs.root, '.gitignore'), '*.log\n');
    writeFileSync(join(fs.root, 'app.log'), 'x');
    writeFileSync(join(fs.root, 'app.ts'), 'x');
    const files = discoverFiles(fs.root);
    expect(files.some(f => f.path === 'app.log')).toBe(false);
    expect(files.some(f => f.path === 'app.ts')).toBe(true);
  });

  it('respects .gitignore negation patterns', () => {
    writeFileSync(join(fs.root, '.gitignore'), '*.log\n!important.log\n');
    writeFileSync(join(fs.root, 'debug.log'), 'x');
    writeFileSync(join(fs.root, 'important.log'), 'x');
    const files = discoverFiles(fs.root);
    expect(files.some(f => f.path === 'debug.log')).toBe(false);
    expect(files.some(f => f.path === 'important.log')).toBe(true);
  });

  it('always excludes code-analysis/ even when not in .gitignore', () => {
    writeFileSync(join(fs.root, '.gitignore'), '# no exclusions\n');
    mkdirSync(join(fs.root, 'code-analysis'), { recursive: true });
    writeFileSync(join(fs.root, 'code-analysis', 'manifest.json'), '{}');
    const files = discoverFiles(fs.root);
    expect(files.some(f => f.path.startsWith('code-analysis/'))).toBe(false);
  });

  it('always excludes .git/ even when not in .gitignore', () => {
    writeFileSync(join(fs.root, '.gitignore'), '# no exclusions\n');
    mkdirSync(join(fs.root, '.git'), { recursive: true });
    writeFileSync(join(fs.root, '.git', 'HEAD'), 'ref: refs/heads/main');
    const files = discoverFiles(fs.root);
    expect(files.some(f => f.path.startsWith('.git/'))).toBe(false);
  });
});

describe('discoverFiles — .md exclusion', () => {
  it('excludes .md files', () => {
    writeFileSync(join(fs.root, 'README.md'), '# docs');
    writeFileSync(join(fs.root, 'index.ts'), 'export {}');
    const files = discoverFiles(fs.root);
    expect(files.map(f => f.path)).not.toContain('README.md');
    expect(files.map(f => f.path)).toContain('index.ts');
  });

  it('excludes nested .md files', () => {
    mkdirSync(join(fs.root, 'src'), { recursive: true });
    writeFileSync(join(fs.root, 'src', 'NOTES.md'), '# notes');
    writeFileSync(join(fs.root, 'src', 'util.ts'), 'export {}');
    const files = discoverFiles(fs.root);
    expect(files.map(f => f.path)).not.toContain('src/NOTES.md');
    expect(files.map(f => f.path)).toContain('src/util.ts');
  });
});
