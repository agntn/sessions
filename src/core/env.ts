import { homedir } from 'node:os'

/** Safe home directory accessor. Never throws. */
export function home(): string {
  return process.env.HOME || homedir()
}
