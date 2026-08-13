import { home, osUser } from "../core/env.ts";
import { createClient } from "@libsql/client";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Source, Message, Block, Channel, Participant } from "../core/types.ts";

// Medium window: rows are narrow, blocks fetched in separate query
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
    const db = createClient({ url: `file:${resolve(this.dbPath)}` });

    try {
      // Discover available columns to handle schema evolution
      const msgInfo = await db.execute({ sql: "PRAGMA table_info(messages)", args: [] });
      const msgCols = new Set(msgInfo.rows.map((r) => String(r.name)));
      const availableExtra = EXTRA_MSG_COLS.filter((c) => msgCols.has(c));

      const sesInfo = await db.execute({ sql: "PRAGMA table_info(sessions)", args: [] });
      const sesCols = new Set(sesInfo.rows.map((r) => String(r.name)));
      const availableSession = EXTRA_SESSION_COLS.filter((c) => sesCols.has(c));

      const selectCols = [
        ...BASE_COLS.map((c) => `m.${c}`),
        ...availableExtra.map((c) => `m.${c}`),
        ...availableSession.map((c) => `s.${c}`),
      ].join(", ");

      // The first page is unbounded so every SQLite int64 timestamp is eligible.
      let boundary: { timestamp: number; id: number } | undefined;
      while (true) {
        const boundarySql = boundary
          ? "AND (m.timestamp > ? OR (m.timestamp = ? AND m.id > ?))"
          : "";
        const rowsResult = await db.execute({
          sql: `
    SELECT ${selectCols}
    FROM messages m
    JOIN sessions s ON m.session_id = s.id
    WHERE m.source = 'aei-cli'
      ${boundarySql}
    ORDER BY m.timestamp, m.id
    LIMIT ?
    `,
          args: boundary ? [boundary.timestamp, boundary.timestamp, boundary.id, WINDOW] : [WINDOW],
        });
        const rows = rowsResult.rows as unknown as Record<string, unknown>[];

        if (!rows.length) break;

        const ids = rows.map((r) => r.id as number);
        const placeholders = ids.map(() => "?").join(",");

        const blockResult = await db.execute({
          sql: `
      SELECT b.message_id, b.position, b.type, b.text, b.tool_name, b.tool_input, b.tool_call_id
      FROM blocks b
      WHERE b.message_id IN (${placeholders})
      ORDER BY b.message_id, b.position
    `,
          args: ids,
        });
        const blockRows = blockResult.rows as unknown as Array<{
          message_id: number;
          position: number;
          type: string;
          text: string | null;
          tool_name: string | null;
          tool_input: string | null;
          tool_call_id: string | null;
        }>;

        const blocksByMessage = new Map<number, Block[]>();
        for (const b of blockRows) {
          const block: Block = { type: b.type as Block["type"] };
          if (b.text) block.text = b.text;
          if (b.tool_name) block.toolName = b.tool_name;
          if (b.tool_input) block.toolInput = b.tool_input;
          if (b.tool_call_id) block.toolCallId = b.tool_call_id;
          let arr = blocksByMessage.get(b.message_id);
          if (!arr) {
            arr = [];
            blocksByMessage.set(b.message_id, arr);
          }
          arr.push(block);
        }

        for (const row of rows) {
          const role = row.role as string;
          if (role !== "user" && role !== "assistant" && role !== "tool") continue;

          const ts = Number(row.timestamp);
          if (!Number.isFinite(ts)) continue;
          const fallbackDateValue = new Date(ts);
          const dateStr = row.date as string | null;
          if (!dateStr && Number.isNaN(fallbackDateValue.getTime())) continue;
          const date = dateStr || fallbackDateValue.toISOString().split("T")[0];

          const blocks = blocksByMessage.get(row.id as number) ?? [];
          if (!blocks.length) continue;

          const context: Record<string, string> = { aeiMsgId: String(row.id) };
          for (const col of availableExtra) {
            const val = row[col];
            if (val !== null && val !== undefined) {
              context[col] = String(val);
            }
          }
          for (const col of availableSession) {
            const val = row[col];
            if (val !== null && val !== undefined) context[col] = String(val);
          }

          const channel: Channel = { platform: "cli", name: "aei" };
          let author: Participant;
          if (role === "user") {
            const name = (row.sender_id as string) || (row.os_user as string) || osUser();
            author = {
              platform: "cli",
              name,
              platformId: (row.initiator_id as string) ?? undefined,
            };
          } else {
            author = { platform: "cli", name: (row.sender_id as string) || "aei", isBot: true };
          }

          yield {
            source: this.name,
            sessionId: row.session_id as string,
            role: role as "user" | "assistant" | "tool",
            timestamp: ts,
            date,
            blocks,
            context: Object.keys(context).length ? context : undefined,
            channel,
            author,
          };
        }

        const lastRow = rows[rows.length - 1];
        const nextTs = Number(lastRow.timestamp);
        const nextId = Number(lastRow.id);
        if (!Number.isFinite(nextTs) || !Number.isFinite(nextId)) break;
        boundary = { timestamp: nextTs, id: nextId };
        if (rows.length < WINDOW) break;
      }
    } finally {
      db.close();
    }
  }
}
