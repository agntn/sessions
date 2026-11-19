import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../core/db.ts";
import { home, osUser } from "../core/env.ts";
import type { Block, Channel, Message, Participant, Source } from "../core/types.ts";
import { isRecord, parseJson, scalarText } from "./parsing.ts";

function serialized(value: unknown): string {
  return JSON.stringify(value) ?? "";
}

function firstScalar(values: readonly unknown[]): string {
  for (const value of values) {
    const text = scalarText(value);
    if (text !== undefined) return text;
  }
  return "";
}

function parseToolInvocation(part: Readonly<Record<string, unknown>>): Block[] {
  const call = isRecord(part.toolInvocation) ? part.toolInvocation : part;
  const toolCallId = firstScalar([call.toolCallId, call.id]);
  const blocks: Block[] = [
    {
      type: "tool_call",
      toolName: firstScalar([call.toolName, call.name]),
      toolCallId,
      toolInput: typeof call.args === "string" ? call.args : serialized(call.args),
    },
  ];
  if (call.state === "result" && call.result !== undefined) {
    blocks.push({
      type: "tool_result",
      toolCallId,
      text: typeof call.result === "string" ? call.result : serialized(call.result),
    });
  }
  return blocks;
}

function parseTextPart(part: Readonly<Record<string, unknown>>): Block[] {
  return typeof part.text === "string" && part.text ? [{ type: "text", text: part.text }] : [];
}

function parseToolResult(part: Readonly<Record<string, unknown>>): Block[] {
  return [
    {
      type: "tool_result",
      toolCallId: scalarText(part.toolCallId) ?? "",
      text: typeof part.result === "string" ? part.result : serialized(part.result),
    },
  ];
}

function parsePart(part: unknown): Block[] {
  if (!isRecord(part)) return [];
  switch (part.type) {
    case "text":
      return parseTextPart(part);
    case "tool-invocation":
    case "tool-call":
      return parseToolInvocation(part);
    case "tool-result":
      return parseToolResult(part);
    default:
      return [];
  }
}

function parseFormatTwo(parts: readonly unknown[]): Block[] {
  return parts.flatMap(parsePart);
}

function parseContent(raw: string): Block[] {
  const fallback: Block[] = raw.length > 0 ? [{ type: "text", text: raw }] : [];
  try {
    const parsed = parseJson(raw);
    if (isRecord(parsed)) {
      if (parsed.format === 2 && Array.isArray(parsed.parts)) return parseFormatTwo(parsed.parts);
      if (typeof parsed.content === "string") return [{ type: "text", text: parsed.content }];
    }
    if (typeof parsed === "string") {
      return parsed.length > 0 ? [{ type: "text", text: parsed }] : [];
    }
  } catch {
    return fallback;
  }
  return fallback;
}

/**
 * Mastra Code keeps the project as `projectPath` in JSONB thread metadata.
 * @param value - `projectPath` read from `mastra_threads.metadata`.
 * @returns {Record<string, string>} `{ cwd }`, or nothing when the thread names none.
 */
function cwdOf(value: unknown): Record<string, string> {
  const cwd = scalarText(value);
  return cwd ? { cwd } : {};
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
    const db = await openDatabase(this.dbPath);
    try {
      const rowsResult = await db.execute({
        sql: `
  SELECT m.rowid as rowId, m.role, m.content, m.createdAt, m.thread_id,
    CASE WHEN json_valid(t.metadata, 10) THEN json_extract(t.metadata, '$.projectPath') END AS cwd
  FROM mastra_messages m
  LEFT JOIN mastra_threads t ON t.id = m.thread_id
  WHERE m.role IN ('user', 'assistant')
  ORDER BY m.createdAt, m.rowid
`,
        args: [],
      });
      const rows = rowsResult.rows as unknown as {
        rowId: number;
        role: string;
        content: string;
        createdAt: string;
        thread_id: string;
        cwd?: unknown;
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
          context: {
            mastraCreatedAt: row.createdAt,
            mastraRowId: String(row.rowId),
            ...cwdOf(row.cwd),
          },
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
