import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type * as SessionsTools from "../../../src/tool-operations.ts";

const DEFAULT_SESSION_LIMIT = 20;
const MAX_SESSION_LIMIT = 100;
const DEFAULT_MESSAGE_LIMIT = 100;
const MAX_MESSAGE_LIMIT = 500;
const DEFAULT_OUTPUT_CHARS = 20_000;
const MIN_OUTPUT_CHARS = 1_000;
const MAX_OUTPUT_CHARS = 100_000;

const sourceModulePath = fileURLToPath(new URL("../../../src/tool-operations.ts", import.meta.url));
let toolOperationsPromise: Promise<typeof SessionsTools> | undefined;

/**
 * Loads the executors shared with MCP and Pi from source in a checkout or from
 * the built bundle in a published package. The literal import specifiers keep
 * both branches visible to OMP's loader.
 *
 * @returns {Promise<typeof SessionsTools>} The shared session tool operations.
 */
function loadToolOperations(): Promise<typeof SessionsTools> {
  toolOperationsPromise ??= (
    existsSync(sourceModulePath)
      ? import("../../../src/tool-operations.ts")
      : import("../../../dist/tool-operations.mjs")
  ).catch((error: unknown) => {
    toolOperationsPromise = undefined;
    throw error;
  }) as Promise<typeof SessionsTools>;
  return toolOperationsPromise;
}

export default function sessionsExtension(pi: ExtensionAPI): void {
  const { Type } = pi.typebox;
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
        minLength: 1,
      }),
    ),
    until: Type.Optional(
      Type.String({
        description: "Inclusive last activity upper bound, ISO timestamp with timezone.",
        minLength: 1,
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
      block: Type.Integer({
        description: "Zero-based block index within that message.",
        minimum: 0,
      }),
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
        minLength: 1,
      }),
    ),
    until: Type.Optional(
      Type.String({
        description:
          "Inclusive message timestamp upper bound, ISO timestamp with timezone. Reuse when continuing.",
        minLength: 1,
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

  pi.setLabel("Sessions");

  pi.registerTool<typeof sourcesParameters, SessionsTools.SourcesDetails>({
    name: "sessions_sources",
    label: "Session Sources",
    description: "List supported native AI coding harness session sources and local availability.",
    parameters: sourcesParameters,
    approval: "read",
    async execute() {
      const { listSessionSources } = await loadToolOperations();
      return listSessionSources();
    },
  });

  pi.registerTool<typeof listParameters, SessionsTools.ListDetails>({
    name: "sessions_list",
    label: "List Sessions",
    description:
      "Discover sessions across selected or all available harnesses. Filter last activity with lastHours or since/until. Each row carries bounded metadata and a snippet of the session's first text, preferring what the user typed. Newest first.",
    parameters: listParameters,
    approval: "read",
    async execute(_toolCallId, params) {
      const { listSessions } = await loadToolOperations();
      return listSessions(params);
    },
  });

  pi.registerTool<typeof readParameters, SessionsTools.ReadDetails>({
    name: "sessions_read",
    label: "Read Session",
    description:
      "Read a bounded message window from one normalized native AI coding harness session by exact id.",
    parameters: readParameters,
    approval: "read",
    async execute(_toolCallId, params) {
      const { readSession } = await loadToolOperations();
      return readSession(params);
    },
  });
}
