/** Every command but a bare `mcp` in a checkout: `runCli` over the bundled tool list. */

import { runCli } from "@agntn/tools/cli";
import { SessionsError } from "./core/errors.ts";
import { serverInfo } from "./server-info.ts";
import { sessionsTools } from "./tools.ts";

/**
 * The refusals the executors throw on purpose: a bad argument, a missing source or session.
 *
 * @param error - What a command threw.
 * @returns {boolean} Whether it prints as one line instead of a stack trace.
 */
function isRefusal(error: unknown): boolean {
  return (
    error instanceof RangeError ||
    error instanceof SessionsError ||
    (error instanceof Error && error.constructor === Error)
  );
}

/**
 * Runs one command line.
 *
 * @param argv - Arguments after the binary.
 */
export async function runSessionsCli(argv: readonly string[]): Promise<void> {
  await runCli({ ...serverInfo, tools: sessionsTools, mcp: true, expected: isRefusal }, argv);
}
