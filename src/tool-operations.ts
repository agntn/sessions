/**
 * Tool executors shared by the MCP server and the Pi extension.
 *
 * Each executor returns the text a caller reads plus the structured details the
 * agent harnesses attach to the call. An MCP client sees only the text, so every
 * fact needed for a follow-up call has to be in it.
 *
 * Both surfaces use the same bounded source projections. The public `list()`
 * API remains the path that returns complete archives to library consumers.
 */

import { allSources } from "./index.ts";
import type { SourceOptions } from "./index.ts";
import { createSource } from "./sources/index.ts";
import { listSourceSessions, readSourceSession, type ToolSessionSummary } from "./tool-reader.ts";

/** One text block plus the details a harness renders next to it. */
export interface ToolResult<TDetails> {
  content: Array<{ type: "text"; text: string }>;
  details: TDetails;
}

/** Session metadata without the message bodies. */
export type SessionSummary = ToolSessionSummary;

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

interface SourceParamsInput {
  readonly source: string;
  readonly path?: string;
  readonly paths?: readonly string[];
}

interface ListParamsInput extends SourceParamsInput {
  readonly offset?: number;
  readonly limit?: number;
}

interface ReadParamsInput extends ListParamsInput {
  readonly sessionId: string;
}

interface RenderableBlock {
  readonly type: string;
  readonly text?: string;
  readonly toolName?: string;
  readonly toolInput?: string;
  readonly toolCallId?: string;
}

interface RenderableMessage {
  readonly timestamp: number;
  readonly date: string;
  readonly role: "user" | "assistant" | "tool";
  readonly blocks: readonly RenderableBlock[];
}

interface PagingInput {
  readonly offset?: number;
  readonly limit?: number;
}

export const DEFAULT_SESSION_LIMIT = 20;
export const MAX_SESSION_LIMIT = 100;
export const DEFAULT_MESSAGE_LIMIT = 100;
export const MAX_MESSAGE_LIMIT = 500;
export const MAX_OUTPUT_CHARS = 100_000;
/** Upper bound on the window notice so message text plus notice stays within the budget. */
const NOTICE_RESERVE = 200;
const TRUNCATION_SUFFIX = "\n\n[output truncated]";

function optionsFrom(params: SourceParamsInput): SourceOptions | undefined {
  const path = params.path?.trim();
  const paths = params.paths?.map((item) => item.trim()).filter(Boolean);
  if (!path && !paths?.length) return undefined;
  return { path: path || undefined, paths: paths?.length ? paths : undefined };
}

/**
 * A harness timestamp is only a number, so a corrupt archive can carry one
 * outside the Date range and make toISOString throw for a whole listing.
 *
 * @param value - Candidate epoch timestamp.
 * @param fallback - Text returned for an invalid timestamp.
 * @returns {string} An ISO timestamp or the fallback.
 */
