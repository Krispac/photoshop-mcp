import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger, LogLevel } from '../src/utils/logger.js';

let savedLevel: string | undefined;

beforeEach(() => {
  savedLevel = process.env.LOG_LEVEL;
  delete process.env.LOG_LEVEL;
});

afterEach(() => {
  if (savedLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = savedLevel;
  vi.restoreAllMocks();
});

function logged(...args: unknown[]): string {
  const writes: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  new Logger('Test', LogLevel.DEBUG).error('Script execution failed:', ...args);
  return writes.join('');
}

describe('Logger argument formatting', () => {
  it('prints an Error message instead of {}', () => {
    const line = logged(new Error('execution error: Application isn’t running. (-600)'));
    expect(line).toContain('(-600)');
    expect(line).not.toContain('{}');
  });

  it('still prints plain objects as JSON', () => {
    expect(logged({ code: 'x' })).toContain('{"code":"x"}');
  });

  it('does not throw on circular objects or BigInt', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logged(circular, { n: 1n })).not.toThrow();
  });
});
