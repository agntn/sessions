import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../core/db.ts";
import { home, osUser } from "../core/env.ts";
import type { Block, Channel, Message, Participant, Source } from "../core/types.ts";
import { scalarText } from "./parsing.ts";

// Medium window: rows are narrow, blocks fetched in a separate query.
const WINDOW = 500;

const BASE_COLS = ["id", "session_id", "role", "timestamp", "date"] as const;
const EXTRA_MSG_COLS = [
  "cwd",
  "git_branch",
  "git_commit",
  "git_worktree",
  "git_dirty",
  "model",
  "sender_id",
] as const;
const EXTRA_SESSION_COLS = [
  "project",
  "git_remote",
  "hostname",
  "os_user",
  "initiator_id",
] as const;

interface Boundary {
  readonly timestamp: number;
  readonly id: number;
}

interface MessageRow {
  readonly [column: string]: unknown;
  readonly id: unknown;
  readonly session_id: unknown;
  readonly role: unknown;
  readonly timestamp: unknown;
  readonly date: unknown;
}

interface BlockRow {
  readonly message_id: number;
  readonly position: number;
  readonly type: string;
  readonly text: string | null;
  readonly tool_name: string | null;
  readonly tool_input: string | null;
  readonly tool_call_id: string | null;
}

interface MessageMetadata {
  readonly source: string;
  readonly sessionId: string;
  readonly role: "user" | "assistant" | "tool";
  readonly timestamp: number;
  readonly date: string;
  readonly context: Record<string, string>;
  readonly channel: Channel;
  readonly author: Participant;
}

function columnNames(rows: readonly Readonly<Record<string, unknown>>[]): Set<string> {
  return new Set(rows.flatMap((row) => scalarText(row.name) ?? []));
}

function selectedColumns(
  messageColumns: readonly string[],
  sessionColumns: readonly string[],
): string {
  return [
    ...BASE_COLS.map((column) => `m.${column}`),
    ...messageColumns.map((column) => `m.${column}`),
    ...sessionColumns.map((column) => `s.${column}`),
  ].join(", ");
}

function queryBoundary(boundary: Boundary | undefined): {
  readonly sql: string;
  readonly args: number[];
} {
  if (!boundary) return { sql: "", args: [WINDOW] };
  return {
    sql: "AND (m.timestamp > ? OR (m.timestamp = ? AND m.id > ?))",
    args: [boundary.timestamp, boundary.timestamp, boundary.id, WINDOW],
  };
}

function groupBlocks(rows: readonly BlockRow[]): ReadonlyMap<number, Block[]> {
  const grouped = new Map<number, Block[]>();
  for (const row of rows) {
    const block: Block = { type: row.type as Block["type"] };
    if (row.text) block.text = row.text;
    if (row.tool_name) block.toolName = row.tool_name;
    if (row.tool_input) block.toolInput = row.tool_input;
    if (row.tool_call_id) block.toolCallId = row.tool_call_id;
    const existing = grouped.get(row.message_id);
    if (existing) existing.push(block);
    else grouped.set(row.message_id, [block]);
  }
  return grouped;
}

function contextFromRow(
  row: MessageRow,
  messageColumns: readonly string[],
  sessionColumns: readonly string[],
): Record<string, string> {
  const context: Record<string, string> = { aeiMsgId: scalarText(row.id) ?? "" };
  for (const column of [...messageColumns, ...sessionColumns]) {
    const value = scalarText(row[column]);
    if (value !== undefined) context[column] = value;
  }
  return context;
}

function authorFromRow(row: MessageRow, role: "user" | "assistant" | "tool"): Participant {
  const sender = scalarText(row.sender_id);
  if (role !== "user") return { platform: "cli", name: sender || "aei", isBot: true };
  return {
    platform: "cli",
    name: sender || scalarText(row.os_user) || osUser(),
    platformId: scalarText(row.initiator_id),
  };
}

function metadataFromRow(
  row: MessageRow,
  messageColumns: readonly string[],
  sessionColumns: readonly string[],
): MessageMetadata | undefined {
  const role = row.role;
  if (role !== "user" && role !== "assistant" && role !== "tool") return undefined;
  const timestamp = Number(row.timestamp);
  if (!Number.isFinite(timestamp)) return undefined;

  const fallbackDate = new Date(timestamp);
  const storedDate = scalarText(row.date);
  if (!storedDate && Number.isNaN(fallbackDate.getTime())) return undefined;
  const sessionId = scalarText(row.session_id);
  if (sessionId === undefined) return undefined;

  return {
    source: "aei",
    sessionId,
    role,
    timestamp,
    date: storedDate || fallbackDate.toISOString().split("T")[0],
    context: contextFromRow(row, messageColumns, sessionColumns),
    channel: { platform: "cli", name: "aei" },
    author: authorFromRow(row, role),
  };
}

function nextBoundary(rows: readonly MessageRow[]): Boundary | undefined {
  const last = rows.at(-1);
  if (!last) return undefined;
  const timestamp = Number(last.timestamp);
  const id = Number(last.id);
  return Number.isFinite(timestamp) && Number.isFinite(id) ? { timestamp, id } : undefined;
}

export class AeiSource implements Source {
  name = "aei";
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(home(), ".config/aei/.cache/memory.db");
  }

  available(): boolean {
    return existsSync(this.dbPath);
  }

  async *read(): AsyncGenerator<Message> {
    const db = await openDatabase(this.dbPath);
    try {
      const messageInfo = await db.execute({ sql: "PRAGMA table_info(messages)", args: [] });
      const messageNames = columnNames(messageInfo.rows);
      const messageColumns = EXTRA_MSG_COLS.filter((column) => messageNames.has(column));

      const sessionInfo = await db.execute({ sql: "PRAGMA table_info(sessions)", args: [] });
      const sessionNames = columnNames(sessionInfo.rows);
      const sessionColumns = EXTRA_SESSION_COLS.filter((column) => sessionNames.has(column));
      const select = selectedColumns(messageColumns, sessionColumns);

      // The first page is unbounded so every SQLite int64 timestamp is eligible.
      let boundary: Boundary | undefined;
      while (true) {
        const query = queryBoundary(boundary);
        const rowsResult = await db.execute({
          sql: `
    SELECT ${select}
    FROM messages m
    JOIN sessions s ON m.session_id = s.id
    WHERE m.source = 'aei-cli'
      ${query.sql}
    ORDER BY m.timestamp, m.id
    LIMIT ?
    `,
          args: query.args,
        });
        const rows = rowsResult.rows as unknown as MessageRow[];
        if (rows.length === 0) break;

        const ids = rows.map((row) => Number(row.id));
        const blockResult = await db.execute({
          sql: `
      SELECT b.message_id, b.position, b.type, b.text, b.tool_name, b.tool_input, b.tool_call_id
      FROM blocks b
      WHERE b.message_id IN (${ids.map(() => "?").join(",")})
      ORDER BY b.message_id, b.position
    `,
          args: ids,
        });
        const blocks = groupBlocks(blockResult.rows as unknown as BlockRow[]);

        for (const row of rows) {
          const metadata = metadataFromRow(row, messageColumns, sessionColumns);
          if (!metadata) continue;
          const rowBlocks = blocks.get(Number(row.id));
          if (!rowBlocks?.length) continue;
          yield { ...metadata, blocks: rowBlocks };
        }

        boundary = nextBoundary(rows);
        if (!boundary || rows.length < WINDOW) break;
      }
    } finally {
      db.close();
    }
  }
}
