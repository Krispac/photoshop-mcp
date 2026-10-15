import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const detect = vi.hoisted(() => vi.fn());

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, platform: () => 'darwin' };
});

vi.mock('../src/platform/detector.js', () => ({
  PhotoshopDetector: class {
    detect = detect;
  },
}));

import { API_OVERRIDE_ENV, PhotoshopAPIFactory } from '../src/api/photoshop-api.js';
import { classifyError } from '../src/errors/envelope.js';
import { writePhotoshopDetectCache } from '../src/platform/detect-cache.js';
import { MacOSExecutor } from '../src/platform/macos-executor.js';
import {
  PHOTOSHOP_NOT_DETECTED_MESSAGE,
  PhotoshopConnection,
} from '../src/platform/connection.js';
import { runSnippet } from '../src/tools/atomic-shared.js';

const APP_2026 = '/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app';

function installed(path = APP_2026) {
  return { version: '27.9.1', path, isRunning: true, appName: 'Adobe Photoshop 2026' };
}

describe('PhotoshopAPIFactory detects Photoshop on the first tool call', () => {
  let home: string;
  let previousHome: string | undefined;
  let previousPsPath: string | undefined;

  beforeEach(() => {
    previousHome = process.env.PHOTOSHOP_MCP_HOME;
    previousPsPath = process.env.PHOTOSHOP_PATH;
    delete process.env.PHOTOSHOP_PATH;
    home = mkdtempSync(join(tmpdir(), 'ph-mcp-first-call-'));
    process.env.PHOTOSHOP_MCP_HOME = home;
    // Skip the UXP bridge probe; it only picks log wording.
    process.env[API_OVERRIDE_ENV] = 'extendscript';
    detect.mockReset();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.PHOTOSHOP_MCP_HOME;
    else process.env.PHOTOSHOP_MCP_HOME = previousHome;
    if (previousPsPath === undefined) delete process.env.PHOTOSHOP_PATH;
    else process.env.PHOTOSHOP_PATH = previousPsPath;
    delete process.env[API_OVERRIDE_ENV];
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('detects without an earlier photoshop_ping and without launching Photoshop', async () => {
    detect.mockResolvedValue(installed());
    const running = vi.spyOn(MacOSExecutor.prototype, 'isPhotoshopRunning');
    const launch = vi.spyOn(MacOSExecutor.prototype, 'launchPhotoshop');
    const connection = new PhotoshopConnection();

    const api = await new PhotoshopAPIFactory(connection).createAPI();

    expect(api.getAPIType()).toBe('ExtendScript');
    expect(detect).toHaveBeenCalledTimes(1);
    expect(connection.getPhotoshopInfo()?.path).toBe(APP_2026);
    expect(running).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('runs the first snippet of a fresh session instead of "Photoshop info not available"', async () => {
    detect.mockResolvedValue(installed());
    vi.spyOn(MacOSExecutor.prototype, 'isPhotoshopRunning').mockResolvedValue(true);
    vi.spyOn(MacOSExecutor.prototype, 'execute').mockResolvedValue('ok');

    await expect(runSnippet(new PhotoshopConnection(), 'return 1;')).resolves.toBe('ok');
  });

  it('fails with photoshop_not_detected when no install is found', async () => {
    detect.mockRejectedValue(new Error('Photoshop not found on this system'));
    const factory = new PhotoshopAPIFactory(new PhotoshopConnection());

    const error = await factory.createAPI().catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(PHOTOSHOP_NOT_DETECTED_MESSAGE);
    expect(classifyError((error as Error).message).code).toBe('photoshop_not_detected');
  });

  it('keeps an unexpected detection failure in the message', async () => {
    detect.mockRejectedValue(new Error('Unsupported platform: linux'));
    const error = await new PhotoshopAPIFactory(new PhotoshopConnection())
      .createAPI()
      .catch((e: Error) => e);

    expect((error as Error).message).toContain(PHOTOSHOP_NOT_DETECTED_MESSAGE);
    expect((error as Error).message).toContain('Unsupported platform: linux');
    expect(classifyError((error as Error).message).code).toBe('photoshop_not_detected');
  });

  it('detects again on the next call after a failed detect', async () => {
    detect.mockRejectedValueOnce(new Error('Photoshop not found on this system'));
    detect.mockResolvedValueOnce(installed());
    const factory = new PhotoshopAPIFactory(new PhotoshopConnection());

    await expect(factory.createAPI()).rejects.toThrow(PHOTOSHOP_NOT_DETECTED_MESSAGE);
    await expect(factory.createAPI()).resolves.toBeDefined();
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it('does not fail the detect when the detect cache cannot be written', async () => {
    const notADir = join(home, 'file');
    writeFileSync(notADir, '');
    process.env.PHOTOSHOP_MCP_HOME = join(notADir, 'home');
    detect.mockResolvedValue(installed());
    const connection = new PhotoshopConnection();

    await expect(connection.ensureDetected()).resolves.toMatchObject({ path: APP_2026 });
    expect(connection.getPhotoshopInfo()?.path).toBe(APP_2026);
  });

  it('reuses a valid detect cache instead of detecting', async () => {
    const appPath = join(home, 'Adobe Photoshop 2026.app');
    mkdirSync(appPath);
    writePhotoshopDetectCache({ version: '27.9.1', path: appPath });

    const info = await new PhotoshopConnection().ensureDetected();

    expect(info?.path).toBe(appPath);
    expect(detect).not.toHaveBeenCalled();
  });
});
