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

import type { SessionTimeRange } from "./core/types.ts";
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
  sources: string[];
  since?: string;
  until?: string;
  offset: number;
  total: number;
  sessions: SessionSummary[];
}

/** Exact position within a normalized session read. */
export interface ReadPosition {
  readonly message: number;
  readonly block: number;
  readonly character: number;
}

/** The rendered message window and how much of it survived the output budget. */
export interface ReadDetails {
  since?: string;
  until?: string;
  source: string;
  sessionId: string;
  offset: number;
  limit: number;
  totalMessages: number;
  returnedMessages: number;
  outputTruncated: boolean;
  nextPosition?: ReadPosition;
}

/** Native data location overrides accepted by both reading tools. */
export interface SourceParams {
  source: string;
  path?: string;
  paths?: string[];
}

export interface ListParams {
  source?: string;
  sources?: string[];
  path?: string;
  paths?: string[];
  since?: string;
  until?: string;
  lastHours?: number;
  offset?: number;
  limit?: number;
}

export interface ReadParams extends SourceParams {
  since?: string;
  until?: string;
  offset?: number;
  limit?: number;
  sessionId: string;
  maxChars?: number;
  position?: ReadPosition;
}

interface SourceParamsInput {
  readonly source: string;
  readonly path?: string;
  readonly paths?: readonly string[];
}

interface ListParamsInput {
  readonly source?: string;
  readonly sources?: readonly string[];
  readonly path?: string;
  readonly paths?: readonly string[];
  readonly since?: string;
  readonly until?: string;
  readonly lastHours?: number;
  readonly offset?: number;
  readonly limit?: number;
}

interface ReadParamsInput extends SourceParamsInput {
  readonly since?: string;
  readonly until?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly sessionId: string;
  readonly maxChars?: number;
  readonly position?: Readonly<ReadPosition>;
}

interface RenderableBlock {
  readonly type: string;
  readonly text?: string;
  readonly toolName?: string;
  readonly toolInput?: string;
  readonly toolCallId?: string;
  readonly isError?: boolean;
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
export const DEFAULT_OUTPUT_CHARS = 20_000;
export const MIN_OUTPUT_CHARS = 1_000;
export const MAX_OUTPUT_CHARS = 100_000;
const MAX_DATE_STAMP_CHARS = 64;

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
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return fallback.length <= MAX_DATE_STAMP_CHARS ? fallback : "unknown";
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

function toolResultStatus(block: RenderableBlock): string {
  return block.isError === undefined ? "" : ` isError=${block.isError}`;
}

function blockParts(block: RenderableBlock): readonly string[] {
  const callId = block.toolCallId ? ` ${block.toolCallId}` : "";
  if (block.type === "tool_call") {
    return [
      `[tool_call ${block.toolName || "unknown"}${callId}]`,
      block.toolInput ? ` ${block.toolInput}` : "",
    ];
  }
  if (block.type === "tool_result") {
    return [`[tool_result${callId}${toolResultStatus(block)}]`, block.text ? ` ${block.text}` : ""];
  }

  const label = block.type === "text" ? "" : `[${block.type}] `;
  return block.text ? [label, block.text] : [`[${block.type}]`];
}

function blockLength(block: RenderableBlock): number {
  return blockParts(block).reduce((length, part) => length + part.length, 0);
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  return (
    /[\uD800-\uDBFF]/u.test(text.slice(offset - 1, offset)) &&
    /[\uDC00-\uDFFF]/u.test(text.slice(offset, offset + 1))
  );
}

class RenderBuffer {
  readonly #parts: string[] = [];
  #remaining: number;

  constructor(remaining: number) {
    this.#remaining = remaining;
  }

