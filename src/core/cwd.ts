/** Working directory filters shared by the summary scan and native projections. */

const TRAILING_SEPARATORS = /[\\/]+$/;
/** POSIX, drive or UNC. A relative path would depend on where the reader runs. */
const ABSOLUTE_PATH = /^(?:\/|\\|[A-Za-z]:[\\/])/;

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
 * The filter without trailing separators, so `/work/` matches like `/work`.
 *
 * @param cwd - Absolute directory filter.
 * @returns {string} The prefix to match, empty for the root.
 */
export function directoryPrefix(cwd: string): string {
  return cwd.replace(TRAILING_SEPARATORS, "");
}

/**
 * The directory or one below it. `/work/project-two` is a sibling, not a child.
 *
 * @param cwd - The session's working directory.
 * @param prefix - Result of {@link directoryPrefix}.
 * @returns {boolean} Whether the session belongs under the prefix.
 */
export function inDirectory(cwd: string, prefix: string): boolean {
  return cwd === prefix || cwd.startsWith(`${prefix}/`) || cwd.startsWith(`${prefix}\\`);
}
