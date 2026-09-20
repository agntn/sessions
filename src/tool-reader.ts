import type { Message, Source, SourceSessionSummary, SessionTimeRange } from "./core/types.ts";
import { snippetLine } from "./tool-snippet.ts";

/** Session metadata retained by the bounded agent tool read path. */
export interface ToolSessionSummary {
  readonly id: string;
  readonly source: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
  readonly snippet?: string;
}

function inTimeRange(timestamp: number, range?: SessionTimeRange): boolean {
  if (!range) return true;
  return (
    (range.since === undefined || timestamp >= range.since) &&
    (range.until === undefined || timestamp <= range.until)
  );
}

function messageInTimeRange(timestamp: number, range?: SessionTimeRange): boolean {
  return (
    !range || (Number.isFinite(new Date(timestamp).getTime()) && inTimeRange(timestamp, range))
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
}

interface SnippetMessage {
  readonly role: Message["role"];
  readonly blocks: readonly { readonly type: string; readonly text?: string }[];
}

interface MutableSummary {
  readonly id: string;
  readonly source: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  userSnippet?: string;
  fallbackSnippet?: string;
}

function firstSnippet(message: Readonly<SnippetMessage>): string | undefined {
  for (const block of message.blocks) {
    if (block.type !== "text" || !block.text) continue;
    const snippet = snippetLine(block.text);
    if (snippet) return snippet;
  }
  return undefined;
}

function finishSummary(summary: Readonly<MutableSummary>): ToolSessionSummary {
  return {
    id: summary.id,
    source: summary.source,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    messageCount: summary.messageCount,
    snippet: summary.userSnippet ?? summary.fallbackSnippet,
  };
}

function projectedSummary(summary: Readonly<SourceSessionSummary>): ToolSessionSummary {
  return {
    id: summary.id,
    source: summary.source,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    messageCount: summary.messageCount,
    snippet: summary.snippetText ? snippetLine(summary.snippetText) : undefined,
  };
}

/**
 * Lists bounded summaries while retaining at most one short text per session.
 *
 * @param source - Native harness source.
 * @param offset - Session offset, starting at zero.
 * @param limit - Maximum summaries to return.
 * @param range - Optional inclusive last activity bounds.
 * @returns {Promise<ToolSummaryWindow>} Bounded summaries and the total session count.
 */
export async function listSourceSessions(
  source: Readonly<Source>,
  offset: number,
  limit: number,
  range?: SessionTimeRange,
): Promise<ToolSummaryWindow> {
  if (source.summaryWindow) {
    const projected = await source.summaryWindow(offset, limit, range);
    return { total: projected.total, sessions: projected.sessions.map(projectedSummary) };
  }

  const summaries = new Map<string, MutableSummary>();
  for await (const message of source.read()) {
    let summary = summaries.get(message.sessionId);
    if (!summary) {
      summary = {
        id: message.sessionId,
        source: source.name,
        createdAt: message.timestamp,
        updatedAt: message.timestamp,
        messageCount: 0,
      };
      summaries.set(message.sessionId, summary);
    }
    summary.createdAt = Math.min(summary.createdAt, message.timestamp);
    summary.updatedAt = Math.max(summary.updatedAt, message.timestamp);
    summary.messageCount += 1;
    if (summary.userSnippet) continue;
    const snippet = firstSnippet(message);
    if (!snippet) continue;
    if (message.role === "user") summary.userSnippet = snippet;
    else summary.fallbackSnippet ??= snippet;
  }

  const sessions = [...summaries.values()]
    .map(finishSummary)
    .filter((summary) => inTimeRange(summary.updatedAt, range))
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
 * @returns {Promise<ToolMessageWindow>} Bounded messages and the total message count.
 */
export async function readSourceSession(
  source: Readonly<Source>,
  sessionId: string,
  offset: number,
  limit: number,
  range?: SessionTimeRange,
): Promise<ToolMessageWindow> {
  const messages: Message[] = [];
  const indices: number[] = [];
  let nextMessage: number | undefined;
  let total = 0;
  for await (const message of source.read({ sessionId })) {
    if (message.sessionId !== sessionId) continue;
    const index = total++;
    if (index < offset || nextMessage !== undefined) continue;
    if (!messageInTimeRange(message.timestamp, range)) continue;
    if (messages.length < limit) {
      messages.push(message);
      indices.push(index);
    } else {
      nextMessage = index;
    }
  }
  return { total, messages, indices, nextMessage };
}
