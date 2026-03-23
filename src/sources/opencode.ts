import { home, osUser } from "../core/env.ts";
import { createClient } from "@libsql/client";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Source, Message, Channel, Participant } from "../core/types.ts";

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

  async *ingest(cursor: string): AsyncGenerator<Message> {
    const parsedCursor = Number(cursor);
    const since = Number.isFinite(parsedCursor) ? parsedCursor : 0;
    const db = createClient({ url: `file:${resolve(this.dbPath)}` });
    try {
      const rowsResult = await db.execute({
        sql: `
        SELECT
          p.data as pdata,
          json_extract(m.data, '$.role') as role,
          p.time_created as tc,
          p.session_id as sid
        FROM part p
        JOIN message m ON p.message_id = m.id
        WHERE p.time_created > ?
        ORDER BY p.time_created
      `,
        args: [since],
      });
      const rows = rowsResult.rows as unknown as {
        pdata: string;
        role: string;
        tc: number;
        sid: string;
      }[];

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
                    ? part.args
                    : typeof part.input === "string"
                      ? part.input
                      : JSON.stringify(part.args || part.input || ""),
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
    } finally {
      db.close();
    }
  }

  cursor(message: Message): string {
    return String(message.timestamp);
  }
}