  append(text: string): boolean {
    if (text.length > this.#remaining) return false;
    this.#parts.push(text);
    this.#remaining -= text.length;
    return true;
  }

  appendBlock(
    block: RenderableBlock,
    character: number,
  ): { readonly complete: boolean; readonly nextCharacter: number } {
    let partStart = 0;
    for (const part of blockParts(block)) {
      const partEnd = partStart + part.length;
      if (character >= partEnd) {
        partStart = partEnd;
        continue;
      }

      const localStart = Math.max(character - partStart, 0);
      if (splitsSurrogatePair(part, localStart)) {
        throw new RangeError("position.character must come from the previous response");
      }
      if (part.length - localStart <= this.#remaining) {
        this.#parts.push(part.slice(localStart));
        this.#remaining -= part.length - localStart;
        partStart = partEnd;
        continue;
      }

      let localEnd = localStart + this.#remaining;
      if (splitsSurrogatePair(part, localEnd)) localEnd -= 1;
      this.#parts.push(part.slice(localStart, localEnd));
      this.#remaining -= localEnd - localStart;
      return { complete: false, nextCharacter: partStart + localEnd };
    }

    return { complete: true, nextCharacter: partStart };
  }

  renderBlocks(
    message: RenderableMessage,
    position: Readonly<ReadPosition>,
  ): ReadPosition | undefined {
    for (let blockIndex = position.block; blockIndex < message.blocks.length; blockIndex += 1) {
      const block = message.blocks[blockIndex];
      if (!block) continue;
      const character = blockIndex === position.block ? position.character : 0;
      const length = blockLength(block);
      if (character < 0 || character >= length) {
        throw new RangeError(`position.character must be between 0 and ${Math.max(length - 1, 0)}`);
      }
      if (blockIndex > position.block && !this.append("\n")) {
        return { message: position.message, block: blockIndex, character: 0 };
      }

      const rendered = this.appendBlock(block, character);
      if (!rendered.complete) {
        return {
          message: position.message,
          block: blockIndex,
          character: rendered.nextCharacter,
        };
      }
    }
    return undefined;
  }

  renderMessage(
    message: RenderableMessage,
    position: Readonly<ReadPosition>,
    prefix: string,
  ): ReadPosition | undefined {
    const header = `[${isoStamp(message.timestamp, message.date)}] ${message.role}\n`;
    if (!this.append(`${prefix}${header}`)) return { ...position };
    if (message.blocks.length === 0) return undefined;
    if (position.block >= message.blocks.length) {
      throw new RangeError(`position.block must be below ${message.blocks.length}`);
    }
    return this.renderBlocks(message, position);
  }

  text(): string {
    return this.#parts.join("");
  }
}

interface RenderableWindow {
  readonly total: number;
  readonly messages: readonly RenderableMessage[];
  readonly indices: readonly number[];
  readonly nextMessage?: number;
}

interface RenderedMessageWindow {
  readonly text: string;
  readonly nextPosition?: ReadPosition;
  readonly outputTruncated: boolean;
}

function renderMessageWindow(
  window: RenderableWindow,
  position: Readonly<ReadPosition>,
  budget: number,
): RenderedMessageWindow {
  const buffer = new RenderBuffer(budget);

  for (const [messageIndex, message] of window.messages.entries()) {
    const index = window.indices[messageIndex];
    if (index === undefined) throw new Error("Missing original message index");
    const current =
      index === position.message ? position : { message: index, block: 0, character: 0 };
    const nextPosition = buffer.renderMessage(message, current, messageIndex === 0 ? "" : "\n\n");
    if (nextPosition) {
      return { text: buffer.text(), nextPosition, outputTruncated: true };
    }
  }

  const nextMessage = window.nextMessage;
  return {
    text: buffer.text(),
    ...(nextMessage !== undefined
      ? { nextPosition: { message: nextMessage, block: 0, character: 0 } }
      : {}),
    outputTruncated: false,
  };
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

function continuationNotice(
  position: Readonly<ReadPosition>,
  startMessage: number,
  total: number,
  outputTruncated: boolean,
  filtered: boolean,
): string {
  const argument = JSON.stringify(position);
  if (outputTruncated) {
    return `[output truncated]\n[Use position=${argument} to continue.]`;
  }
  if (filtered) return `[Use position=${argument} to continue through matching messages.]`;
  return `[Showing messages ${startMessage + 1}-${position.message} of ${total}. Use position=${argument} to continue.]`;
}

function samePosition(left: Readonly<ReadPosition>, right: Readonly<ReadPosition>): boolean {
  return (
    left.message === right.message &&
    left.block === right.block &&
    left.character === right.character
  );
}

function assertProgress(
  output: Readonly<RenderedMessageWindow>,
  position: Readonly<ReadPosition>,
): void {
  if (
    output.outputTruncated &&
    output.nextPosition &&
    samePosition(output.nextPosition, position)
  ) {
    throw new Error("The output budget could not advance the session position");
  }
}

function validateWindowPosition(window: RenderableWindow, position: Readonly<ReadPosition>): void {
  if (position.message > window.total) {
    throw new RangeError(`position.message must be between 0 and ${window.total}`);
  }
  if (position.block === 0 && position.character === 0) return;
  if (window.indices[0] !== position.message) {
    throw new RangeError("The continuation message is not in the selected time range");
  }
}

function messageLimit(value?: number): number {
  const limit = value ?? DEFAULT_MESSAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MESSAGE_LIMIT) {
    throw new RangeError(`limit must be an integer between 1 and ${MAX_MESSAGE_LIMIT}`);
  }
  return limit;
}

function messageWindow(
  window: RenderableWindow,
  position: Readonly<ReadPosition>,
  limit: number,
  maxChars: number,
  filtered: boolean,
): RenderedMessageWindow {
  const { messages, total } = window;
  validateWindowPosition(window, position);
  if (messages.length === 0) {
    return {
      text: filtered
        ? `No messages match the time bounds at or after offset ${position.message}. Session has ${total} messages.`
        : `No messages in range ${position.message}:${position.message + limit}. Session has ${total} messages.`,
      outputTruncated: false,
    };
  }

  let bodyBudget = maxChars;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const output = renderMessageWindow(window, position, bodyBudget);
    if (!output.nextPosition) return output;
    assertProgress(output, position);
    const notice = continuationNotice(
      output.nextPosition,
      position.message,
      total,
      output.outputTruncated,
      filtered,
    );
    const text = `${output.text}\n\n${notice}`;
    if (text.length <= maxChars) return { ...output, text };
    bodyBudget -= text.length - maxChars;
  }

