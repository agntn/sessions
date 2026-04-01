import { home, osUser } from "../core/env.ts";
import { createClient } from "@libsql/client";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Source, Message, Block, Channel, Participant } from "../core/types.ts";

function parseContent(raw: string): Block[] {
  const fallback = raw.length > 0 ? [{ type: "text", text: raw.slice(0, 8000) }] : [];
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.format === 2 && Array.isArray(parsed.parts)) {
      const out: Block[] = [];
      for (const p of parsed.parts) {
        if (p.type === "text" && p.text) {
          out.push({ type: "text", text: String(p.text).slice(0, 8000) });
        } else if (p.type === "tool-invocation" || p.type === "tool-call") {
          out.push({
            type: "tool_call",
            toolName: String(p.toolName || p.name || ""),
            toolCallId: String(p.toolCallId || p.id || ""),
            toolInput: typeof p.args === "string" ? p.args : JSON.stringify(p.args),
          });
        } else if (p.type === "tool-result") {
          out.push({
            type: "tool_result",
            toolCallId: String(p.toolCallId || ""),
            text:
              typeof p.result === "string"
                ? p.result.slice(0, 8000)
                : JSON.stringify(p.result).slice(0, 8000),
          });
        }
      }
      return out;
    }
    if (typeof parsed?.content === "string") {
      return [{ type: "text", text: parsed.content.slice(0, 8000) }];
    }
    if (typeof parsed === "string") {
      return parsed.length > 0 ? [{ type: "text", text: parsed.slice(0, 8000) }] : [];
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function parseCursor(cursor: string): { createdAt: string; rowId: number } {
  if (!cursor) return { createdAt: "1970-01-01", rowId: 0 };
  const [createdAt, rowIdRaw] = cursor.split("|");
  const rowId = Number(rowIdRaw || "0");
  const parsedCreatedAt = Date.parse(createdAt || "");
  return {
    createdAt: Number.isFinite(parsedCreatedAt) ? (createdAt as string) : "1970-01-01",
    rowId: Number.isFinite(rowId) && rowId > 0 ? rowId : 0,
  };
}

export class MastraSource implements Source {
  name = "mastra";
  private dbPath: string;
  private channel: Channel = { platform: "cli", name: "mastra" };
  private user: Participant;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(home(), ".local/share/mastracode/mastra.db");
    this.user = { platform: "cli", name: osUser() };
  }

  available(): boolean {
    return existsSync(this.dbPath);
  }

  async estimate(cursor: string): Promise<number> {
    const { createdAt, rowId } = parseCursor(cursor);
    const db = createClient({ url: `file:${resolve(this.dbPath)}` });
    try {
      const r = await db.execute({
        sql: `SELECT COUNT(*) as c FROM mastra_messages
              WHERE role IN ('user', 'assistant')
                AND (createdAt > ? OR (createdAt = ? AND rowid > ?))`,
        args: [createdAt, createdAt, rowId],
      });
      return Number(r.rows[0].c);
    } finally {
      db.close();
    }
  }

  watchPaths(): string[] {
    return [dirname(this.dbPath)];
  }

  async *ingest(cursor: string): AsyncGenerator<Message> {
    const parsedCursor = parseCursor(cursor);
    const db = createClient({ url: `file:${resolve(this.dbPath)}` });
    try {
      const rowsResult = await db.execute({
        sql: `
        SELECT rowid as rowId, role, content, createdAt, thread_id
        FROM mastra_messages
        WHERE role IN ('user', 'assistant')
          AND (createdAt > ? OR (createdAt = ? AND rowid > ?))
        ORDER BY createdAt, rowid
      `,
        args: [parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.rowId],
      });
      const rows = rowsResult.rows as unknown as {
        rowId: number;
        role: string;
        content: string;
        createdAt: string;
        thread_id: string;
      }[];

      for (const row of rows) {
        const entryBlocks = parseContent(row.content);
        if (!entryBlocks.length) continue;

        const date = row.createdAt?.split("T")[0];
        if (!date) continue;

        const ts = new Date(row.createdAt).getTime();
        if (!Number.isFinite(ts)) continue;

        yield {
          source: this.name,
          sessionId: row.thread_id,
          role: row.role as "user" | "assistant",
          timestamp: ts,
          date,
          blocks: entryBlocks,
          context: { mastraCreatedAt: row.createdAt, mastraRowId: String(row.rowId) },
          channel: this.channel,
          author:
            row.role === "user" ? this.user : { platform: "cli", name: "mastra", isBot: true },
        };
      }
    } finally {
      db.close();
    }
  }

  cursor(message: Message): string {
    const createdAt = message.context?.mastraCreatedAt;
    const rowId = message.context?.mastraRowId;
    if (createdAt && rowId) return `${createdAt}|${rowId}`;
    return `${new Date(message.timestamp).toISOString()}|0`;
  }
}
