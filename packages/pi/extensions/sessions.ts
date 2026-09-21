import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type * as SessionsTools from "../../../src/tool-operations.ts";

const DEFAULT_SESSION_LIMIT = 20;
const MAX_SESSION_LIMIT = 100;
const DEFAULT_MESSAGE_LIMIT = 100;
const MAX_MESSAGE_LIMIT = 500;
const DEFAULT_OUTPUT_CHARS = 20_000;
const MIN_OUTPUT_CHARS = 1_000;
const MAX_OUTPUT_CHARS = 100_000;

const distributionModuleUrl = new URL("../../../dist/tool-operations.mjs", import.meta.url);
const sourceModulePath = fileURLToPath(new URL("../../../src/tool-operations.ts", import.meta.url));
let toolOperationsPromise: Promise<typeof SessionsTools> | undefined;

/**
 * Loads the tool executors from repository source when that file exists and from
 * the built bundle otherwise. The executors are shared with the MCP server, so
 * every surface answers identically. Source comes first because a checkout can
 * still hold a stale `dist/`, and the existence check keeps a transitive load
 * failure from being mistaken for a missing entry module.
 *
 * @returns {Promise<typeof SessionsTools>} The shared executor module.
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
  source: Type.Optional(
    Type.String({
      description: "One harness. Omit source and sources for all available harnesses.",
      minLength: 1,
    }),
  ),
  sources: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description: "Selected harness names. Cannot be combined with source or path overrides.",
      minItems: 1,
      maxItems: 10,
    }),
  ),
  since: Type.Optional(
    Type.String({
      description: "Inclusive last activity lower bound, ISO timestamp with timezone.",
    }),
  ),
  until: Type.Optional(
    Type.String({
      description: "Inclusive last activity upper bound, ISO timestamp with timezone.",
    }),
  ),
  lastHours: Type.Optional(
    Type.Number({
      description:
        "Last activity within this many hours before now, for example 24. Cannot be combined with since/until.",
      exclusiveMinimum: 0,
    }),
  ),
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
const readPosition = Type.Object(
  {
    message: Type.Integer({ description: "Zero-based message index.", minimum: 0 }),
    block: Type.Integer({ description: "Zero-based block index within that message.", minimum: 0 }),
    character: Type.Integer({
      description: "Character offset within the rendered block.",
      minimum: 0,
    }),
  },
  {
    additionalProperties: false,
    description: "Exact continuation position returned by the previous call.",
  },
);
const readParameters = Type.Object({
  ...sourceOptions,
  sessionId: Type.String({ description: "Exact native session identifier." }),
  offset: Type.Optional(
    Type.Integer({ description: "Zero-based message offset. Defaults to 0.", minimum: 0 }),
  ),
  position: Type.Optional(readPosition),
  knownToolResults: Type.Optional(
    Type.Array(Type.String({ pattern: "^[a-f0-9]{64}$" }), {
      maxItems: 100,
      description:
        "Digests of fully read tool bodies to replace with references. Pass [] to label bodies without omissions; omit for the original transcript. Keep the same list for continuations.",
    }),
  ),
  since: Type.Optional(
    Type.String({
      description:
        "Inclusive message timestamp lower bound, ISO timestamp with timezone. Reuse when continuing.",
    }),
  ),
  until: Type.Optional(
    Type.String({
      description:
        "Inclusive message timestamp upper bound, ISO timestamp with timezone. Reuse when continuing.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: `Maximum matching messages to retain. Defaults to ${DEFAULT_MESSAGE_LIMIT}.`,
      minimum: 1,
      maximum: MAX_MESSAGE_LIMIT,
    }),
  ),
  maxChars: Type.Optional(
    Type.Integer({
      description: `Maximum response characters, including the continuation notice. Defaults to ${DEFAULT_OUTPUT_CHARS}.`,
      minimum: MIN_OUTPUT_CHARS,
      maximum: MAX_OUTPUT_CHARS,
    }),
  ),
});

interface ListParams {
  readonly source?: string;
  readonly sources?: readonly string[];
  readonly since?: string;
  readonly until?: string;
  readonly lastHours?: number;
  readonly path?: string;
  readonly paths?: readonly string[];
  readonly offset?: number;
  readonly limit?: number;
}

interface ReadParams extends ListParams {
  readonly knownToolResults?: readonly string[];
  readonly source: string;
  readonly sessionId: string;
  readonly maxChars?: number;
  readonly position?: SessionsTools.ReadPosition;
}

export default function sessionsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "sessions_sources",
    label: "Session Sources",
    description: "List supported native AI coding harness session sources and local availability.",
    promptSnippet:
      "List supported session sources and whether their native data is available locally.",
    promptGuidelines: [
      "Use to inspect availability. sessions_list can discover available sources itself.",
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
      "Discover sessions across selected or all available harnesses. Filter last activity with lastHours or since/until. Each row carries bounded metadata and a snippet of the session's first text, preferring what the user typed. Newest first.",
    promptSnippet:
      "List recent coding sessions across harnesses in one call, optionally within a time window.",
    promptGuidelines: [
      "Omit source and sources to discover all available harnesses, or choose sources explicitly.",
      "Use path or paths only with a single source. Use lastHours: 24 for the past day.",
      "Sessions come newest first; page with offset and reuse returned since/until instead of lastHours.",
      "Triage on the snippet column before reading full message bodies.",
      "Use sessions_read with an exact returned session id to inspect messages.",
    ],
    parameters: listParameters,
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", `sessions_list ${args.source ?? args.sources?.join(", ") ?? "all"}`),
        0,
        0,
      );
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
      "Set maxChars for the host's output budget and reuse the exact returned position to continue.",
      "Sources without a native exact session filter still scan their archive for each call.",
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
