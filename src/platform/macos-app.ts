import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** What AppleScript and pgrep need to address one installed Photoshop. */
export interface MacAppTarget {
  /** Bundle display name, e.g. "Adobe Photoshop 2026". Fallback target and log label. */
  appName: string;
  /** Full .app bundle path when known. Preferred: it names exactly one install. */
  appPath?: string;
}

export type CommandRunner = (file: string, args: string[]) => Promise<{ stdout: string }>;

const RUNNING_CHECK_TIMEOUT_MS = 10_000;

const defaultRunner: CommandRunner = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, { timeout: RUNNING_CHECK_TIMEOUT_MS });
  return { stdout: String(stdout) };
};

/** Escape a string for use as a pgrep -f pattern (extended regex). */
export function escapeForPgrep(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Quote a value as an AppleScript string literal. */
export function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The .app bundle that contains `path`, or undefined when `path` is not inside
 * one. PHOTOSHOP_PATH may name the bundle, the bundle with a trailing slash, or
 * the executable under Contents/MacOS.
 */
export function bundlePathOf(path: string): string | undefined {
  const match = /^(.*?\.app)(?:\/.*)?$/.exec(path.trim());
  return match ? match[1] : undefined;
}

/**
 * `application "<bundle path>"`, or by name when no path is known. A path names
 * exactly the detected install (2025, 2026 and Beta share com.adobe.Photoshop)
 * and does not depend on Launch Services resolving the display name (#72).
 */
export function appleScriptAppRef(target: MacAppTarget): string {
  return `application ${appleScriptString(target.appPath ?? target.appName)}`;
}

/**
 * pgrep -f pattern for the app's own executable. Anchored at the start of the
 * command line: AdobeIPCBroker carries the Photoshop executable path in its
 * arguments, so an unanchored match reports a closed Photoshop as running.
 */
export function executablePgrepPattern(appPath: string): string {
  return `^${escapeForPgrep(appPath)}/Contents/MacOS/`;
}

/**
 * Whether this exact install is running. AppleScript answers `running` itself
 * (it never launches the app) and still works where pgrep and ps are denied,
 * e.g. inside an agent sandbox. pgrep is the fallback when osascript fails.
 */
export async function isMacAppRunning(
  target: MacAppTarget,
  run: CommandRunner = defaultRunner
): Promise<boolean> {
  try {
    const { stdout } = await run('osascript', ['-e', `${appleScriptAppRef(target)} is running`]);
    return stdout.trim() === 'true';
  } catch {
    // osascript unavailable or the name did not resolve; try pgrep.
  }

  const pattern = target.appPath
    ? executablePgrepPattern(target.appPath)
    : escapeForPgrep(target.appName);
  try {
    const { stdout } = await run('pgrep', ['-f', pattern]);
    return stdout.trim().length > 0;
  } catch {
    // pgrep exits 1 when nothing matches, 3 when it cannot read the process list.
    return false;
  }
}
