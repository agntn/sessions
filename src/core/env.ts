import { homedir, userInfo } from "node:os";

/** Safe home directory accessor. Never throws. */
export function home(): string {
  return process.env.HOME || homedir();
}

/** Current OS username. Falls back to 'unknown'. */
export function osUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}
