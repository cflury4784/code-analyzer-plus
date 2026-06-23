import { spawnSync } from 'child_process';

/**
 * Platform-specific GPU VRAM fallback probe.
 * The Win32 implementation uses DXGI via PowerShell EncodedCommand.
 * The Posix implementation returns 0 — nvidia-smi is tried in the shared
 * fast path in queryGpuVramGB before this adapter is called.
 *
 * Note: spawnSync inside an async adapter method is intentional — this is
 * a bounded, timeout-guarded one-shot OS probe, not an event-loop-blocking
 * pattern. E1 applies to async call chains with file/network I/O, not to
 * OS stat calls with explicit timeouts.
 */
export interface PlatformAdapter {
  queryGpuVramGbFallback(): Promise<number>;
}

/** Windows: DXGI P/Invoke via PowerShell EncodedCommand. */
export class Win32PlatformAdapter implements PlatformAdapter {
  async queryGpuVramGbFallback(): Promise<number> {
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
}

/** POSIX (Linux/macOS): no DXGI available; returns 0. nvidia-smi is tried in the shared fast path. */
export class PosixPlatformAdapter implements PlatformAdapter {
  async queryGpuVramGbFallback(): Promise<number> {
    return 0;
  }
}

/** Returns the correct adapter for the current platform. Inject in tests to avoid OS calls. */
export function createPlatformAdapter(): PlatformAdapter {
  return process.platform === 'win32'
    ? new Win32PlatformAdapter()
    : new PosixPlatformAdapter();
}
