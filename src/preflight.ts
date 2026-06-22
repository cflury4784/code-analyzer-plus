import { spawnSync } from 'child_process';
import { totalmem as osTotalmem, freemem as osFreemem } from 'os';
import { MODEL_REGISTRY, type ModelSpec, FREE_FLOOR_GB, ESTIMATE_MARGIN_GB } from './models.js';
import { lmsRest as defaultLms } from './lms-rest.js';
import type { Lms } from './lms.js';
import type { Logger } from './logger.js';

export class InsufficientResourcesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientResourcesError';
  }
}

/**
 * Query total GPU VRAM in GiB. Tries nvidia-smi first (fast, NVIDIA-only), then falls back to
 * DXGI via PowerShell (cross-vendor, Windows). Returns 0 if both fail.
 * WMI AdapterRAM is intentionally avoided — it's a uint32 field and silently wraps for >4 GB VRAM.
 */
async function queryGpuVramGB(): Promise<number> {
  // Fast path: NVIDIA
  const nv = spawnSync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', [], {
    encoding: 'utf8', shell: true, timeout: 5000,
  });
  if (nv.status === 0 && nv.stdout?.trim()) {
    const mib = nv.stdout.trim().split('\n')
      .map((l) => parseInt(l.trim(), 10)).filter((n) => !isNaN(n))
      .reduce((a, b) => a + b, 0);
    if (mib > 0) return mib / 1024;
  }

  // Cross-vendor fallback: DXGI via PowerShell (64-bit DedicatedVideoMemory, works on AMD/Intel)
  // Uses EncodedCommand to avoid heredoc quoting issues in spawnSync.
  // C# targeting ≤ v6 (Add-Type default): no inline out declarations, no where T:Delegate.
  const cs = [
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class DxgiMem {',
    '    [DllImport("dxgi.dll")] public static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr f);',
    '    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
    '    public struct Desc1 {',
    '        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Description;',
    '        public uint VendorId,DeviceId,SubSysId,Revision;',
    '        public ulong DedicatedVideoMemory,DedicatedSystemMemory,SharedSystemMemory;',
    '        public long Luid; public uint Flags;',
    '    }',
    '    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate uint RelFn(IntPtr t);',
    '    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int Enum1Fn(IntPtr t,uint i,out IntPtr a);',
    '    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int GetDesc1Fn(IntPtr t,out Desc1 d);',
    '    static IntPtr VtblSlot(IntPtr o,int s){return Marshal.ReadIntPtr(Marshal.ReadIntPtr(o),s*IntPtr.Size);}',
    '    public static long TotalDedicatedVideoBytes() {',
    '        var iid=new Guid("770aae78-f26f-4dba-a829-253c83d1b387");',
    '        IntPtr pF;',
    '        if(CreateDXGIFactory1(ref iid,out pF)<0) return 0;',
    '        try {',
    '            long tot=0;',
    '            var en=(Enum1Fn)Marshal.GetDelegateForFunctionPointer(VtblSlot(pF,12),typeof(Enum1Fn));',
    '            for(uint i=0;;i++){',
    '                IntPtr pA;',
    '                if(en(pF,i,out pA)!=0)break;',
    '                try{',
    '                    var gd=(GetDesc1Fn)Marshal.GetDelegateForFunctionPointer(VtblSlot(pA,11),typeof(GetDesc1Fn));',
    '                    Desc1 d;',
    '                    if(gd(pA,out d)==0)tot+=(long)d.DedicatedVideoMemory;',
    '                }finally{',
    '                    ((RelFn)Marshal.GetDelegateForFunctionPointer(VtblSlot(pA,2),typeof(RelFn)))(pA);',
    '                }',
    '            }',
    '            return tot;',
    '        } finally{',
    '            ((RelFn)Marshal.GetDelegateForFunctionPointer(VtblSlot(pF,2),typeof(RelFn)))(pF);',
    '        }',
    '    }',
    '}',
  ].join('\r\n');

  // PowerShell heredoc requires CRLF; closing '@  must be at column 0 — preserved by join above.
  const ps1 = `Add-Type -TypeDefinition @'\r\n${cs}\r\n'@\r\n[DxgiMem]::TotalDedicatedVideoBytes()`;
  const encoded = Buffer.from(ps1, 'utf16le').toString('base64');
  const pw = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', timeout: 15000,
  });
  if (pw.status === 0 && pw.stdout?.trim()) {
    const bytes = parseInt(pw.stdout.trim(), 10);
    if (!isNaN(bytes) && bytes > 0) return bytes / 1024 ** 3;
  }

  return 0;
}

export interface PreflightDeps {
  lms: Lms;
  totalmem: () => number;
  freemem: () => number;
  gpuVramGB?: () => Promise<number>;
}

const defaultDeps: PreflightDeps = {
  lms: defaultLms,
  totalmem: osTotalmem,
  freemem: osFreemem,
  gpuVramGB: queryGpuVramGB,
};

const toGiB = (bytes: number): number => bytes / 1024 ** 3;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Registry lookup, or an ad-hoc spec for an unknown --model-override (F4). */
function resolveSpec(modelName: string): { spec: ModelSpec; known: boolean } {
  const known = MODEL_REGISTRY[modelName];
  if (known) return { spec: known, known: true };
  return {
    spec: {
      loadKey: modelName,
      identifierMatch: new RegExp(escapeRegex(modelName), 'i'),
      requiredTotalGB: 0, // computed at the resource-check step for unknown overrides
    },
    known: false,
  };
}

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
  const { spec, known } = resolveSpec(modelName);

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
  const { spec } = resolveSpec(modelName);
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