function isoStamp(value: number, fallback: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function formatSummary(session: Readonly<SessionSummary>): string {
  const row = `${session.id}\t${session.messageCount} messages\t${isoStamp(session.updatedAt, "unknown")}`;
  return session.snippet ? `${row}\t${session.snippet}` : row;
}

/**
 * Describes the returned window because tool details never reach the model.
 *
 * @param unit - Kind of item shown.
 * @param offset - Zero-based first item.
 * @param shown - Number of fully rendered items.
 * @param total - Total item count.
 * @returns {string} A paging notice, or an empty string for the complete archive.
 */
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

function renderBlock(block: RenderableBlock): string {
  const callId = block.toolCallId ? ` ${block.toolCallId}` : "";
  if (block.type === "tool_call") {
    const input = block.toolInput ? ` ${block.toolInput}` : "";
    return `[tool_call ${block.toolName || "unknown"}${callId}]${input}`;
  }
  if (block.type === "tool_result") {
    const output = block.text ? ` ${block.text}` : "";
    return `[tool_result${callId}]${output}`;
  }

  // Thinking and any future block type stay labelled, otherwise a model
  // reading the transcript takes internal reasoning for a plain answer.
  const label = block.type === "text" ? "" : `[${block.type}] `;
  return block.text ? `${label}${block.text}` : `[${block.type}]`;
}

function renderMessage(message: RenderableMessage): string {
  const header = `[${isoStamp(message.timestamp, message.date)}] ${message.role}\n`;
  return `${header}${message.blocks.map(renderBlock).join("\n")}`;
}

function formatMessages(
  messages: readonly RenderableMessage[],
  limit: number,
): { text: string; truncated: boolean; rendered: number } {
  const budget = limit - TRUNCATION_SUFFIX.length;
  let text = "";
  let rendered = 0;

  for (const [index, message] of messages.entries()) {
    const renderedMessage = `${index > 0 ? "\n\n" : ""}${renderMessage(message)}`;
    const remaining = budget - text.length;
    if (renderedMessage.length > remaining) {
      text += renderedMessage.slice(0, Math.max(remaining, 0));
      return { text: `${text}${TRUNCATION_SUFFIX}`, truncated: true, rendered };
    }
    text += renderedMessage;
    rendered += 1;
  }

  return { text, truncated: false, rendered };
}

/**
 * Returns the caller's location override joined for display.
 *
 * @param params - Source location options.
 * @returns {string | undefined} The display label, or `undefined` when no override exists.
 */
function overrideLabel(params: SourceParamsInput): string | undefined {
  return (
    params.path?.trim() ||
    params.paths
      ?.map((item) => item.trim())
      .filter(Boolean)
      .join(", ") ||
    undefined
  );
}

/**
 * Names the location that held no readable native data, so a typo is visible.
 *
 * @param source - Harness source name.
 * @param params - Source location options.
 * @returns {string} A location-aware error message.
 */
function unavailable(source: string, params: SourceParamsInput): string {
  const override = overrideLabel(params);
  return override
    ? `No readable ${source} data at ${override}.`
    : `No readable ${source} data at its native location.`;
}

function paging(
  params: PagingInput,
  defaultLimit: number,
): { readonly offset: number; readonly limit: number } {
  return { offset: params.offset ?? 0, limit: params.limit ?? defaultLimit };
}

function sessionWindowText(
  listed: string,
  notice: string,
  count: number,
  offset: number,
  source: string,
  total: number,
): string {
  if (count === 0) return `No sessions at offset ${offset} for ${source}. It has ${total}.`;
  return `${listed}${notice ? `\n\n${notice}` : ""}`;
}

function messageWindow(
  messages: readonly RenderableMessage[],
  offset: number,
  limit: number,
  total: number,
): { readonly output: ReturnType<typeof formatMessages>; readonly notice: string } {
  if (messages.length === 0) {
    return {
      output: {
        text: `No messages in range ${offset}:${offset + limit}. Session has ${total} messages.`,
        truncated: false,
        rendered: 0,
      },
      notice: "",
    };
  }
  const output = formatMessages(messages, MAX_OUTPUT_CHARS - NOTICE_RESERVE);
  return { output, notice: windowNotice("message", offset, output.rendered, total) };
}

/**
 * Lists supported harnesses and whether their native data is readable locally.
 *
 * @returns {ToolResult<SourcesDetails>} Text and structured source availability.
 */
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

/**
 * Lists bounded session metadata for one harness, newest first.
 *
 * @param params - Source, location, and paging options.
 * @returns {Promise<ToolResult<ListDetails>>} Text and structured metadata for the requested window.
 */
export async function listSessions(params: ListParamsInput): Promise<ToolResult<ListDetails>> {
  const source = params.source.trim();
  if (!source) throw new Error("Source cannot be empty");

  const nativeSource = createSource(source, optionsFrom({ ...params, source }));
  const { offset, limit } = paging(params, DEFAULT_SESSION_LIMIT);
  if (!nativeSource.available()) throw new Error(unavailable(source, params));
  const window = await listSourceSessions(nativeSource, offset, limit);
  if (!window.total && overrideLabel(params)) throw new Error(unavailable(source, params));
  const sessions = [...window.sessions];
  const listed = sessions.map(formatSummary).join("\n");
  const notice = sessions.length
    ? windowNotice("session", offset, sessions.length, window.total)
    : "";

  return {
    content: [
      {
        type: "text",
        text: sessionWindowText(listed, notice, sessions.length, offset, source, window.total),
      },
    ],
    details: { source, offset, total: window.total, sessions },
  };
}

/**
 * Renders a bounded message window from one session addressed by exact id.
 *
 * @param params - Source, session identifier, location, and paging options.
 * @returns {Promise<ToolResult<ReadDetails>>} Text and structured metadata for the requested message window.
 */
export async function readSession(params: ReadParamsInput): Promise<ToolResult<ReadDetails>> {
  const source = params.source.trim();
  const sessionId = params.sessionId.trim();
  if (!source) throw new Error("Source cannot be empty");
  if (!sessionId) throw new Error("Session id cannot be empty");

  const nativeSource = createSource(source, optionsFrom({ ...params, source }));
  if (!nativeSource.available()) throw new Error(unavailable(source, params));

  const { offset, limit } = paging(params, DEFAULT_MESSAGE_LIMIT);
  const window = await readSourceSession(nativeSource, sessionId, offset, limit);
  if (!window.total) throw new Error(`Session not found: ${source}:${sessionId}`);
  const { output, notice } = messageWindow(window.messages, offset, limit, window.total);

  return {
    content: [{ type: "text", text: notice ? `${output.text}\n\n${notice}` : output.text }],
    details: {
      source,
      sessionId,
      offset,
      limit,
      totalMessages: window.total,
      returnedMessages: window.messages.length,
      outputTruncated: output.truncated,
    },
  };
}
