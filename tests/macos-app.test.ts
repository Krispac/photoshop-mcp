import { describe, expect, it } from 'vitest';
import {
  appleScriptAppRef,
  appleScriptString,
  bundlePathOf,
  executablePgrepPattern,
  isMacAppRunning,
  type CommandRunner,
} from '../src/platform/macos-app.js';

const PS_PATH = '/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app';
const PS_EXEC = `${PS_PATH}/Contents/MacOS/Adobe Photoshop 2026`;
const IPC_BROKER = `/Library/Application Support/Adobe/Adobe Desktop Common/IPCBox/AdobeIPCBroker.app/Contents/MacOS/AdobeIPCBroker -launchedbyvulcan ${PS_EXEC}`;
const PS_2025_EXEC =
  '/Applications/Adobe Photoshop 2025/Adobe Photoshop 2025.app/Contents/MacOS/Adobe Photoshop 2025';

/** osascript answers `osascript` (or throws); pgrep -f matches its pattern against `processes`. */
function fakeRunner(opts: { osascript?: string; processes: string[] }) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const run: CommandRunner = async (file, args) => {
    calls.push({ file, args });
    if (file === 'osascript') {
      if (opts.osascript === undefined) throw new Error('osascript unavailable');
      return { stdout: opts.osascript };
    }
    const re = new RegExp(args[1]);
    const hits = opts.processes.filter((line) => re.test(line));
    if (hits.length === 0) throw Object.assign(new Error('pgrep: no match'), { code: 1 });
    return { stdout: hits.map((_, i) => String(100 + i)).join('\n') + '\n' };
  };
  return { run, calls };
}

describe('appleScriptString', () => {
  it('quotes and escapes backslashes and double quotes', () => {
    expect(appleScriptString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});

describe('bundlePathOf', () => {
  it('keeps a bundle path', () => {
    expect(bundlePathOf(PS_PATH)).toBe(PS_PATH);
  });

  it('drops a trailing slash', () => {
    expect(bundlePathOf(`${PS_PATH}/`)).toBe(PS_PATH);
  });

  it('maps the executable inside the bundle back to the bundle', () => {
    expect(bundlePathOf(PS_EXEC)).toBe(PS_PATH);
  });

  it('does not stop at a folder that merely starts with .app', () => {
    expect(bundlePathOf('/Volumes/x.application/Adobe Photoshop 2026.app')).toBe(
      '/Volumes/x.application/Adobe Photoshop 2026.app'
    );
  });

  it('returns undefined outside a bundle', () => {
    expect(bundlePathOf('/Applications/Adobe Photoshop 2026')).toBeUndefined();
  });
});

describe('appleScriptAppRef', () => {
  it('prefers the bundle path (#72)', () => {
    expect(appleScriptAppRef({ appName: 'Adobe Photoshop 2026', appPath: PS_PATH })).toBe(
      `application "${PS_PATH}"`
    );
  });

  it('falls back to the name', () => {
    expect(appleScriptAppRef({ appName: 'Adobe Photoshop 2026' })).toBe(
      'application "Adobe Photoshop 2026"'
    );
  });
});

describe('executablePgrepPattern', () => {
  it('escapes Beta parentheses and matches only the executable', () => {
    const beta = '/Applications/Adobe Photoshop (Beta)/Adobe Photoshop (Beta).app';
    const re = new RegExp(executablePgrepPattern(beta));
    expect(re.test(`${beta}/Contents/MacOS/Adobe Photoshop (Beta)`)).toBe(true);
    expect(re.test(`/x/Helper -arg ${beta}/Contents/MacOS/Adobe Photoshop (Beta)`)).toBe(false);
  });
});

describe('isMacAppRunning', () => {
  const target = { appName: 'Adobe Photoshop 2026', appPath: PS_PATH };

  it('asks AppleScript about the exact bundle path', async () => {
    const { run, calls } = fakeRunner({ osascript: 'true\n', processes: [] });
    expect(await isMacAppRunning(target, run)).toBe(true);
    expect(calls[0]).toEqual({
      file: 'osascript',
      args: ['-e', `application "${PS_PATH}" is running`],
    });
  });

  it('trusts AppleScript "false" even when AdobeIPCBroker carries the Photoshop path (#72)', async () => {
    const { run, calls } = fakeRunner({ osascript: 'false\n', processes: [IPC_BROKER] });
    expect(await isMacAppRunning(target, run)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('falls back to an anchored pgrep that ignores AdobeIPCBroker', async () => {
    const { run } = fakeRunner({ processes: [IPC_BROKER] });
    expect(await isMacAppRunning(target, run)).toBe(false);
  });

  it('falls back to pgrep and finds the real executable', async () => {
    const { run } = fakeRunner({ processes: [IPC_BROKER, PS_EXEC] });
    expect(await isMacAppRunning(target, run)).toBe(true);
  });

  it('reports 2026 as not running while only 2025 runs side by side', async () => {
    const { run } = fakeRunner({ processes: [PS_2025_EXEC] });
    expect(await isMacAppRunning(target, run)).toBe(false);
  });

  it('returns false when both checks fail', async () => {
    const { run } = fakeRunner({ processes: [] });
    expect(await isMacAppRunning(target, run)).toBe(false);
  });
});
