import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../core/db.ts";
import { home, osUser } from "../core/env.ts";
import type { Block, Message, Participant, Source, SourceReadOptions } from "../core/types.ts";
import { isRecord, parseJson, parseJsonRecord, scalarText } from "./parsing.ts";

/** Tool rows carry whole outputs, so pages stay small. */
const WINDOW = 1000;

/** Prefix Hermes puts on content it stored as JSON parts. */
const JSON_CONTENT = "\u0000json:";

/** Turns that ended the way the model meant to, so they need no stop block. */
const PLANNED_STOPS = new Set(["stop", "tool_calls"]);

const BOT: Participant = { platform: "cli", name: "hermes", isBot: true };

type Row = Readonly<Record<string, unknown>>;

function text(value: unknown): string | undefined {
  return scalarText(value) || undefined;
}

function partText(part: unknown): string | undefined {
  if (!isRecord(part)) return text(part);
  if (part.type === "text") return text(part.text);
  return part.type === "image_url" || part.type === "image" ? "[image]" : undefined;
}

/**
 * Reads stored content: plain text, or the JSON Hermes writes for structured parts.
 * @param value - Native `content` column.
 * @returns {string | undefined} Readable text, the raw value when its JSON is broken.
 */
function contentText(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw?.startsWith(JSON_CONTENT)) return raw;
  try {
    const parsed = parseJson(raw.slice(JSON_CONTENT.length));
    const parts = Array.isArray(parsed) ? parsed : [parsed];
    return parts.flatMap((part: unknown) => partText(part) ?? []).join("\n") || undefined;
  } catch {
    return raw;
  }
}

function toolCall(value: unknown): Block[] {
  if (!isRecord(value)) return [];
  const call = isRecord(value.function) ? value.function : {};
  const input = call.arguments;
  return [
    {
      type: "tool_call",
      toolName: text(call.name) ?? "",
      toolCallId: text(value.id) ?? text(value.call_id) ?? "",
      toolInput: typeof input === "string" ? input : (JSON.stringify(input) ?? ""),
    },
  ];
}

function toolCalls(value: unknown): Block[] {
  const raw = text(value);
  if (!raw) return [];
  try {
    const parsed = parseJson(raw);
    return Array.isArray(parsed) ? parsed.flatMap(toolCall) : [];
  } catch {
    return [];
  }
}

/**
 * Says why a turn ended early: a failed request Hermes kept for display, or a cut reply.
 * @param row - One assistant row.
 * @returns {Block[]} One stop block, or nothing for a turn that ended on its own.
 */
function stopBlocks(row: Row): Block[] {
  if (row.kind === "failed_turn") {
    const error = text(parseJsonRecord(text(row.display) ?? "")?.error);
    return [{ type: "stop", stopReason: "error", ...(error ? { text: error } : {}) }];
  }
  const reason = text(row.finish);
  return reason && !PLANNED_STOPS.has(reason) ? [{ type: "stop", stopReason: reason }] : [];
}

function assistantBlocks(row: Row): Block[] {
  const thinking = text(row.reasoning) ?? text(row.reasoningContent);
  const body = row.kind === "failed_turn" ? undefined : contentText(row.content);
  return [
    ...(thinking ? [{ type: "thinking" as const, text: thinking }] : []),
    ...(body ? [{ type: "text" as const, text: body }] : []),
    ...toolCalls(row.toolCalls),
    ...stopBlocks(row),
  ];
}

function toolBlocks(row: Row): Block[] {
  const toolName = text(row.toolName);
  return [
    {
      type: "tool_result",
      toolCallId: text(row.toolCallId) ?? "",
      text: contentText(row.content) ?? "",
      ...(toolName ? { toolName } : {}),
    },
  ];
}

function blocksOf(row: Row, role: Message["role"]): Block[] {
  if (role === "assistant") return assistantBlocks(row);
  if (role === "tool") return toolBlocks(row);
  const body = contentText(row.content);
  return body ? [{ type: "text", text: body }] : [];
}

function roleOf(value: unknown): Message["role"] | undefined {
  return value === "user" || value === "assistant" || value === "tool" ? value : undefined;
}

function contextOf(row: Row): Record<string, string> {
  const context: Record<string, string> = { hermesRowId: String(row.id) };
  for (const [key, column] of [
    ["title", "title"],
    ["cwd", "cwd"],
    ["parentSessionId", "parent"],
  ] as const) {
    const value = text(row[column]);
    if (value) context[key] = value;
  }
  if (Number(row.compacted) === 1) context.compacted = "true";
  return context;
}

/** Rows Hermes shows in a transcript: live ones plus the history a compaction archived. */
const SHOWN = "(m.active = 1 OR m.compacted = 1)";

