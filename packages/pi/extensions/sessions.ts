import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import type {
  allSources as allSourcesFunction,
  create as createFunction,
  Message,
  Session,
  SourceOptions,
} from "@agntn/sessions";

type SessionsModule = {
  allSources: typeof allSourcesFunction;
  create: typeof createFunction;
};

type SessionSummary = Omit<Session, "messages"> & { messageCount: number };
type SourcesDetails = { sources: Array<{ name: string; available: boolean }> };
type ListDetails = {
  source: string;
  offset: number;
  total: number;
  sessions: SessionSummary[];
};
type ReadDetails = {
  source: string;
  sessionId: string;
  offset: number;
  limit: number;
  totalMessages: number;
  returnedMessages: number;
  outputTruncated: boolean;
};

let sessionsModulePromise: Promise<SessionsModule> | undefined;

/**
 * Loads the library from repository source when that entry exists and from the
 * published package export otherwise. Source first keeps a checkout that still
 * holds an older `dist/` from silently running stale library code, and the
 * existence check keeps a transitive load failure from being mistaken for a
 * missing entry module.
 */
function loadSessions(): Promise<SessionsModule> {
  sessionsModulePromise ??= existsSync(
    fileURLToPath(new URL("../../../src/index.ts", import.meta.url)),
  )
    ? import("../../../src/index.ts")
    : import("@agntn/sessions");
  return sessionsModulePromise;
}

const DEFAULT_SESSION_LIMIT = 20;
const MAX_SESSION_LIMIT = 100;
const DEFAULT_MESSAGE_LIMIT = 100;
const MAX_MESSAGE_LIMIT = 500;
const MAX_OUTPUT_CHARS = 100_000;
/** Upper bound on the window notice so message text plus notice stays within the budget. */
const NOTICE_RESERVE = 200;
const TRUNCATION_SUFFIX = "\n\n[output truncated]";

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

function optionsFrom(params: { path?: string; paths?: string[] }): SourceOptions | undefined {
  const path = params.path?.trim();
  const paths = params.paths?.map((item) => item.trim()).filter(Boolean);
  if (!path && !paths?.length) return undefined;
  return { path: path || undefined, paths: paths?.length ? paths : undefined };
}

function summarize(session: Session): SessionSummary {
  const { messages, ...metadata } = session;
  return { ...metadata, messageCount: messages.length };
}

function formatSummary(session: SessionSummary): string {
  // A harness timestamp is only a number, so a corrupt archive can carry one
  // outside the Date range and make toISOString throw for the whole listing.
  const updated = new Date(session.updatedAt);
  const stamp = Number.isNaN(updated.getTime()) ? "unknown" : updated.toISOString();
  return `${session.id}\t${session.messageCount} messages\t${stamp}`;
}

/** Describes the returned window because tool details never reach the model. */
function windowNotice(
  unit: "message" | "session",
  offset: number,
  shown: number,
  total: number,
): string {
  if (!shown) return `[The ${unit} at offset ${offset} exceeds the output budget and was cut.]`;
  const end = offset + shown;
  if (offset === 0 && end >= total) return "";
  if (end >= total) return `[Showing ${unit}s ${offset + 1}-${end} of ${total}.]`;
  return `[Showing ${unit}s ${offset + 1}-${end} of ${total}. Use offset=${end} to continue.]`;
}

