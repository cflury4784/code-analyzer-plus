import { spawnSync } from 'child_process';
import type { ChildProcess } from 'child_process';

const active = new Set<ChildProcess>();

export function register(proc: ChildProcess): void {
  active.add(proc);
  proc.once('close', () => active.delete(proc));
}

export function killAll(): void {
  for (const proc of active) {
    try {
      if (process.platform === 'win32' && proc.pid !== undefined) {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
      } else {
        proc.kill('SIGTERM');
      }
    } catch {
      // best-effort
    }
  }
  active.clear();
}
