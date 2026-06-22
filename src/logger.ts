import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export type LogLevel = 'INFO' | 'ERROR' | 'WARN' | 'DEBUG';

const COLORS: Record<LogLevel, string> = {
  INFO:  '\x1b[36m',  // cyan
  WARN:  '\x1b[33m',  // yellow
  ERROR: '\x1b[31m',  // red
  DEBUG: '\x1b[2m',   // dim white
};
const RESET = '\x1b[0m';

export function createLogger(logPath: string) {
  mkdirSync(dirname(logPath), { recursive: true });

  function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
    const now = new Date();
    const isoTs = now.toISOString();
    const shortTs = isoTs.slice(11, 19); // HH:MM:SS
    const metaStr = meta
      ? ' | ' + Object.entries(meta).map(([k, v]) => `${k}=${v}`).join(' ')
      : '';

    appendFileSync(logPath, `[${isoTs}] [${level}]  ${message}${metaStr}\n`, 'utf8');

    // For DEBUG level, only write to stdout if DEBUG=1
    if (level === 'DEBUG' && process.env['DEBUG'] !== '1') {
      return;
    }

    const color = COLORS[level];
    process.stdout.write(`${color}[${shortTs}] ${level.padEnd(5)}${RESET}  ${message}${metaStr}\n`);
  }

  return {
    info: (msg: string, meta?: Record<string, unknown>) => log('INFO', msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) => log('ERROR', msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => log('WARN', msg, meta),
    debug: (msg: string, meta?: Record<string, unknown>) => log('DEBUG', msg, meta),
  };
}

export type Logger = ReturnType<typeof createLogger>;
