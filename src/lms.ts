import { spawn } from 'child_process';

export interface LoadedModel {
  identifier: string;
  [k: string]: unknown;
}

export interface RunOpts {
  timeoutMs?: number;
}

/** Type of the runLms seam — exported so tests can type their mocks without `typeof` gymnastics. */
export type RunLms = typeof runLms;

/** Strip ANSI escape sequences (lms human output may be colored on a TTY). */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * Windows .cmd shim note: `shell: true` lets Windows resolve `lms` as either
 * .exe or .cmd shim (npm global install). The full command is passed as a
 * single joined string (not args array) to avoid Node.js DEP0190
 * (shell=true + args array deprecation). This matches the original spawnSync
 * pattern. The async conversion preserves both constraints.
 */
export async function runLms(args: string[], opts: RunOpts = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const cmd = 'lms ' + args.join(' ');
    const proc = spawn(cmd, [], { shell: true } as Parameters<typeof spawn>[2]);

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, opts.timeoutMs);
    }

    (proc.stdout as NodeJS.ReadableStream | null)?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    (proc.stderr as NodeJS.ReadableStream | null)?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (timer !== undefined) clearTimeout(timer);
      if (err.code === 'ENOENT') {
        return reject(new Error('lms binary not found on PATH — is LM Studio CLI installed?'));
      }
      reject(new Error(`lms ${args[0] ?? ''} failed: ${err.message}`));
    });

    proc.on('close', (code: number | null) => {
      if (timer !== undefined) clearTimeout(timer);
      if (timedOut) {
        return reject(new Error(`lms ${args[0] ?? ''} timed out after ${(opts.timeoutMs ?? 0) / 1000}s`));
      }
      if (code !== 0) {
        return reject(new Error(`lms ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
      }
      resolve(stdout);
    });
  });
}

/** Defensive JSON parse with a labeled error and a validator. */
function parseJson<T>(cmdLabel: string, raw: string, validate: (v: unknown) => v is T): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`lms ${cmdLabel} returned unparseable output: ${raw.slice(0, 200)}`);
  }
  if (!validate(parsed)) {
    throw new Error(`lms ${cmdLabel} returned unexpected shape: ${raw.slice(0, 200)}`);
  }
  return parsed;
}

export async function serverStatus(deps: { runLms: typeof runLms } = { runLms }): Promise<{ running: boolean; port: number }> {
  const raw = await deps.runLms(['server', 'status', '--json', '--quiet']);
  return parseJson('server status', raw, (v): v is { running: boolean; port: number } =>
    typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).running === 'boolean');
}

export async function startServer(
  deps: { runLms: typeof runLms; serverStatus: typeof serverStatus } = { runLms, serverStatus },
  pollBudgetMs = 30_000,
  pollIntervalMs = 1_000,
): Promise<void> {
  await deps.runLms(['server', 'start']);
  const deadline = Date.now() + pollBudgetMs;
  // Provisional ~30s budget: a cold start with ROCm runtime init can exceed 15s.
  while (Date.now() < deadline) {
    const s = await deps.serverStatus({ runLms: deps.runLms });
    if (s.running) return;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`lms server did not report running within ${pollBudgetMs / 1000}s`);
}

export async function listLoaded(deps: { runLms: typeof runLms } = { runLms }): Promise<LoadedModel[]> {
  const raw = await deps.runLms(['ps', '--json']);
  return parseJson('ps', raw, (v): v is LoadedModel[] =>
    Array.isArray(v) && v.every((e) => typeof e === 'object' && e !== null && typeof (e as Record<string, unknown>).identifier === 'string'));
}

export async function unloadAll(deps: { runLms: typeof runLms } = { runLms }): Promise<void> {
  await deps.runLms(['unload', '--all']);
}

/**
 * Returns the RAW parsed `Estimated Total Memory` in GiB (no margin/rounding — preflight
 * applies those). Throws a labeled error if the line is absent/unparseable. Used only for
 * unknown overrides (F4).
 */
export async function estimateTotalGB(
  loadKey: string,
  contextLength: number,
  deps: { runLms: typeof runLms } = { runLms },
): Promise<number> {
  const raw = stripAnsi(await deps.runLms([
    'load', loadKey, '--parallel', '1', '--context-length', String(contextLength), '--estimate-only',
  ]));
  // Example line: "Estimated Total Memory: 18.52 GiB" (tolerant of ANSI/spacing, stripped above)
  const m = raw.match(/Estimated Total Memory:[^\d]*?([\d.]+)\s*GiB/i);
  if (!m) {
    throw new Error(`lms estimate-only: could not parse Estimated Total Memory from: ${raw.slice(0, 200)}`);
  }
  return parseFloat(m[1]);
}

export interface LoadOpts {
  contextLength: number;
  parallel?: number;
  timeoutMs?: number;
}

const DEFAULT_LOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Loads a model with auto-fit (NO --gpu flag — `--gpu max` would disable auto-fit and OOM-crash
 * >12GB models on this APU). Bounded timeout so a hung load fails with a labeled error.
 */
export async function load(
  loadKey: string,
  opts: LoadOpts,
  deps: { runLms: typeof runLms } = { runLms },
): Promise<void> {
  const parallel = opts.parallel ?? 1;
  await deps.runLms(
    ['load', loadKey, '--parallel', String(parallel), '--context-length', String(opts.contextLength), '--yes'],
    { timeoutMs: opts.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS },
  );
}

/** Bundle type so preflight can accept an injectable `lms` dependency. */
export interface Lms {
  serverStatus(deps?: { runLms: RunLms }): Promise<{ running: boolean; port: number }>;
  startServer(
    deps?: { runLms: RunLms; serverStatus(d?: { runLms: RunLms }): Promise<{ running: boolean; port: number }> },
    pollBudgetMs?: number,
    pollIntervalMs?: number,
  ): Promise<void>;
  listLoaded(deps?: { runLms: RunLms }): Promise<LoadedModel[]>;
  unloadAll(deps?: { runLms: RunLms }): Promise<void>;
  estimateTotalGB(loadKey: string, contextLength: number, deps?: { runLms: RunLms }): Promise<number>;
  load(loadKey: string, opts: LoadOpts, deps?: { runLms: RunLms }): Promise<void>;
}

export const lms: Lms = { serverStatus, startServer, listLoaded, unloadAll, estimateTotalGB, load };
