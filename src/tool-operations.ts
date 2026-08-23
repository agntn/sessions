/**
 * Tool executors shared by the MCP server and the Pi extension.
 *
 * Each executor returns the text a caller reads plus the structured details the
 * agent harnesses attach to the call. An MCP client sees only the text, so every
 * fact needed for a follow-up call has to be in it.
 *
 * Imports go through the package entrypoint so both surfaces read sessions the
 * same way the public API does.
 */

import { allSources, create } from "./index.ts";
import type { Message, Session, SourceOptions } from "./index.ts";

/** One text block plus the details a harness renders next to it. */
export interface ToolResult<TDetails> {
  content: Array<{ type: "text"; text: string }>;
  details: TDetails;
}

/** Session metadata without the message bodies. */
export type SessionSummary = Omit<Session, "messages"> & {
  messageCount: number;
  snippet?: string;
};

/** Supported harnesses and whether their native data is readable locally. */
export interface SourcesDetails {
  sources: Array<{ name: string; available: boolean }>;
}

/** The listed session window and the size of the archive it came from. */
export interface ListDetails {
  source: string;
  offset: number;
  total: number;
  sessions: SessionSummary[];
}

/** The rendered message window and how much of it survived the output budget. */
export interface ReadDetails {
  source: string;
  sessionId: string;
  offset: number;
  limit: number;
  totalMessages: number;
  returnedMessages: number;
  outputTruncated: boolean;
}

/** Native data location overrides accepted by both reading tools. */
export interface SourceParams {
  source: string;
  path?: string;
  paths?: string[];
}

export interface ListParams extends SourceParams {
  offset?: number;
  limit?: number;
}

export interface ReadParams extends ListParams {
  sessionId: string;
}

export const DEFAULT_SESSION_LIMIT = 20;
export const MAX_SESSION_LIMIT = 100;
export const DEFAULT_MESSAGE_LIMIT = 100;
export const MAX_MESSAGE_LIMIT = 500;
export const MAX_OUTPUT_CHARS = 100_000;
/** Upper bound on the window notice so message text plus notice stays within the budget. */
const NOTICE_RESERVE = 200;
const TRUNCATION_SUFFIX = "\n\n[output truncated]";

function optionsFrom(params: SourceParams): SourceOptions | undefined {
  const path = params.path?.trim();
  const paths = params.paths?.map((item) => item.trim()).filter(Boolean);
  if (!path && !paths?.length) return undefined;
  return { path: path || undefined, paths: paths?.length ? paths : undefined };
}

/**
 * Injected context that opens sessions instead of the person: codex prepends
 * AGENTS.md instructions, user instructions, and environment context as user
 * messages; claude prepends system reminders and local-command caveats. Each
 * shape reads the same for every session, so a snippet built from one says
 * nothing about the conversation.
 */
const INJECTED_PREFIXES = [
  "# AGENTS.md instructions",
  "<environment_context>",
  "<user_instructions>",
  "<system-reminder>",
  "<local-command-stdout>",
  "Caveat: The messages below",
];

/** Maximum characters of session text shown in one listing row. */
const SNIPPET_CHARS = 80;

/**
 * Collapses text to one printable listing line. Control characters count as
 * whitespace because pasted terminal output carries raw ANSI escapes, and one
 * escape would let a row restyle the whole listing. Injected blocks run to
 * megabytes, so the cut comes first.
 */
function singleLine(text: string): string {
  return text
    .slice(0, 2048)
    .replace(/[\s\x00-\x1F\x7F-\x9F]+/g, " ")
    .trim();
}

/**
 * The first line the person typed, or the first text at all when a harness
 * kept no user text, so a listing row says what a session is about without
 * paying for a full read.
 */
function snippetOf(messages: readonly Message[]): string | undefined {
  let fallback: string | undefined;
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== "text" || !block.text) continue;
      const line = singleLine(block.text);
      if (!line || INJECTED_PREFIXES.some((prefix) => line.startsWith(prefix))) continue;
      if (message.role === "user") return line.slice(0, SNIPPET_CHARS);
      fallback ??= line.slice(0, SNIPPET_CHARS);
    }
  }
  return fallback;
}

