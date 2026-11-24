/** Working directory filters shared by the summary scan and native projections. */

import { posix, win32 } from "node:path";

/** POSIX, drive or UNC. A relative path would depend on where the reader runs. */
const ABSOLUTE_PATH = /^(?:\/|\\|[A-Za-z]:[\\/])/;
const WINDOWS_PATH = /^(?:\\|[A-Za-z]:)/;

/**
 * Refuses a directory filter that isn't an absolute path.
 *
 * @param cwd - Filter as the caller gave it.
 * @throws {RangeError} When it isn't absolute.
 */
export function assertDirectory(cwd: string): void {
  if (!ABSOLUTE_PATH.test(cwd)) throw new RangeError("cwd must be an absolute path");
}

/**
 * Whether a path is a drive or UNC path, which compares with backslashes.
 *
 * @param cwd - Absolute path.
 * @returns {boolean} Whether it is Windows style.
 */
function isWindowsDirectory(cwd: string): boolean {
  return WINDOWS_PATH.test(cwd);
}

/**
 * One spelling per directory. Windows compares with `\\` and without case, as its filesystems do.
 *
 * @param cwd - Absolute path.
 * @returns {string} The comparison key, never shown.
 */
function normalized(cwd: string): string {
  if (!isWindowsDirectory(cwd)) return posix.normalize(cwd);
  return win32.normalize(cwd).toLowerCase();
}

/**
 * The filter as a prefix to match, empty for the POSIX root.
 *
 * @param cwd - Absolute directory filter.
 * @returns {string} Normalized, without trailing separators.
 */
export function directoryPrefix(cwd: string): string {
  const path = normalized(cwd);
  return path.replace(isWindowsDirectory(path) ? /[\\/]+$/ : /\/+$/, "");
}

/**
 * The directory or one below it. `/work/project-two` is a sibling, not a child.
 *
 * @param cwd - The session's working directory.
 * @param prefix - Result of {@link directoryPrefix}.
 * @returns {boolean} Whether the session belongs under the prefix.
 */
export function inDirectory(cwd: string, prefix: string): boolean {
  const path = normalized(cwd);
  const separator = isWindowsDirectory(path) ? "\\" : "/";
  return path === prefix || path.startsWith(`${prefix}${separator}`);
}
