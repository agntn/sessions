import { home } from "../core/env.ts";
import { createClient } from "@libsql/client";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Source, Message, Block, Channel } from "../core/types.ts";

// Small window: many wide text columns per row (~16 KB each after substr)
const WINDOW = 100;

export class ClaudeMemSource implements Source {
  name = "claude-mem";
  private dbPath: string;
  private channel: Channel = { platform: "cli", name: "claude-mem" };

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(home(), ".claude-mem/claude-mem.db");
  }

  available(): boolean {
    return existsSync(this.dbPath);
  }

  watchPaths(): string[] {
    return [dirname(this.dbPath)];
  }

  async estimate(cursor: string): Promise<number> {
    const parsed = Number(cursor);
    const since = Number.isFinite(parsed) ? parsed : 0;
    const db = createClient({ url: `file:${resolve(this.dbPath)}` });
    try {
      const obs = await db.execute({
        sql: "SELECT COUNT(*) as c FROM observations WHERE created_at_epoch > ?",
        args: [since],
      });
      const sum = await db.execute({
        sql: "SELECT COUNT(*) as c FROM session_summaries WHERE created_at_epoch > ?",
        args: [since],
      });
      return Number(obs.rows[0].c) + Number(sum.rows[0].c);
    } finally {
      db.close();
    }
  }

  async *ingest(cursor: string): AsyncGenerator<Message> {
    const parsedCursor = Number(cursor);
    const since = Number.isFinite(parsedCursor) ? parsedCursor : 0;
    const db = createClient({ url: `file:${resolve(this.dbPath)}` });

    try {
      // Observations — windowed
      let obsOffset = 0;
      while (true) {
        const obsResult = await db.execute({
          sql: `
          SELECT
            o.id, o.memory_session_id, o.project,
            substr(o.text, 1, 4000) as text, o.type,
            substr(o.title, 1, 500) as title,
            substr(o.subtitle, 1, 1000) as subtitle,
            substr(o.narrative, 1, 4000) as narrative,
            substr(o.facts, 1, 2000) as facts,
            substr(o.concepts, 1, 500) as concepts,
            substr(o.files_read, 1, 500) as files_read,
            substr(o.files_modified, 1, 500) as files_modified,
            o.created_at_epoch
          FROM observations o
          WHERE o.created_at_epoch > ?
          ORDER BY o.created_at_epoch
          LIMIT ? OFFSET ?
          `,
          args: [since, WINDOW, obsOffset],
        });
        const obsRows = obsResult.rows as unknown as Array<{
          id: number;
          memory_session_id: string;
          project: string | null;
          text: string | null;
          type: string | null;
          title: string | null;
          subtitle: string | null;
          narrative: string | null;
          facts: string | null;
          concepts: string | null;
          files_read: string | null;
          files_modified: string | null;
          created_at_epoch: number;
        }>;

        if (!obsRows.length) break;

        for (const row of obsRows) {
          const blocks: Block[] = [];

          if (row.title) blocks.push({ type: "title", text: row.title });
          if (row.subtitle) blocks.push({ type: "subtitle", text: row.subtitle });
          if (row.narrative) blocks.push({ type: "narrative", text: row.narrative });
          if (row.text) blocks.push({ type: "text", text: row.text });
          if (row.facts) blocks.push({ type: "facts", text: row.facts });
          if (row.concepts) blocks.push({ type: "concepts", text: row.concepts });
          if (!blocks.length) continue;

          const ts = Number(row.created_at_epoch);
          if (!Number.isFinite(ts)) continue;

          const context: Record<string, string> = { observationType: row.type || "observation" };
          if (row.project) context.project = row.project;
          if (row.files_read) context.filesRead = row.files_read;
          if (row.files_modified) context.filesModified = row.files_modified;

          yield {
            source: this.name,
            sessionId: row.memory_session_id,
            role: "assistant",
            timestamp: ts,
            date: new Date(ts).toISOString().split("T")[0],
            blocks,
            context,
            channel: this.channel,
            author: { platform: "cli", name: "claude-mem", isBot: true },
          };
        }

        if (obsRows.length < WINDOW) break;
        obsOffset += WINDOW;
      }

      // Session summaries — windowed
      let sumOffset = 0;
      while (true) {
        const sumResult = await db.execute({
          sql: `
          SELECT
            s.id, s.memory_session_id, s.project,
            substr(s.request, 1, 2000) as request,
            substr(s.investigated, 1, 2000) as investigated,
            substr(s.learned, 1, 2000) as learned,
            substr(s.completed, 1, 2000) as completed,
            substr(s.next_steps, 1, 2000) as next_steps,
            substr(s.files_read, 1, 500) as files_read,
            substr(s.files_edited, 1, 500) as files_edited,
            substr(s.notes, 1, 2000) as notes,
            s.created_at_epoch
          FROM session_summaries s
          WHERE s.created_at_epoch > ?
          ORDER BY s.created_at_epoch
          LIMIT ? OFFSET ?
          `,
          args: [since, WINDOW, sumOffset],
        });
        const sumRows = sumResult.rows as unknown as Array<{
          id: number;
          memory_session_id: string;
          project: string | null;
          request: string | null;
          investigated: string | null;
          learned: string | null;
          completed: string | null;
          next_steps: string | null;
          files_read: string | null;
          files_edited: string | null;
          notes: string | null;
          created_at_epoch: number;
        }>;

        if (!sumRows.length) break;

        for (const row of sumRows) {
          const blocks: Block[] = [];

          if (row.request) blocks.push({ type: "request", text: row.request });
          if (row.investigated) blocks.push({ type: "investigated", text: row.investigated });
          if (row.learned) blocks.push({ type: "learned", text: row.learned });
          if (row.completed) blocks.push({ type: "completed", text: row.completed });
          if (row.next_steps) blocks.push({ type: "next_steps", text: row.next_steps });
          if (row.notes) blocks.push({ type: "notes", text: row.notes });
          if (!blocks.length) continue;

          const ts = Number(row.created_at_epoch);
          if (!Number.isFinite(ts)) continue;

          const context: Record<string, string> = { observationType: "summary" };
          if (row.project) context.project = row.project;
          if (row.files_read) context.filesRead = row.files_read;
          if (row.files_edited) context.filesEdited = row.files_edited;

          yield {
            source: this.name,
            sessionId: row.memory_session_id,
            role: "assistant",
            timestamp: ts,
            date: new Date(ts).toISOString().split("T")[0],
            blocks,
            context,
            channel: { ...this.channel, type: "summary" },
            author: { platform: "cli", name: "claude-mem", isBot: true },
          };
        }

        if (sumRows.length < WINDOW) break;
        sumOffset += WINDOW;
      }
    } finally {
      db.close();
    }
  }

  cursor(message: Message): string {
    return String(message.timestamp);
  }
}
