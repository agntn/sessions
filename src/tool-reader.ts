import { assertDirectory, directoryPrefix, inDirectory } from "./core/cwd.ts";
import type {
  Message,
  Participant,
  SessionListFilter,
  Source,
  SourceReadOptions,
  SourceSessionSummary,
  SessionTimeRange,
} from "./core/types.ts";
import { snippetLine } from "./tool-snippet.ts";

/** Session metadata shared by bounded library and agent reads. */
export interface ToolSessionSummary {
  readonly id: string;
  readonly source: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
  readonly snippet?: string;
  /** The first working directory the session records. */
  readonly cwd?: string;
  /** The agent the session belongs to, when the source records one. */
  readonly owner?: Readonly<Participant>;
  /** The native session title, when the source keeps one. */
  readonly title?: string;
}

/**
 * Rejects unbounded windows before opening a native store.
 * @param offset - Original zero-based position.
 * @param limit - Maximum retained records.
 * @param range - Inclusive epoch millisecond bounds, and a directory and owner for listings.
 */
function validateWindow(offset: number, limit: number, range?: SessionListFilter): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("offset must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("limit must be a positive safe integer");
  }
  validateRange(range ?? {});
  if (range) validateFilter(range);
}

/**
 * Refuses a directory or owner that can't select anything.
 * @param filter - Listing filter.
 */
function validateFilter(filter: Readonly<SessionListFilter>): void {
  if (filter.cwd !== undefined) assertDirectory(filter.cwd);
  if (filter.owner?.trim() === "") throw new RangeError("owner must not be blank");
}

/**
 * Checks bounds without excluding open-ended windows.
 * @param range - Inclusive epoch millisecond bounds.
 */
function validateRange(range: SessionTimeRange): void {
  for (const value of [range.since, range.until]) {
    if (value !== undefined && !Number.isFinite(new Date(value).getTime())) {
      throw new RangeError("time bounds must be valid epoch milliseconds");
    }
  }
  if ((range.since ?? -Infinity) > (range.until ?? Infinity)) {
    throw new RangeError("since must not be after until");
  }
}

function inTimeRange(timestamp: number, range?: SessionTimeRange): boolean {
  if (!range) return true;
  return (
    (range.since === undefined || timestamp >= range.since) &&
    (range.until === undefined || timestamp <= range.until)
  );
}

function hasBounds(range?: SessionTimeRange): boolean {
  return range?.since !== undefined || range?.until !== undefined;
}

function hasInferredTime(message: Readonly<Pick<Message, "timestampSource">>): boolean {
  return message.timestampSource === "file" || message.timestampSource === "session";
}

function messageInTimeRange(
  message: Readonly<Pick<Message, "timestamp" | "timestampSource">>,
  range?: SessionTimeRange,
): boolean {
  if (!hasBounds(range)) return true;
  if (hasInferredTime(message)) return false;
  return (
    Number.isFinite(new Date(message.timestamp).getTime()) && inTimeRange(message.timestamp, range)
  );
}

/** One bounded summary page and the complete source session count. */
export interface ToolSummaryWindow {
  readonly total: number;
  readonly sessions: readonly ToolSessionSummary[];
}

/** One bounded message page and the complete count for the selected session. */
export interface ToolMessageWindow {
  readonly total: number;
  readonly messages: readonly Message[];
  readonly indices: readonly number[];
  readonly nextMessage?: number;
  /** Messages from `offset` up to `nextMessage` or the end that the bounds skipped because their time is inferred. */
  readonly inferredExcluded: number;
}

interface SnippetMessage {
  readonly role: Message["role"];
  readonly blocks: readonly { readonly type: string; readonly text?: string }[];
}

function firstSnippet(message: Readonly<SnippetMessage>): string | undefined {
  for (const block of message.blocks) {
    if (block.type !== "text" || !block.text) continue;
    const snippet = snippetLine(block.text);
    if (snippet) return snippet;
  }
  return undefined;
}

interface SessionClockMessage {
  readonly timestamp: number;
  readonly sessionCreatedAt?: number;
  readonly sessionUpdatedAt?: number;
}

/** What a summary reads from each message of its session. */
interface SummaryMessage extends SnippetMessage, SessionClockMessage {
  readonly context?: Readonly<Record<string, string>>;
  readonly owner?: Readonly<Participant>;
}

function openedAt(message: SessionClockMessage): number {
  return message.sessionCreatedAt ?? message.timestamp;
}

function closedAt(message: SessionClockMessage): number {
  return message.sessionUpdatedAt ?? message.timestamp;
}

/** One session's summary while its messages stream past. First directory, owner and title win. */
class SummaryDraft {
  private readonly id: string;
  private readonly source: string;
  private createdAt: number;
  private updatedAt: number;
  private messageCount = 0;
  private userSnippet?: string;
  private fallbackSnippet?: string;
  private cwd?: string;
  private owner?: Readonly<Participant>;
  private title?: string;

  constructor(first: Readonly<Pick<Message, "source" | "sessionId">> & SessionClockMessage) {
    this.id = first.sessionId;
    this.source = first.source;
    this.createdAt = openedAt(first);
    this.updatedAt = closedAt(first);
  }

