import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import type { Manifest, FileEntry, PhaseStatus, Phase, BatchPhase } from './types.js';

const MANIFEST_RELATIVE = join('code-analysis', 'manifest.json');

export function manifestPath(projectRoot: string): string {
  return join(projectRoot, MANIFEST_RELATIVE);
}

export function manifestExists(projectRoot: string): boolean {
  return existsSync(manifestPath(projectRoot));
}

export function createManifest(projectRoot: string, files: FileEntry[]): Manifest {
  const now = new Date().toISOString();
  return {
    version: 1,
    created: now,
    last_run: now,
    project_root: projectRoot,
    files,
    batches: { index: [], analyze: [], dedup: [], refactor: [] },
    phases: { index: 'pending', analyze: 'pending', dedup: 'pending', aggregate: 'pending', refactor: 'pending' },
  };
}

export function readManifest(projectRoot: string): Manifest {
  const raw = JSON.parse(readFileSync(manifestPath(projectRoot), 'utf8')) as Manifest;
  // backward compat: initialize dedup fields absent from pre-enhancement manifests
  raw.phases.dedup ??= 'pending';
  raw.batches.dedup ??= [];
  return raw;
}

export function writeManifest(projectRoot: string, manifest: Manifest): void {
  const path = manifestPath(projectRoot);
  const tmp = path + '.tmp';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  renameSync(tmp, path);
}

export function updateBatchStatus(
  projectRoot: string,
  phase: BatchPhase,
  batchId: string,
  status: 'completed' | 'failed',
  attempts: number
): void {
  const manifest = readManifest(projectRoot);
  const batch = manifest.batches[phase].find(b => b.id === batchId);
  if (!batch) throw new Error(`Batch ${batchId} not found in phase ${phase}`);
  batch.status = status;
  batch.attempts = attempts;
  batch.completed_at = status === 'completed' ? new Date().toISOString() : null;
  manifest.last_run = new Date().toISOString();
  writeManifest(projectRoot, manifest);
}

export function updatePhaseStatus(projectRoot: string, phase: Phase, status: PhaseStatus): void {
  const manifest = readManifest(projectRoot);
  manifest.phases[phase] = status;
  manifest.last_run = new Date().toISOString();
  writeManifest(projectRoot, manifest);
}

export function resetPhase(projectRoot: string, phase: Phase): void {
  const manifest = readManifest(projectRoot);
  manifest.phases[phase] = 'pending';
  if (phase !== 'aggregate') {
    const key = phase as BatchPhase;
    manifest.batches[key] = manifest.batches[key].map(b => ({
      ...b,
      status: 'pending' as const,
      attempts: 0,
      completed_at: null,
    }));
  }
  writeManifest(projectRoot, manifest);
}