function summarize(session: Session): SessionSummary {
  const { messages, ...metadata } = session;
  return { ...metadata, messageCount: messages.length, snippet: snippetOf(messages) };
}

/**
 * A harness timestamp is only a number, so a corrupt archive can carry one
 * outside the Date range and make toISOString throw for a whole listing.
 */
function isoStamp(value: number, fallback: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function formatSummary(session: SessionSummary): string {
  const row = `${session.id}\t${session.messageCount} messages\t${isoStamp(session.updatedAt, "unknown")}`;
  return session.snippet ? `${row}\t${session.snippet}` : row;
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
    // Every adapter stores `date` as the day alone, so the header takes the
    // exact time from the numeric timestamp and keeps `date` as the fallback.
    if (!append(`[${isoStamp(message.timestamp, message.date)}] ${message.role}\n`)) break;

    for (const [blockIndex, block] of message.blocks.entries()) {
      if (blockIndex > 0 && !append("\n")) break;
      const callId = block.toolCallId ? ` ${block.toolCallId}` : "";
      if (block.type === "tool_call") {
        if (!append(`[tool_call ${block.toolName || "unknown"}${callId}]`)) break;
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

/** The caller's location override, joined for display, or nothing when absent. */
function overrideLabel(params: SourceParams): string | undefined {
  return (
    params.path?.trim() ||
    params.paths
      ?.map((item) => item.trim())
      .filter(Boolean)
      .join(", ") ||
    undefined
  );
}

/** Names the location that held no readable native data, so a typo is visible. */
function unavailable(source: string, params: SourceParams): string {
  const override = overrideLabel(params);
  return override
    ? `No readable ${source} data at ${override}.`
    : `No readable ${source} data at its native location.`;
}

/** Lists supported harnesses and whether their native data is readable locally. */
export function listSessionSources(): ToolResult<SourcesDetails> {
  const statuses = allSources().map((source) => ({
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
}

/** Lists bounded session metadata for one harness, newest first. */
export async function listSessions(params: ListParams): Promise<ToolResult<ListDetails>> {
  const source = params.source.trim();
  if (!source) throw new Error("Source cannot be empty");

  const reader = create(source, optionsFrom({ ...params, source }));
  const offset = params.offset ?? 0;
  const limit = params.limit ?? DEFAULT_SESSION_LIMIT;
  // An override pointing nowhere reads as an empty archive, so an unavailable
  // reader says so instead of reporting a harness with no sessions.
  if (!reader.available()) throw new Error(unavailable(source, params));
  const all = await reader.list();
  // A directory override only has to exist for available() to pass, so a path
  // that holds no sessions is a wrong location rather than an empty harness.
  if (!all.length && overrideLabel(params)) throw new Error(unavailable(source, params));
  const window = all.slice(offset, offset + limit).map(summarize);
  const listed = window.map(formatSummary).join("\n");
  const notice = window.length ? windowNotice("session", offset, window.length, all.length) : "";

  return {
    content: [
      {
        type: "text",
        text: window.length
          ? `${listed}${notice ? `\n\n${notice}` : ""}`
          : `No sessions at offset ${offset} for ${source}. It has ${all.length}.`,
      },
    ],
    details: { source, offset, total: all.length, sessions: window },
  };
}

/** Renders a bounded message window from one session addressed by exact id. */
export async function readSession(params: ReadParams): Promise<ToolResult<ReadDetails>> {
  const source = params.source.trim();
  const sessionId = params.sessionId.trim();
  if (!source) throw new Error("Source cannot be empty");
  if (!sessionId) throw new Error("Session id cannot be empty");

  const reader = create(source, optionsFrom({ ...params, source }));
  if (!reader.available()) throw new Error(unavailable(source, params));
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
}
