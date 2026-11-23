import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerPiTools } from "@agntn/tools/pi";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type * as SessionsTools from "../../src/tools.ts";

const sourceModuleUrl = new URL("../../src/tools.ts", import.meta.url);
const distributionModuleUrl = new URL("../../dist/tools.mjs", import.meta.url);

/**
 * Source in a checkout, since its `dist/` can be stale; the build in the package.
 *
 * @returns {Promise<typeof SessionsTools>} The tool definitions.
 */
function loadTools(): Promise<typeof SessionsTools> {
  return import(
    existsSync(fileURLToPath(sourceModuleUrl)) ? sourceModuleUrl.href : distributionModuleUrl.href
  ) as Promise<typeof SessionsTools>;
}

type Args = Readonly<Record<string, unknown>>;

/**
 * The harnesses a listing asked for, as the call line names them.
 *
 * @param args - Raw arguments from the model.
 * @returns {string} One source, the joined list or `all`.
 */
function harnessLabel(args: Args): string {
  const { source, sources } = args;
  if (typeof source === "string") return source;
  return Array.isArray(sources) ? sources.map(String).join(", ") : "all";
}

/**
 * Register the session tools; the executors load on the first call.
 *
 * @param pi - The Pi extension API.
 */
export default async function sessionsExtension(pi: ExtensionAPI): Promise<void> {
  const { sessionsTools } = await loadTools();
  registerPiTools(pi, sessionsTools, {
    Text,
    renderers: {
      sessions_list: { describeCall: harnessLabel },
      sessions_read: {
        describeCall: (args) => `${harnessLabel(args)}:${String(args["sessionId"])}`,
      },
    },
  });
}