function formatMessages(
  messages: readonly Message[],
  limit: number,
): { text: string; truncated: boolean; rendered: number } {
  const budget = limit - TRUNCATION_SUFFIX.length;
  let text = "";
  let truncated = false;
  let rendered = 0;

  const append = (value: string): boolean => {
    const remaining = budget - text.length;
    if (value.length <= remaining) {
      text += value;
      return true;
    }
    text += value.slice(0, Math.max(remaining, 0));
    truncated = true;
    return false;
  };

  for (const [messageIndex, message] of messages.entries()) {
    if (messageIndex > 0 && !append("\n\n")) break;
    if (!append(`[${message.date}] ${message.role}\n`)) break;

    for (const [blockIndex, block] of message.blocks.entries()) {
      if (blockIndex > 0 && !append("\n")) break;
      const callId = block.toolCallId ? ` ${block.toolCallId}` : "";
      if (block.type === "tool_call") {
        if (!append(`[tool_call ${block.toolName ?? "unknown"}${callId}]`)) break;
        if (block.toolInput && (!append(" ") || !append(block.toolInput))) break;
        continue;
      }
      if (block.type === "tool_result") {
        if (!append(`[tool_result${callId}]`)) break;
        if (block.text && (!append(" ") || !append(block.text))) break;
        continue;
      }
      // Thinking and any future block type stay labelled, otherwise a model
      // reading the transcript takes internal reasoning for a plain answer.
      const label = block.type === "text" ? "" : `[${block.type}] `;
      if (!append(block.text ? `${label}${block.text}` : `[${block.type}]`)) break;
    }
    if (truncated) break;
    rendered += 1;
  }

  return truncated
    ? { text: `${text}${TRUNCATION_SUFFIX}`, truncated, rendered }
    : { text, truncated, rendered };
}

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
    async execute(): Promise<AgentToolResult<SourcesDetails>> {
      const sessions = await loadSessions();
      const statuses = sessions.allSources().map((source) => ({
        name: source.name,
        available: source.available(),
      }));
      return {
        content: [
          {
            type: "text",
            text: statuses
              .map(({ name, available }) => `${name}\t${available ? "available" : "unavailable"}`)
              .join("\n"),
          },
        ],
        details: { sources: statuses },
      };
    },
  });

  pi.registerTool({
    name: "sessions_list",
    label: "List Sessions",
    description:
      "Discover normalized native AI coding sessions for one harness. Returns bounded metadata only, newest first.",
    promptSnippet: "List recent normalized coding sessions from a native harness source.",
    promptGuidelines: [
      "Choose one supported source; use sessions_sources if uncertain.",
      "Use path or paths only to override the harness's native default location.",
      "Sessions come newest first; page older ones with offset.",
      "Use sessions_read with an exact returned session id to inspect messages.",
    ],
    parameters: listParameters,
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", `sessions_list ${args.source}`), 0, 0);
    },
    async execute(_toolCallId, params: ListParams): Promise<AgentToolResult<ListDetails>> {
      const source = params.source.trim();
      if (!source) throw new Error("Source cannot be empty");
      const sessions = await loadSessions();
      const reader = sessions.create(source, optionsFrom(params));
      const offset = params.offset ?? 0;
      const limit = params.limit ?? DEFAULT_SESSION_LIMIT;
      const all = await reader.list();
      const result = all.slice(offset, offset + limit).map(summarize);
      const listed = result.map(formatSummary).join("\n");
      const notice = result.length
        ? windowNotice("session", offset, result.length, all.length)
        : "";
      return {
        content: [
          {
            type: "text",
            text: result.length
              ? `${listed}${notice ? `\n\n${notice}` : ""}`
              : `No sessions at offset ${offset} for ${source}. It has ${all.length}.`,
          },
        ],
        details: { source, offset, total: all.length, sessions: result },
      };
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
    async execute(_toolCallId, params: ReadParams): Promise<AgentToolResult<ReadDetails>> {
      const source = params.source.trim();
      const sessionId = params.sessionId.trim();
      if (!source) throw new Error("Source cannot be empty");
      if (!sessionId) throw new Error("Session id cannot be empty");

      const sessions = await loadSessions();
      const reader = sessions.create(source, optionsFrom(params));
      const session = (await reader.list()).find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error(`Session not found: ${source}:${sessionId}`);

      const offset = params.offset ?? 0;
      const limit = params.limit ?? DEFAULT_MESSAGE_LIMIT;
      const total = session.messages.length;
      const messages = session.messages.slice(offset, offset + limit);
      const output = messages.length
        ? formatMessages(messages, MAX_OUTPUT_CHARS - NOTICE_RESERVE)
        : {
            text: `No messages in range ${offset}:${offset + limit}. Session has ${total} messages.`,
            truncated: false,
            rendered: 0,
          };
      const notice = messages.length ? windowNotice("message", offset, output.rendered, total) : "";
      return {
        content: [{ type: "text", text: notice ? `${output.text}\n\n${notice}` : output.text }],
        details: {
          source,
          sessionId,
          offset,
          limit,
          totalMessages: total,
          returnedMessages: messages.length,
          outputTruncated: output.truncated,
        },
      };
    },
  });
}
