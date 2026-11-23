/** The sessions tools, declared once for every host. Executors load on the first call. */

import { defineTool, Type, type ToolDefinition } from "@agntn/tools";
import {
  DEFAULT_MESSAGE_LIMIT,
  DEFAULT_OUTPUT_CHARS,
  DEFAULT_SESSION_LIMIT,
  MAX_KNOWN_TOOL_RESULTS,
  MAX_MESSAGE_LIMIT,
  MAX_OUTPUT_CHARS,
  MAX_SESSION_LIMIT,
  MAX_SOURCES,
  MIN_OUTPUT_CHARS,
} from "./limits.ts";

type ToolOperations = typeof import("./tool-operations.ts");

let operations: Promise<ToolOperations> | undefined;

/**
 * Loads the executors once. A failed load isn't cached, so a broken `dist` doesn't stick.
 *
 * @returns {Promise<ToolOperations>} The executors module.
 */
export function loadOperations(): Promise<ToolOperations> {
  operations ??= import("./tool-operations.ts").catch((error: unknown) => {
    operations = undefined;
    throw error;
  });
  return operations;
}

const path = Type.Optional(
  Type.String({
    description:
      "Native data path for the single source: the sessions directory for claude, codex, gemini, grok, omp, openclaw, pi and vibe, the database file for mastra, openbot and opencode",
    minLength: 1,
  }),
);

const paths = Type.Optional(
  Type.Array(Type.String({ minLength: 1 }), {
    description: "Override multiple native data paths for sources that support them",
  }),
);

function timeBound(description: string) {
  return Type.Optional(Type.String({ description, minLength: 1 }));
}

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

export const sourcesTool = defineTool({
  name: "sessions_sources",
  title: "Session Sources",
  description:
    "List every supported AI coding harness and whether its native session data is readable on this machine. Use this to inspect availability; sessions_list can discover all available harnesses itself.",
  snippet: "List supported session sources and whether their native data is available locally.",
  guidelines: [
    "Use to inspect availability. sessions_list can discover available sources itself.",
    "This tool reads local source availability only and does not persist or index sessions.",
  ],
  effect: "read",
  input: Type.Object({}),
  execute: async () => (await loadOperations()).listSessionSources(),
});

export const listTool = defineTool({
  name: "sessions_list",
  title: "List Sessions",
  description:
    "Discover sessions across selected or all available harnesses, newest first. Filter last activity with lastHours or since/until. Rows across harnesses include source names. Each row carries the session id, message count, last activity, and a snippet of the session's first text, preferring what the user typed. Triage on the snippet before paying for sessions_read. Page older sessions with offset.",
  snippet:
    "List recent coding sessions across harnesses in one call, optionally within a time window.",
  guidelines: [
    "Omit source and sources to discover all available harnesses, or choose sources explicitly.",
    "Use path or paths only with a single source. Use lastHours: 24 for the past day.",
    "Sessions come newest first; page with offset and reuse returned since/until instead of lastHours.",
    "Triage on the snippet column before reading full message bodies.",
    "Use sessions_read with an exact returned session id to inspect messages.",
  ],
  effect: "read",
  input: Type.Object(
    {
      source: Type.Optional(
        Type.String({
          description: "One harness. Omit source and sources for all available harnesses.",
          minLength: 1,
        }),
      ),
      path,
      paths,
      sources: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description: "Selected harness names. Cannot be combined with source or path overrides.",
          minItems: 1,
          maxItems: MAX_SOURCES,
        }),
      ),
      since: timeBound("Inclusive last activity lower bound, ISO timestamp with timezone."),
      until: timeBound("Inclusive last activity upper bound, ISO timestamp with timezone."),
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
    },
    { additionalProperties: false },
  ),
  execute: async (params) => (await loadOperations()).listSessions(params),
});

export const readTool = defineTool({
  name: "sessions_read",
  title: "Read Session",
  description:
    "Read a bounded message window from one normalized session addressed by the exact id returned by sessions_list. Sources without a native exact session filter still scan their archive for each call.",
  snippet: "Read normalized messages from an exact coding session id.",
  guidelines: [
    "Get the exact session id from sessions_list.",
    "Set maxChars for the host's output budget and reuse the exact returned position to continue.",
    "Sources without a native exact session filter still scan their archive for each call.",
  ],
  effect: "read",
  input: Type.Object(
    {
      source: Type.String({
        description: "Harness source name, for example codex or claude",
        minLength: 1,
        maxLength: 64,
      }),
      path,
      paths,
      sessionId: Type.String({
        description: "Exact native session identifier from sessions_list",
        minLength: 1,
      }),
      offset: Type.Optional(
        Type.Integer({ description: "Zero-based message offset. Defaults to 0.", minimum: 0 }),
      ),
      position: Type.Optional(readPosition),
      knownToolResults: Type.Optional(
        Type.Array(Type.String({ pattern: "^[a-f0-9]{64}$" }), {
          maxItems: MAX_KNOWN_TOOL_RESULTS,
          description:
            "Digests of fully read tool bodies to replace with references. Pass [] to label bodies without omissions; omit for the original transcript. Keep the same list for continuations.",
        }),
      ),
      since: timeBound(
        "Inclusive message timestamp lower bound, ISO timestamp with timezone. Reuse when continuing.",
      ),
      until: timeBound(
        "Inclusive message timestamp upper bound, ISO timestamp with timezone. Reuse when continuing.",
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
    },
    { additionalProperties: false },
  ),
  cli: { positional: ["source", "sessionId"], plain: ["sessionId"] },
  execute: async (params) => (await loadOperations()).readSession(params),
});

/** Every sessions tool in the order hosts list them, each keeping its literal name. */
export const sessionsTools = [
  sourcesTool,
  listTool,
  readTool,
] as const satisfies readonly ToolDefinition[];
