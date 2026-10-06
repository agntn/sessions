#!/usr/bin/env node

import { existsSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand, runMain } from "citty";
import type McpCommand from "./commands/mcp.ts";
import { version } from "./version.ts";

/**
 * Narrows the module a runtime URL import returned, which TypeScript types as `any`.
 * @param value - The imported module namespace.
 * @returns {boolean} Whether it exports a default command.
 */
function isMcpModule(value: unknown): value is { readonly default: typeof McpCommand } {
  return typeof value === "object" && value !== null && "default" in value;
}

/**
 * Whether `typebox` resolves here; a checkout installed without devDependencies has none.
 * @returns {boolean} Whether `src/mcp.ts` could import it.
 */
function resolvesTypebox(): boolean {
  try {
    import.meta.resolve("typebox");
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads `mcp` from `src/` when a built bin runs in a checkout, so a local server takes edits.
 * The npm package, copies under `node_modules`, a checkout without devDependencies and
 * `SESSIONS_DIST=1` keep the bundle, and a literal import would pull the source into it.
 * @returns {Promise<typeof McpCommand>} The command that starts the stdio server.
 */
async function loadMcpCommand(): Promise<typeof McpCommand> {
  const source = new URL("../src/commands/mcp.ts", import.meta.url);
  const sourcePath = fileURLToPath(source);
  const fromSource =
    !import.meta.url.endsWith(".ts") &&
    process.env.SESSIONS_DIST !== "1" &&
    !sourcePath.includes(`${sep}node_modules${sep}`) &&
    existsSync(sourcePath) &&
    resolvesTypebox();
  if (!fromSource) return (await import("./commands/mcp.ts")).default;
  const module: unknown = await import(source.href);
  if (!isMcpModule(module)) throw new TypeError(`${sourcePath} has no default command`);
  return module.default;
}

const main = defineCommand({
  meta: {
    name: "sessions",
    version,
    description: "Read normalized AI coding sessions across harnesses",
  },
  subCommands: {
    mcp: loadMcpCommand,
  },
});

await runMain(main);
