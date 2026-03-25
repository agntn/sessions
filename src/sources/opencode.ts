import { home, osUser } from "../core/env.ts";
import { createClient } from "@libsql/client";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Source, Message, Channel, Participant } from "../core/types.ts";

// Large window: single JSON column truncated to 16 KB via substr
const WINDOW = 5000;

export class OpenCodeSource implements Source {
  name = "opencode";
  private dbPath: string;
  private channel: Channel = { platform: "cli", name: "opencode" };
  private user: Participant;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(home(), ".local/share/opencode/opencode.db");
    this.user = { platform: "cli", name: osUser() };
  }

  available(): boolean {
    return existsSync(this.dbPath);
  }

  async estimate(cursor: string): Promise<number> {
    const parsed = Number(cursor);
    const since = Number.isFinite(parsed) ? parsed : 0;
    const db = createClient({ url: `file:${resolve(this.dbPath)}` });
    try {
      const r = await db.execute({
        sql: `SELECT COUNT(*) as cnt FROM part p JOIN message m ON p.message_id = m.id WHERE p.time_created > ?`,
        args: [since],
      });
      return Number((r.rows[0] as unknown as { cnt: number }).cnt);
    } finally {
      db.close();
    }
  }

  async *ingest(cursor: string): AsyncGenerator<Message> {
    const parsedCursor = Number(cursor);
    const since = Number.isFinite(parsedCursor) ? parsedCursor : 0;
    const db = createClient({ url: `file:${resolve(this.dbPath)}` });
    try {
      let lastTc = since;
      let lastRowid = 0;
      while (true) {
        const rowsResult = await db.execute({
          sql: `
          SELECT
            substr(p.data, 1, 16000) as pdata,
            json_extract(m.data, '$.role') as role,
            p.time_created as tc,
            p.session_id as sid,
            p.rowid as rid
          FROM part p
          JOIN message m ON p.message_id = m.id
          WHERE (p.time_created > ? OR (p.time_created = ? AND p.rowid > ?))
          ORDER BY p.time_created, p.rowid
          LIMIT ?
        `,
          args: [lastTc, lastTc, lastRowid, WINDOW],
        });
        const rows = rowsResult.rows as unknown as {
          pdata: string;
          role: string;
          tc: number;
          sid: string;
          rid: number;
        }[];

        if (rows.length === 0) break;
        const last = rows[rows.length - 1];
        lastTc = last.tc;
        lastRowid = last.rid;

      for (const row of rows) {
        if (row.role !== "user" && row.role !== "assistant") continue;

        const ts = Number(row.tc);
        if (!Number.isFinite(ts)) continue;
        const dateValue = new Date(ts);
        if (Number.isNaN(dateValue.getTime())) continue;
        const date = dateValue.toISOString().split("T")[0];

        let part: Record<string, unknown>;
        try {
          part = JSON.parse(row.pdata);
        } catch {
          continue;
        }

        const ptype = String(part.type || "");
        if (ptype === "text") {
          const text = String(part.text || "");
          if (text.length === 0) continue;

          const author =
            row.role === "user"
              ? this.user
              : ({ platform: "cli", name: "opencode", isBot: true } as Participant);
          yield {
            source: this.name,
            sessionId: row.sid,
            role: row.role as "user" | "assistant",
            timestamp: ts,
            date,
            blocks: [{ type: "text", text: text.slice(0, 8000) }],
            channel: this.channel,
            author,
          };
        } else if (ptype === "tool-invocation" || ptype === "tool-call") {
          yield {
            source: this.name,
            sessionId: row.sid,
            role: row.role as "user" | "assistant",
            timestamp: ts,
            date,
            blocks: [
              {
                type: "tool_call",
                toolName: String(part.toolName || part.name || ""),
                toolCallId: String(part.toolCallId || part.id || ""),
                toolInput:
                  typeof part.args === "string"
                    ? part.args.slice(0, 8000)
                    : typeof part.input === "string"
                      ? part.input.slice(0, 8000)
                      : JSON.stringify(part.args || part.input || "").slice(0, 8000),
              },
            ],
            channel: this.channel,
            author: { platform: "cli", name: "opencode", isBot: true },
          };
        } else if (ptype === "tool-result") {
          yield {
            source: this.name,
            sessionId: row.sid,
            role: "tool",
            timestamp: ts,
            date,
            blocks: [
              {
                type: "tool_result",
                toolCallId: String(part.toolCallId || ""),
                text:
                  typeof part.result === "string"
                    ? part.result.slice(0, 8000)
                    : JSON.stringify(part.result || "").slice(0, 8000),
              },
            ],
            channel: this.channel,
            author: { platform: "cli", name: "opencode", isBot: true },
          };
        }
      }
      }
    } finally {
      db.close();
    }
  }

  cursor(message: Message): string {
    return String(message.timestamp);
  }
}