  throw new Error("Unable to fit the session continuation within maxChars");
}

function readPosition(params: ReadParamsInput): ReadPosition {
  if (params.position && params.offset !== undefined) {
    throw new RangeError("Use either offset or position, not both");
  }
  const position = params.position ?? { message: params.offset ?? 0, block: 0, character: 0 };
  for (const name of ["message", "block", "character"] as const) {
    const value = position[name];
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`position.${name} must be a non-negative integer`);
    }
  }
  return { message: position.message, block: position.block, character: position.character };
}

function readMaxChars(value?: number): number {
  const maxChars = value ?? DEFAULT_OUTPUT_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < MIN_OUTPUT_CHARS || maxChars > MAX_OUTPUT_CHARS) {
    throw new RangeError(
      `maxChars must be an integer between ${MIN_OUTPUT_CHARS} and ${MAX_OUTPUT_CHARS}`,
    );
  }
  return maxChars;
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

function timeBound(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  const timestamp = Date.parse(value);
  const local = match ? new Date(`${match[1]}T${match[2]}${match[3] ?? ""}Z`) : undefined;
  if (
    !match ||
    !Number.isFinite(timestamp) ||
    !local ||
    !Number.isFinite(local.getTime()) ||
    local.toISOString().slice(0, 19) !== `${match[1]}T${match[2]}`
  ) {
    throw new RangeError(`${name} must be an ISO timestamp with a timezone and a valid date`);
  }
  return timestamp;
}

