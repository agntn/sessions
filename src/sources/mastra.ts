import { home, osUser } from "../core/env.ts";
import { createClient } from "@libsql/client";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Source, Message, Block, Channel, Participant } from "../core/types.ts";

function parseContent(raw: string): Block[] {
  const fallback = raw.length > 0 ? [{ type: "text", text: raw }] : [];
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.format === 2 && Array.isArray(parsed.parts)) {
      const out: Block[] = [];
      for (const p of parsed.parts) {
        if (p.type === "text" && p.text) {
          out.push({ type: "text", text: String(p.text) });
        } else if (p.type === "tool-invocation" || p.type === "tool-call") {
          // Mastra stores AI SDK parts: the call fields live under
          // `toolInvocation`, and a finished call carries its result there too
          // instead of emitting a separate `tool-result` part.
          const call = p.toolInvocation ?? p;
          const toolCallId = String(call.toolCallId || call.id || "");
          out.push({
            type: "tool_call",
            toolName: String(call.toolName || call.name || ""),
            toolCallId,
            toolInput: typeof call.args === "string" ? call.args : JSON.stringify(call.args),
          });
          if (call.state === "result" && call.result !== undefined) {
            out.push({
              type: "tool_result",
              toolCallId,
              text: typeof call.result === "string" ? call.result : JSON.stringify(call.result),
            });
          }
        } else if (p.type === "tool-result") {
          out.push({
            type: "tool_result",
            toolCallId: String(p.toolCallId || ""),
            text: typeof p.result === "string" ? p.result : JSON.stringify(p.result),
          });
        }
      }
      return out;
    }
    if (typeof parsed?.content === "string") {
      return [{ type: "text", text: parsed.content }];
    }
    if (typeof parsed === "string") {
      return parsed.length > 0 ? [{ type: "text", text: parsed }] : [];
    }
  } catch {
    return fallback;
  }
  return fallback;
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
  async *read(): AsyncGenerator<Message> {
    const db = createClient({ url: `file:${resolve(this.dbPath)}` });
    try {
      const rowsResult = await db.execute({
        sql: `
  SELECT rowid as rowId, role, content, createdAt, thread_id
  FROM mastra_messages
  WHERE role IN ('user', 'assistant')
  ORDER BY createdAt, rowid
`,
        args: [],
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
}
