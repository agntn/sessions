import { home } from "../core/env.ts";
import { createClient } from "@libsql/client";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Source, Message, Block, Channel } from "../core/types.ts";

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

  async *ingest(cursor: string): AsyncGenerator<Message> {
    const parsedCursor = Number(cursor);
    const since = Number.isFinite(parsedCursor) ? parsedCursor : 0;
    const db = createClient({ url: `file:${resolve(this.dbPath)}` });

    try {
      // Observations
      const obsResult = await db.execute({
        sql: `
        SELECT
          o.id, o.memory_session_id, o.project, o.text, o.type,
          o.title, o.subtitle, o.narrative, o.facts, o.concepts,
          o.files_read, o.files_modified, o.created_at_epoch
        FROM observations o
        WHERE o.created_at_epoch > ?
        ORDER BY o.created_at_epoch
        `,
        args: [since],
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

      for (const row of obsRows) {
        const blocks: Block[] = [];

        if (row.title) blocks.push({ type: "title", text: row.title.slice(0, 500) });
        if (row.subtitle) blocks.push({ type: "subtitle", text: row.subtitle.slice(0, 1000) });
        if (row.narrative) blocks.push({ type: "narrative", text: row.narrative.slice(0, 4000) });
        if (row.text) blocks.push({ type: "text", text: row.text.slice(0, 4000) });
        if (row.facts) blocks.push({ type: "facts", text: row.facts.slice(0, 2000) });
        if (row.concepts) blocks.push({ type: "concepts", text: row.concepts.slice(0, 500) });
        if (!blocks.length) continue;

        const ts = Number(row.created_at_epoch);
        if (!Number.isFinite(ts)) continue;

        const context: Record<string, string> = { observationType: row.type || "observation" };
        if (row.project) context.project = row.project;
        if (row.files_read) context.filesRead = row.files_read.slice(0, 500);
        if (row.files_modified) context.filesModified = row.files_modified.slice(0, 500);

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

      // Session summaries
      const sumResult = await db.execute({
        sql: `
        SELECT
          s.id, s.memory_session_id, s.project,
          s.request, s.investigated, s.learned, s.completed, s.next_steps,
          s.files_read, s.files_edited, s.notes, s.created_at_epoch
        FROM session_summaries s
        WHERE s.created_at_epoch > ?
        ORDER BY s.created_at_epoch
        `,
        args: [since],
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

      for (const row of sumRows) {
        const blocks: Block[] = [];

        if (row.request) blocks.push({ type: "request", text: row.request.slice(0, 2000) });
        if (row.investigated) blocks.push({ type: "investigated", text: row.investigated.slice(0, 2000) });
        if (row.learned) blocks.push({ type: "learned", text: row.learned.slice(0, 2000) });
        if (row.completed) blocks.push({ type: "completed", text: row.completed.slice(0, 2000) });
        if (row.next_steps) blocks.push({ type: "next_steps", text: row.next_steps.slice(0, 2000) });
        if (row.notes) blocks.push({ type: "notes", text: row.notes.slice(0, 2000) });
        if (!blocks.length) continue;

        const ts = Number(row.created_at_epoch);
        if (!Number.isFinite(ts)) continue;

        const context: Record<string, string> = { observationType: "summary" };
        if (row.project) context.project = row.project;
        if (row.files_read) context.filesRead = row.files_read.slice(0, 500);
        if (row.files_edited) context.filesEdited = row.files_edited.slice(0, 500);

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
    } finally {
      db.close();
    }
  }

  cursor(message: Message): string {
    return String(message.timestamp);
  }
}
