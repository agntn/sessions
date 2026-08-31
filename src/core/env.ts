import { homedir, userInfo } from "node:os";

/**
 * Returns a safe home directory and never throws.
 *
 * @returns {string} The configured home directory or a temporary fallback.
 */
export function home(): string {
  if (process.env.HOME) return process.env.HOME;
  try {
    return homedir();
  } catch {
    return "/tmp";
  }
}

/**
 * Returns the current OS username.
 *
 * @returns {string} The username or `unknown` when the OS lookup fails.
 */
export function osUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}
