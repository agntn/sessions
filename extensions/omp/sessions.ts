import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type * as SessionsTools from "../../src/tool-operations.ts";

const DEFAULT_SESSION_LIMIT = 20;
const MAX_SESSION_LIMIT = 100;
const DEFAULT_MESSAGE_LIMIT = 100;
const MAX_MESSAGE_LIMIT = 500;
const DEFAULT_OUTPUT_CHARS = 20_000;
const MIN_OUTPUT_CHARS = 1_000;
const MAX_OUTPUT_CHARS = 100_000;

const distributionModuleUrl = new URL("../../dist/tool-operations.mjs", import.meta.url);
const sourceModulePath = fileURLToPath(new URL("../../src/tool-operations.ts", import.meta.url));
let toolOperationsPromise: Promise<typeof SessionsTools> | undefined;

/**
 * Loads the executors shared with MCP and Pi from source in a checkout or from
 * the built bundle in a published package. The source import stays literal so
 * OMP's loader walks it and reloads edited source. The bundle goes through a URL
 * because tsc would resolve a literal path to `dist/`, which a fresh checkout
 * does not have.
 *
 * @returns {Promise<typeof SessionsTools>} The shared session tool operations.
 */
function loadToolOperations(): Promise<typeof SessionsTools> {
  toolOperationsPromise ??= (
    existsSync(sourceModulePath)
      ? import("../../src/tool-operations.ts")
      : import(distributionModuleUrl.href)
  ).catch((error: unknown) => {
    toolOperationsPromise = undefined;
    throw error;
  }) as Promise<typeof SessionsTools>;
  return toolOperationsPromise;
}

interface PlaceholderSourceParams {
  readonly source?: string;
  readonly path?: string;
  readonly paths?: readonly string[];
  readonly since?: string;
  readonly until?: string;
}

interface PlaceholderListParams extends PlaceholderSourceParams {
  readonly sources?: readonly string[];
  readonly lastHours?: number;
}

interface PlaceholderReadParams extends PlaceholderSourceParams {
  readonly source: string;
  readonly offset?: number;
  readonly position?: Readonly<{ message: number; block: number; character: number }>;
}

/**
 * OMP drops `""` only where the schema sets `minLength`, so `path: ""` and `" "` still get here.
 *
 * @param {string | undefined} value - Field as OMP passed it on.
 * @returns {string | undefined} The value, or undefined when it's blank.
 */
function text(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

/**
 * `paths` has no `minItems`, so OMP passes `[]` on as it came.
 *
 * @param {readonly string[] | undefined} value - List as OMP passed it on.
 * @returns {readonly string[] | undefined} The list, or undefined when it's empty.
 */
function list(value: readonly string[] | undefined): readonly string[] | undefined {
  return value?.length ? value : undefined;
}

/**
 * Keeps one of `source` and `sources` when `sources` holds `source`. Other pairs stay a conflict.
 *
 * @param params - List parameters without placeholders.
 * @returns {Pick<PlaceholderListParams, "source" | "sources">} The harness selection to pass on.
 */
function harnesses(
  params: Readonly<PlaceholderListParams>,
): Pick<PlaceholderListParams, "source" | "sources"> {
  const { source, sources } = params;
  if (source === undefined || sources?.includes(source) !== true) return { source, sources };
  const single = sources.length === 1 || params.path !== undefined || params.paths !== undefined;
  return single ? { source, sources: undefined } : { source: undefined, sources };
}

/**
 * Unsets OMP's list placeholders. A filler `lastHours` yields to a real `since` or `until`.
 *
 * @param params - Parameters as OMP passed them on.
 * @returns {T} The same parameters with each placeholder unset.
 */
function listParams<T extends Readonly<PlaceholderListParams>>(params: T): T {
  const since = text(params.since);
  const until = text(params.until);
  const set = { source: text(params.source), path: text(params.path), paths: list(params.paths) };
  return {
    ...params,
    ...set,
    ...harnesses({ ...set, sources: params.sources }),
    since,
    until,
    lastHours: since !== undefined || until !== undefined ? undefined : params.lastHours,
  };
}

/**
 * A zero `offset` or `position` beside the other one is only OMP's default, so it goes.
 *
 * @param params - Parameters as OMP passed them on.
 * @returns {T} The same parameters with each placeholder unset.
 */
function readParams<T extends Readonly<PlaceholderReadParams>>(params: T): T {
  const { offset, position } = params;
  const origin =
    position !== undefined &&
    position.message === 0 &&
    position.block === 0 &&
    position.character === 0;
  return {
    ...params,
    path: text(params.path),
    paths: list(params.paths),
    since: text(params.since),
    until: text(params.until),
    ...(position !== undefined && offset === 0 ? { offset: undefined } : {}),
    ...(origin && offset !== undefined && offset !== 0 ? { position: undefined } : {}),
  };
}

export default function sessionsExtension(pi: ExtensionAPI): void {
  const { Type } = pi.typebox;
  const sourceOptions = {
    source: Type.String({ description: "Harness source name, for example codex or claude." }),
    path: Type.Optional(
      Type.String({
        description:
          "Native data path for the single source: the sessions directory for claude, codex, gemini, grok, omp, openclaw and pi, the database file for aei, mastra and opencode.",
      }),
    ),
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
      return listSessions(listParams(params));
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
      return readSession(readParams(params));
    },
  });
}
