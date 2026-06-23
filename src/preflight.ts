import { spawnSync } from 'child_process';
import { totalmem as osTotalmem, freemem as osFreemem } from 'os';
import { FREE_FLOOR_GB, ESTIMATE_MARGIN_GB } from './models.js';
import { resolveModelIdentifier } from './utils/index.js';
import { lmsRest as defaultLms } from './lms-rest.js';
import type { Lms } from './lms.js';
import type { Logger } from './logger.js';
import { createPlatformAdapter, type PlatformAdapter } from './platform-adapter.js';

export class InsufficientResourcesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientResourcesError';
  }
}

/**
 * Query total GPU VRAM in GiB. Tries nvidia-smi first (fast, NVIDIA-only), then falls back to
 * platform-specific probe. Returns 0 if both fail.
 * WMI AdapterRAM is intentionally avoided — it's a uint32 field and silently wraps for >4 GB VRAM.
 */
async function queryGpuVramGB(platform: PlatformAdapter): Promise<number> {
  // NVIDIA fast path (cross-platform — fails gracefully on non-NVIDIA machines)
  const nv = spawnSync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', [], {
    encoding: 'utf8', shell: true, timeout: 5000,
  });
  if (nv.status === 0 && nv.stdout?.trim()) {
    const mib = nv.stdout.trim().split('\n')
      .map((l) => parseInt(l.trim(), 10)).filter((n) => !isNaN(n))
      .reduce((a, b) => a + b, 0);
    if (mib > 0) return mib / 1024;
  }
  // Platform-specific fallback (DXGI on win32, no-op on posix)
  return platform.queryGpuVramGbFallback();
}

export interface PreflightDeps {
  lms: Lms;
  totalmem: () => number;
  freemem: () => number;
  gpuVramGB?: () => Promise<number>;
  platform: PlatformAdapter;
}

const defaultAdapter = createPlatformAdapter();

const defaultDeps: PreflightDeps = {
  lms: defaultLms,
  totalmem: osTotalmem,
  freemem: osFreemem,
  gpuVramGB: () => queryGpuVramGB(defaultAdapter),
  platform: defaultAdapter,
};

const toGiB = (bytes: number): number => bytes / 1024 ** 3;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Ensure the server is up and `modelName` is loaded; return the live identifier `lms ps`
 * reports (the value to send as the API `model` field). Throws InsufficientResourcesError
 * if the box cannot hold the model, or a labeled Error on lms/lifecycle failures.
 */
export async function ensureModelReady(
  modelName: string,
  numCtx: number,
  logger: Logger,
  deps: PreflightDeps = defaultDeps,
): Promise<string> {
  const { spec, known } = resolveModelIdentifier(modelName);

  // 1. If server is already running, check for an existing load first — fast exit with no
  //    unload/reload needed. We probe without starting the server so a capacity failure never
  //    leaves a newly-started server behind.
  const status = await deps.lms.serverStatus();
  if (status.running) {
    const loaded = await deps.lms.listLoaded();
    const match = loaded.find((m) => spec.identifierMatch.test(m.identifier));
    if (match) {
      logger.info('model already loaded', { model: match.identifier });
      return match.identifier;
    }
  }

  // 2. Capacity check BEFORE touching the server. For unknown overrides the `lms` CLI binary
  //    can estimate memory without the API server running.
  let requiredTotalGB = spec.requiredTotalGB;
  let skipCapacityGate = false;
  if (!known) {
    try {
      const est = await deps.lms.estimateTotalGB(spec.loadKey, numCtx);
      requiredTotalGB = Math.ceil(est + ESTIMATE_MARGIN_GB);
    } catch (err) {
      logger.warn('estimate-only failed; skipping capacity gate for override', { err: String(err) });
      skipCapacityGate = true;
    }
  }
  const systemGiB = round1(toGiB(deps.totalmem()));
  const gpuGiB = round1(await (deps.gpuVramGB?.() ?? Promise.resolve(0)));
  const totalCapacityGiB = round1(systemGiB + gpuGiB);
  if (!skipCapacityGate && totalCapacityGiB < requiredTotalGB) {
    const capacityDesc = gpuGiB > 0
      ? `${systemGiB} GB RAM + ${gpuGiB} GB VRAM = ${totalCapacityGiB} GB`
      : `${systemGiB} GB`;
    throw new InsufficientResourcesError(
      `Cannot load ${modelName}: needs ~${requiredTotalGB} GB total memory, machine has ${capacityDesc}`,
    );
  }

  // 3. Capacity OK — start server if needed.
  if (!status.running) {
    logger.info('LM Studio server not running — starting');
    await deps.lms.startServer();
  }

  // 4. Unload any resident model to free memory before loading the target.
  logger.info('unloading current model(s) before load');
  await deps.lms.unloadAll();

  // 5. Free-memory floor (sampled post-unload).
  const freeGiB = round1(toGiB(deps.freemem()));
  if (freeGiB < FREE_FLOOR_GB) {
    throw new InsufficientResourcesError(
      `Cannot load ${modelName}: only ${freeGiB} GB free after unload — close other apps`,
    );
  }

  // 6. Load (auto-fit, no --gpu, parallel 1).
  logger.info('loading model', { model: spec.loadKey, ctx: numCtx });
  await deps.lms.load(spec.loadKey, { contextLength: numCtx, parallel: 1 });

  // 7. Read back the live identifier.
  const afterLoad = await deps.lms.listLoaded();
  const afterMatch = afterLoad.find((m) => spec.identifierMatch.test(m.identifier));
  if (!afterMatch) {
    throw new Error(`load reported success but ${modelName} is not visible in lms ps`);
  }
  logger.info('model ready', { model: afterMatch.identifier });
  return afterMatch.identifier;
}

/**
 * Lightweight per-phase revalidation (F3). Returns the live identifier if the model is still
 * loaded. On no match:
 *  - readOnly:true  (used under --skip-preflight) -> throw; never unload/reload.
 *  - readOnly:false (normal path) -> recover via a full ensureModelReady.
 * `numCtx` is needed for the readOnly:false recovery path's load.
 */
export async function resolveLoadedIdentifier(
  modelName: string,
  numCtx: number,
  logger: Logger,
  opts: { readOnly: boolean },
  deps: PreflightDeps = defaultDeps,
): Promise<string> {
  const { spec } = resolveModelIdentifier(modelName);
  const status = await deps.lms.serverStatus();
  if (status.running) {
    const loaded = await deps.lms.listLoaded();
    const match = loaded.find((m) => spec.identifierMatch.test(m.identifier));
    if (match) return match.identifier;
  }
  if (opts.readOnly) {
    throw new Error(`model ${modelName} is no longer loaded (server down or model evicted)`);
  }
  logger.warn('model not loaded on revalidation — recovering', { model: modelName });
  return ensureModelReady(modelName, numCtx, logger, deps);
}