  add(message: SummaryMessage): void {
    this.createdAt = Math.min(this.createdAt, openedAt(message));
    this.updatedAt = Math.max(this.updatedAt, closedAt(message));
    this.messageCount += 1;
    this.label(message);
    if (this.userSnippet) return;
    const snippet = firstSnippet(message);
    if (!snippet) return;
    if (message.role === "user") this.userSnippet = snippet;
    else this.fallbackSnippet ??= snippet;
  }

  private label(message: SummaryMessage): void {
    this.cwd ??= message.context?.cwd || undefined;
    this.title ??= message.context?.title || undefined;
    this.owner ??= message.owner;
  }

  finish(): ToolSessionSummary {
    return {
      id: this.id,
      source: this.source,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      messageCount: this.messageCount,
      snippet: this.userSnippet ?? this.fallbackSnippet,
      ...(this.cwd ? { cwd: this.cwd } : {}),
      ...(this.owner ? { owner: this.owner } : {}),
      ...(this.title ? { title: this.title } : {}),
    };
  }
}

function projectedSummary(summary: Readonly<SourceSessionSummary>): ToolSessionSummary {
  return {
    id: summary.id,
    source: summary.source,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    messageCount: summary.messageCount,
    snippet: summary.snippetText ? snippetLine(summary.snippetText) : undefined,
    ...(summary.cwd ? { cwd: summary.cwd } : {}),
  };
}

/**
 * Keeps the sessions a listing asked for, before any window is cut.
 *
 * @param summary - One finished summary.
 * @param filter - Last activity bounds, an optional directory and an optional owner id.
 * @returns {boolean} Whether the summary stays.
 */
function kept(summary: Readonly<ToolSessionSummary>, filter?: SessionListFilter): boolean {
  if (!inTimeRange(summary.updatedAt, filter)) return false;
  if (filter?.owner !== undefined && summary.owner?.platformId !== filter.owner) return false;
  if (filter?.cwd === undefined) return true;
  return summary.cwd !== undefined && inDirectory(summary.cwd, directoryPrefix(filter.cwd));
}

/**
 * The parts of a listing filter a source may answer before parsing.
 * @param filter - Listing filter.
 * @returns {SourceReadOptions} Activity bound and directory, each only when set.
 */
function listingOptions(filter?: SessionListFilter): SourceReadOptions {
  return {
    ...(filter?.since === undefined ? {} : { activeSince: filter.since }),
    ...(filter?.cwd === undefined ? {} : { cwd: filter.cwd }),
  };
}

/**
 * Lists bounded summaries while retaining at most one short text per session.
 *
 * @param source - Native harness source.
 * @param offset - Session offset, starting at zero.
 * @param limit - Maximum summaries to return.
 * @param range - Optional inclusive last activity bounds, absolute working directory and owner id.
 * @returns {Promise<ToolSummaryWindow>} Bounded summaries and the total session count.
 * @throws {RangeError} When the window, the bounds or the directory can't select anything.
 */
export async function listSourceSessions(
  source: Readonly<Source>,
  offset: number,
  limit: number,
  range?: SessionListFilter,
): Promise<ToolSummaryWindow> {
  validateWindow(offset, limit, range);
  if (source.summaryWindow) {
    const projected = await source.summaryWindow(offset, limit, range);
    return { total: projected.total, sessions: projected.sessions.map(projectedSummary) };
  }

  const summaries = new Map<string, SummaryDraft>();
  for await (const message of source.read(listingOptions(range))) {
    let summary = summaries.get(message.sessionId);
    if (!summary) {
      summary = new SummaryDraft({ ...message, source: source.name });
      summaries.set(message.sessionId, summary);
    }
    summary.add(message);
  }

  const sessions = [...summaries.values()]
    .map((summary) => summary.finish())
    .filter((summary) => kept(summary, range))
    .sort(
      (left, right) =>
        right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
  return { total: sessions.length, sessions: sessions.slice(offset, offset + limit) };
}

/**
 * Reads one bounded message page without retaining unrelated session payloads.
 *
 * @param source - Native harness source.
 * @param sessionId - Exact native session identifier.
 * @param offset - Message offset, starting at zero.
 * @param limit - Maximum matching messages to retain.
 * @param range - Optional inclusive message timestamp bounds.
 * @returns {Promise<ToolMessageWindow>} Bounded messages, the total message count, and how many inferred times the bounds skipped.
 */
export async function readSourceSession(
  source: Readonly<Source>,
  sessionId: string,
  offset: number,
  limit: number,
  range?: SessionTimeRange,
): Promise<ToolMessageWindow> {
  validateWindow(offset, limit, range);
  const messages: Message[] = [];
  const indices: number[] = [];
  let nextMessage: number | undefined;
  let total = 0;
  let inferredExcluded = 0;
  const bounded = hasBounds(range);
  for await (const message of source.read({ sessionId })) {
    if (message.sessionId !== sessionId) continue;
    const index = total++;
    if (index < offset || nextMessage !== undefined) continue;
    if (bounded && hasInferredTime(message)) {
      inferredExcluded += 1;
      continue;
    }
    if (!messageInTimeRange(message, range)) continue;
    if (messages.length < limit) {
      messages.push(message);
      indices.push(index);
    } else {
      nextMessage = index;
    }
  }
  return { total, messages, indices, nextMessage, inferredExcluded };
}
