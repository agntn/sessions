import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import type * as SessionsTools from "../../../src/tool-operations.ts";

const DEFAULT_SESSION_LIMIT = 20;
const MAX_SESSION_LIMIT = 100;
const DEFAULT_MESSAGE_LIMIT = 100;
const MAX_MESSAGE_LIMIT = 500;

const distributionModuleUrl = new URL("../../../dist/tool-operations.mjs", import.meta.url);
const sourceModulePath = fileURLToPath(new URL("../../../src/tool-operations.ts", import.meta.url));
let toolOperationsPromise: Promise<typeof SessionsTools> | undefined;

/**
 * Loads the tool executors from repository source when that file exists and from
 * the built bundle otherwise. The executors are shared with the MCP server, so
 * every surface answers identically. Source comes first because a checkout can
 * still hold a stale `dist/`, and the existence check keeps a transitive load
 * failure from being mistaken for a missing entry module.
 */
function loadToolOperations(): Promise<typeof SessionsTools> {
  toolOperationsPromise ??= (
    existsSync(sourceModulePath)
      ? import("../../../src/tool-operations.ts")
      : import(distributionModuleUrl.href)
  ) as Promise<typeof SessionsTools>;
  return toolOperationsPromise;
}

const sourceOptions = {
  source: Type.String({ description: "Harness source name, for example codex or claude." }),
  path: Type.Optional(Type.String({ description: "Override the source's native data path." })),
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description: "Override multiple native data paths for sources that support them.",
    }),
  ),
};

const sourcesParameters = Type.Object({});
const listParameters = Type.Object({
  ...sourceOptions,
  offset: Type.Optional(
    Type.Integer({ description: "Zero-based session offset. Defaults to 0.", minimum: 0 }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: `Maximum session summaries to return. Defaults to ${DEFAULT_SESSION_LIMIT}.`,
      minimum: 1,
      maximum: MAX_SESSION_LIMIT,
    }),
  ),
});
const readParameters = Type.Object({
  ...sourceOptions,
  sessionId: Type.String({ description: "Exact native session identifier." }),
  offset: Type.Optional(
    Type.Integer({ description: "Zero-based message offset. Defaults to 0.", minimum: 0 }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: `Maximum messages to return. Defaults to ${DEFAULT_MESSAGE_LIMIT}.`,
      minimum: 1,
      maximum: MAX_MESSAGE_LIMIT,
    }),
  ),
});

type ListParams = Static<typeof listParameters>;
type ReadParams = Static<typeof readParameters>;

export default function sessionsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "sessions_sources",
    label: "Session Sources",
    description: "List supported native AI coding harness session sources and local availability.",
    promptSnippet:
      "List supported session sources and whether their native data is available locally.",
    promptGuidelines: [
      "Use before sessions_list when the source name or local availability is unknown.",
      "This tool reads local source availability only and does not persist or index sessions.",
    ],
    parameters: sourcesParameters,
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("sessions_sources")), 0, 0);
    },
    async execute(): Promise<AgentToolResult<SessionsTools.SourcesDetails>> {
      const { listSessionSources } = await loadToolOperations();
      return listSessionSources();
    },
  });

  pi.registerTool({
    name: "sessions_list",
    label: "List Sessions",
    description:
      "Discover normalized native AI coding sessions for one harness. Each row carries bounded metadata and a snippet of the session's first text, preferring what the user typed. Newest first.",
    promptSnippet: "List recent normalized coding sessions from a native harness source.",
    promptGuidelines: [
      "Choose one supported source; use sessions_sources if uncertain.",
      "Use path or paths only to override the harness's native default location.",
      "Sessions come newest first; page older ones with offset.",
      "Triage on the snippet column; sessions_read costs a full archive read.",
      "Use sessions_read with an exact returned session id to inspect messages.",
    ],
    parameters: listParameters,
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", `sessions_list ${args.source}`), 0, 0);
    },
    async execute(
      _toolCallId,
      params: ListParams,
    ): Promise<AgentToolResult<SessionsTools.ListDetails>> {
      const { listSessions } = await loadToolOperations();
      return listSessions(params);
    },
  });

  pi.registerTool({
    name: "sessions_read",
    label: "Read Session",
    description:
      "Read a bounded message window from one normalized native AI coding harness session by exact id.",
    promptSnippet: "Read normalized messages from an exact coding session id.",
    promptGuidelines: [
      "Get the exact session id from sessions_list.",
      "Use offset and limit to page long sessions without unbounded tool output.",
      "Every call re-reads the harness archive, so read one wide window instead of many small ones.",
    ],
    parameters: readParameters,
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", `sessions_read ${args.source}:${args.sessionId}`),
        0,
        0,
      );
    },
    async execute(
      _toolCallId,
      params: ReadParams,
    ): Promise<AgentToolResult<SessionsTools.ReadDetails>> {
      const { readSession } = await loadToolOperations();
      return readSession(params);
    },
  });
}
