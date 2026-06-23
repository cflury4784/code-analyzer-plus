import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import type { FileEntry } from './types.js';
import ignore, { type Ignore } from 'ignore';
import { FILE_SIZE_LIMIT_BYTES } from '../config/constants.js';

const ALWAYS_EXCLUDED = new Set([
  'code-analysis', '.git',
  '.gitnexus',     // GitNexus index metadata — generated, never a refactor target
  '.superpowers',  // tooling artifacts (brainstorms, plans, archived analyses)
  '.claude',       // IDE settings — never source code
]);

const FALLBACK_EXCLUDED = new Set([
  'node_modules', '.worktrees', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.turbo', '.cache', '__pycache__', '.venv', 'venv',
  '.svelte-kit', '.parcel-cache', 'tmp', 'temp',
  '.ruff_cache', '.mypy_cache', '.pytest_cache',  // Python tool caches
  '.vercel',
]);

const EXCLUDED_NAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Gemfile.lock',
  'Cargo.lock', 'composer.lock', 'poetry.lock', 'Pipfile.lock',
  '.env.local', '.env.production.local', '.env.development.local', '.env.test.local',
]);

const EXCLUDED_EXTENSIONS = new Set([
  '.md',
  '.lock', '.snap', '.map', '.min.js', '.min.css',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.svg', '.pdf', '.ai', '.psd', '.sketch',
  '.otf', '.ttf', '.woff', '.woff2', '.eot',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.avi',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib',
]);

function buildIgnore(projectRoot: string): Ignore | null {
  const gitignorePath = join(projectRoot, '.gitignore');
  if (!existsSync(gitignorePath)) return null;
  return ignore().add(readFileSync(gitignorePath, 'utf8'));
}

function isExcludedFile(name: string): boolean {
  if (EXCLUDED_NAMES.has(name)) return true;
  const lower = name.toLowerCase();
  for (const ext of EXCLUDED_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

export function discoverFiles(projectRoot: string): FileEntry[] {
  // Exclusion precedence (mutually exclusive code paths — no conflict possible):
  //   1. ALWAYS_EXCLUDED: applied first, unconditionally, before any .gitignore or fallback check.
  //   2. .gitignore (dynamic): if a .gitignore exists, buildIgnore returns an ignore instance and
  //      FALLBACK_EXCLUDED is never consulted for directory skipping (ig !== null branch below).
  //   3. FALLBACK_EXCLUDED (static): used only when no .gitignore exists (ig === null).
  //      Dynamic (.gitignore) always wins because the two paths are mutually exclusive.
  const ig = buildIgnore(projectRoot);
  const results: FileEntry[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ALWAYS_EXCLUDED.has(entry.name)) continue;

      const full = join(dir, entry.name);
      const relPath = relative(projectRoot, full).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (ig !== null) {
          // .gitignore present — dynamic exclusion; FALLBACK_EXCLUDED unreachable here.
          if (ig.ignores(relPath + '/')) continue;
        } else {
          // No .gitignore — use static fallback.
          if (FALLBACK_EXCLUDED.has(entry.name)) continue;
        }
        walk(full);
      } else if (entry.isFile()) {
        if (isExcludedFile(entry.name)) continue;
        if (ig !== null && ig.ignores(relPath)) continue;
        const size_bytes = statSync(full).size;
        results.push(
          size_bytes > FILE_SIZE_LIMIT_BYTES
            ? { path: relPath, size_bytes, skipped: true, skip_reason: 'size_exceeded' }
            : { path: relPath, size_bytes, skipped: false, skip_reason: null }
        );
      }
    }
  }

  walk(projectRoot);
  return results;
}
