import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../../src/logger.js';
import { setupTempFs, restoreEnvVars, type TempFsResult } from '../utils/TestEnvironmentManager.js';

let fs: TempFsResult;
let logPath: string;

beforeEach(() => {
  fs = setupTempFs('logger-test');
  logPath = join(fs.root, 'run.log');
});

afterEach(() => {
  fs.cleanup();
});

describe('createLogger', () => {
  it('appends INFO lines to log file', () => {
    const logger = createLogger(logPath);
    logger.info('Phase 1 started', { model: 'qwen' });
    const content = readFileSync(logPath, 'utf8');
    expect(content).toMatch(/\[INFO\].*Phase 1 started.*model=qwen/);
  });

  it('appends ERROR lines', () => {
    const logger = createLogger(logPath);
    logger.error('batch failed', { error: 'timeout' });
    const content = readFileSync(logPath, 'utf8');
    expect(content).toMatch(/\[ERROR\].*batch failed.*error=timeout/);
  });

  it('creates parent directory if missing', () => {
    const nested = join(fs.root, 'logs', 'nested', 'run.log');
    const logger = createLogger(nested);
    logger.info('test');
    const content = readFileSync(nested, 'utf8');
    expect(content).toContain('[INFO]');
  });

  it('includes ISO timestamp', () => {
    const logger = createLogger(logPath);
    logger.info('event');
    const content = readFileSync(logPath, 'utf8');
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('appends multiple lines without overwriting', () => {
    const logger = createLogger(logPath);
    logger.info('first');
    logger.info('second');
    const content = readFileSync(logPath, 'utf8');
    expect(content).toContain('first');
    expect(content).toContain('second');
  });
});

describe('DEBUG level', () => {
  it('debug() writes to log file', () => {
    const logger = createLogger(logPath);
    logger.debug('Debug message', { key: 'value' });
    const content = readFileSync(logPath, 'utf8');
    expect(content).toMatch(/\[DEBUG\].*Debug message.*key=value/);
  });

  it('debug() suppressed from stdout when DEBUG env unset', () => {
    const saved = { DEBUG: process.env['DEBUG'] };
    delete process.env['DEBUG'];

    const stdoutSpy = vi.spyOn(process.stdout, 'write');
    const logger = createLogger(logPath);

    logger.debug('Debug message');

    const debugCalls = stdoutSpy.mock.calls.filter((call) =>
      call[0].includes('DEBUG')
    );
    expect(debugCalls).toHaveLength(0);

    stdoutSpy.mockRestore();
    restoreEnvVars(saved);
  });

  it('debug() writes to stdout when DEBUG=1', () => {
    const saved = { DEBUG: process.env['DEBUG'] };
    process.env['DEBUG'] = '1';

    const logger = createLogger(logPath);
    const stdoutSpy = vi.spyOn(process.stdout, 'write');

    logger.debug('Debug message');

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('DEBUG'));

    stdoutSpy.mockRestore();
    restoreEnvVars(saved);
  });
});