function relativeTimeRange(hours: number): SessionTimeRange {
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new RangeError("lastHours must be a positive finite number");
  }
  const until = Date.now();
  const since = new Date(until - hours * 3_600_000).getTime();
  if (!Number.isFinite(since)) throw new RangeError("lastHours is too large");
  return { since, until };
}

function sessionTimeRange(params: ListParamsInput): SessionTimeRange | undefined {
  if (params.lastHours !== undefined) {
    if (params.since !== undefined || params.until !== undefined) {
      throw new RangeError("Use lastHours or since/until, not both");
    }
    return relativeTimeRange(params.lastHours);
  }
  const since = timeBound(params.since, "since");
  const until = timeBound(params.until, "until");
  if (since !== undefined && until !== undefined && since > until) {
    throw new RangeError("since must not be after until");
  }
  return since === undefined && until === undefined ? undefined : { since, until };
}

function selectedSources(params: ListParamsInput): string[] {
  if (params.source !== undefined && params.sources !== undefined) {
    throw new RangeError("Use source or sources, not both");
  }
  if ((params.path !== undefined || params.paths !== undefined) && params.source === undefined) {
    throw new RangeError("Path overrides require a single source");
  }
  const names = params.source !== undefined ? [params.source] : params.sources;
  if (names === undefined) {
    return allSources()
      .filter((source) => source.available())
      .map((source) => source.name);
  }
  return uniqueSources(names);
}

function uniqueSources(names: readonly string[]): string[] {
  if (names.length === 0 || names.length > 9 || names.some((name) => !name.trim())) {
    throw new RangeError("Choose between 1 and 9 non-empty source names");
  }
  return [...new Set(names.map((name) => name.trim()))];
}

