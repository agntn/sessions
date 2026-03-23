import { homedir, userInfo } from "node:os";

/** Safe home directory accessor. Never throws. */
export function home(): string {
  if (process.env.HOME) return process.env.HOME;
  try {
    return homedir();
  } catch {
    return "/tmp";
  }
}

/** Current OS username. Falls back to 'unknown'. */
export function osUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}