function pageSql(sessionId: boolean, cursor: boolean, reached: boolean): string {
  const predicates = [SHOWN];
  if (sessionId) predicates.push("m.session_id = ?");
  if (reached) predicates.push("m.session_id IN (SELECT value FROM json_each(?))");
  if (cursor) predicates.push("m.id > ?");
  return `SELECT m.id, m.session_id AS sid, m.role, m.content, m.tool_calls AS toolCalls,
      m.tool_call_id AS toolCallId, m.tool_name AS toolName, m.timestamp, m.finish_reason AS finish,
      m.reasoning, m.reasoning_content AS reasoningContent, m.display_kind AS kind,
      m.display_metadata AS display, m.compacted, s.source AS platform, s.title, s.cwd,
      s.parent_session_id AS parent
    FROM messages m LEFT JOIN sessions s ON s.id = m.session_id
    WHERE ${predicates.join(" AND ")} ORDER BY m.id LIMIT ?`;
}

/**
 * Sessions whose last shown message is at or after the bound, as one JSON array.
 * @param db - Open Hermes database.
 * @param since - Epoch milliseconds a listing needs.
 * @returns {string} Session ids as JSON, for `json_each`.
 */
function reachedSessions(db: Readonly<DatabaseSync>, since: number): string {
  const row = db
    .prepare(
      `SELECT json_group_array(sid) AS ids FROM (SELECT m.session_id AS sid FROM messages m
        WHERE ${SHOWN} GROUP BY m.session_id HAVING MAX(m.timestamp) >= ?)`,
    )
    .get(since / 1000);
  return text(row?.ids) ?? "[]";
}

/** Page queries of one read and the filter arguments both take. */
interface Query {
  readonly first: string;
  readonly next: string;
  readonly args: readonly string[];
}

/**
 * Builds the page queries for one read.
 * @param db - Open Hermes database.
 * @param options - Exact session and activity filters.
 * @returns {Query | undefined} The queries, or nothing when no session reaches `activeSince`.
 */
function queryOf(db: Readonly<DatabaseSync>, options?: SourceReadOptions): Query | undefined {
  const sessionId = options?.sessionId;
  const since = options?.activeSince;
  const reached = since === undefined ? undefined : reachedSessions(db, since);
  if (reached === "[]") return undefined;
  const filters = [sessionId, reached].filter((value) => value !== undefined);
  return {
    first: pageSql(sessionId !== undefined, false, reached !== undefined),
    next: pageSql(sessionId !== undefined, true, reached !== undefined),
    args: filters,
  };
}

function defaultDbPath(): string {
  const override = process.env.HERMES_HOME?.trim();
  return join(override || join(home(), ".hermes"), "state.db");
}

/** Hermes Agent sessions from `state.db`. A compressed run names its parent session. */
export class HermesSource implements Source {
  name = "hermes";
  private dbPath: string;
  private user: Participant;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? defaultDbPath();
    this.user = { platform: "cli", name: osUser() };
  }

  available(): boolean {
    return existsSync(this.dbPath);
  }

  async *read(options?: SourceReadOptions): AsyncGenerator<Message> {
    const db = await openDatabase(this.dbPath);
    try {
      yield* this.pages(db, options);
    } finally {
      db.close();
    }
  }

  private *pages(db: Readonly<DatabaseSync>, options?: SourceReadOptions): Generator<Message> {
    const query = queryOf(db, options);
    if (!query) return;
    let rows = db.prepare(query.first).all(...query.args, WINDOW);
    while (true) {
      for (const row of rows) {
        const result = this.message(row);
        if (result) yield result;
      }
      const cursor = Number(rows.at(-1)?.id);
      if (rows.length < WINDOW || !Number.isFinite(cursor)) return;
      rows = db.prepare(query.next).all(...query.args, cursor, WINDOW);
    }
  }

  /**
   * Only a CLI prompt is the local user. Gateways and cron stay unknown.
   * @param role - Normalized role of the row.
   * @param row - The row with its session's platform.
   * @returns {{ author?: Participant }} The author, or nothing when Hermes didn't record one.
   */
  private authorOf(role: Message["role"], row: Row): { author?: Participant } {
    if (role !== "user") return { author: BOT };
    return row.platform === "cli" ? { author: this.user } : {};
  }

  private message(row: Row): Message | undefined {
    const role = roleOf(row.role);
    const sessionId = text(row.sid);
    const seconds = Number(row.timestamp);
    if (!role || !sessionId || !Number.isFinite(seconds)) return undefined;
    const blocks = blocksOf(row, role);
    const timestamp = Math.round(seconds * 1000);
    const date = new Date(timestamp);
    if (blocks.length === 0 || Number.isNaN(date.getTime())) return undefined;
    return {
      source: this.name,
      sessionId,
      role,
      timestamp,
      timestampSource: "message",
      date: date.toISOString().slice(0, 10),
      blocks,
      context: contextOf(row),
      channel: { platform: text(row.platform) ?? "cli", name: "hermes" },
      ...this.authorOf(role, row),
    };
  }
}