function compareSessions(left: Readonly<SessionSummary>, right: Readonly<SessionSummary>): number {
  return (
    right.updatedAt - left.updatedAt ||
    left.source.localeCompare(right.source) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

function listPaging(params: PagingInput): { offset: number; limit: number } {
  const { offset, limit } = paging(params, DEFAULT_SESSION_LIMIT);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(offset + limit) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_SESSION_LIMIT
  ) {
    throw new RangeError(
      `Use a non-negative safe offset and a limit between 1 and ${MAX_SESSION_LIMIT}`,
    );
  }
  return { offset, limit };
}

async function collectSessions(
  params: ListParamsInput,
  names: readonly string[],
  range: SessionTimeRange | undefined,
  offset: number,
  limit: number,
): Promise<{ sessions: SessionSummary[]; total: number }> {
  const readers = names.map((source) => {
    const input = { ...params, source };
    const reader = createSource(source, optionsFrom(input));
    if (!reader.available()) throw new Error(unavailable(source, input));
    return reader;
  });
  const nativeOffset = names.length === 1 ? offset : 0;
  const nativeLimit = names.length === 1 ? limit : offset + limit;
  let sessions: SessionSummary[] = [];
  let total = 0;
  for (const reader of readers) {
    const window = await listSourceSessions(reader, nativeOffset, nativeLimit, range).catch(
      (cause: unknown) => {
        throw new Error(`Unable to list ${reader.name} sessions`, { cause });
      },
    );
    total += window.total;
    sessions = [...sessions, ...window.sessions].sort(compareSessions).slice(0, nativeLimit);
  }
  if (names.length !== 1) sessions = sessions.slice(offset);
  return { sessions, total };
}

function listHeader(
  details: Readonly<Omit<ListDetails, "sources" | "sessions">> & {
    readonly sources: readonly string[];
  },
): string {
  let header = `Sources: ${details.sources.join(", ") || "none available"}.`;
  if (details.since || details.until) {
    const bounds = [
      details.since && `since=${details.since}`,
      details.until && `until=${details.until}`,
    ]
      .filter(Boolean)
      .join(" ");
    header += ` Last activity: ${bounds} (inclusive). Reuse these bounds instead of lastHours when paging.`;
  }
  return header;
}

function listText(
  details: Readonly<Omit<ListDetails, "sources" | "sessions">> & {
    readonly sources: readonly string[];
    readonly sessions: readonly SessionSummary[];
  },
  includeSource: boolean,
): string {
  const { sessions, offset, source, total } = details;
  const listed = sessions
    .map((session) => `${includeSource ? `${session.source}\t` : ""}${formatSummary(session)}`)
    .join("\n");
  const notice = sessions.length ? windowNotice("session", offset, sessions.length, total) : "";
  const header = includeSource || details.since || details.until ? `${listHeader(details)}\n` : "";
  return `${header}${sessionWindowText(listed, notice, sessions.length, offset, source, total)}`;
}

function listedTimeBounds(range?: SessionTimeRange): { since?: string; until?: string } {
  return {
    since: range?.since === undefined ? undefined : new Date(range.since).toISOString(),
    until: range?.until === undefined ? undefined : new Date(range.until).toISOString(),
  };
}

/**
 * Lists one globally ordered page, optionally limited by last activity.
 * @param params - Harness selection, time bounds, and paging options.
 * @returns {Promise<ToolResult<ListDetails>>} Session summaries with their source and time bounds.
 */
export async function listSessions(params: ListParamsInput): Promise<ToolResult<ListDetails>> {
  const range = sessionTimeRange(params);
  const names = selectedSources(params);
  const { offset, limit } = listPaging(params);
  const { sessions, total } = await collectSessions(params, names, range, offset, limit);
  const source = params.source?.trim() ?? "all";
  if (!total && !range && params.source && overrideLabel({ ...params, source })) {
    throw new Error(unavailable(source, { ...params, source }));
  }
  const details: ListDetails = {
    source,
    sources: names,
    offset,
    total,
    sessions,
    ...listedTimeBounds(range),
  };
  return {
    content: [{ type: "text", text: listText(details, params.source === undefined) }],
    details,
  };
}

/**
 * Renders a bounded message window from one session addressed by exact id.
 *
 * @param params - Source, session identifier, location, and paging options.
 * @returns {Promise<ToolResult<ReadDetails>>} Text and structured metadata for the requested message window.
 */
export async function readSession(params: ReadParamsInput): Promise<ToolResult<ReadDetails>> {
  const range = sessionTimeRange({ since: params.since, until: params.until });
  const source = params.source.trim();
  const sessionId = params.sessionId.trim();
  if (!source) throw new Error("Source cannot be empty");
  if (!sessionId) throw new Error("Session id cannot be empty");

  const nativeSource = createSource(source, optionsFrom({ ...params, source }));
  if (!nativeSource.available()) throw new Error(unavailable(source, params));

  const position = readPosition(params);
  const limit = messageLimit(params.limit);
  const maxChars = readMaxChars(params.maxChars);
  const window = await readSourceSession(nativeSource, sessionId, position.message, limit, range);
  if (!window.total) throw new Error(`Session not found: ${source}:${sessionId}`);
  const bounds = listedTimeBounds(range);
  const header = range
    ? `[Message time: ${JSON.stringify(bounds)} (inclusive). Reuse these bounds when continuing. Positions use original message indices.]\n`
    : "";
  const output = messageWindow(window, position, limit, maxChars - header.length, !!range);

  return {
    content: [{ type: "text", text: header + output.text }],
    details: {
      source,
      sessionId,
      offset: position.message,
      limit,
      ...bounds,
      totalMessages: window.total,
      returnedMessages: window.messages.length,
      outputTruncated: output.outputTruncated,
      ...(output.nextPosition ? { nextPosition: output.nextPosition } : {}),
    },
  };
}
