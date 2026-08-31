import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../core/db.ts";
import { home, osUser } from "../core/env.ts";
import type { Block, Channel, Message, Participant, Source } from "../core/types.ts";
import { parseJsonRecord, scalarText } from "./parsing.ts";

// Large window keeps keyset pagination bounded without truncating native payloads.
const WINDOW = 5000;

interface Boundary {
  readonly timestamp: number;
  readonly rowId: number;
}

interface PartRow {
  readonly pdata: string;
  readonly role: string;
  readonly tc: number;
  readonly sid: string;
  readonly rid: number;
}

interface ParsedPart {
  readonly role?: Message["role"];
  readonly blocks: Block[];
  readonly botAuthor: boolean;
}

function textPart(part: Readonly<Record<string, unknown>>): ParsedPart | undefined {
  const text = scalarText(part.text) ?? "";
  return text ? { blocks: [{ type: "text", text }], botAuthor: false } : undefined;
}

function toolInput(part: Readonly<Record<string, unknown>>): string {
  if (typeof part.args === "string") return part.args;
  if (typeof part.input === "string") return part.input;
  return JSON.stringify(part.args ?? part.input ?? "") ?? "";
}

function toolCallPart(part: Readonly<Record<string, unknown>>): ParsedPart {
  return {
    blocks: [
      {
        type: "tool_call",
        toolName: scalarText(part.toolName) ?? scalarText(part.name) ?? "",
        toolCallId: scalarText(part.toolCallId) ?? scalarText(part.id) ?? "",
        toolInput: toolInput(part),
      },
    ],
    botAuthor: true,
  };
}

function toolResultPart(part: Readonly<Record<string, unknown>>): ParsedPart {
  return {
    role: "tool",
    blocks: [
      {
        type: "tool_result",
        toolCallId: scalarText(part.toolCallId) ?? "",
        text:
          typeof part.result === "string" ? part.result : (JSON.stringify(part.result ?? "") ?? ""),
      },
    ],
    botAuthor: true,
  };
}

function parsePart(raw: string): ParsedPart | undefined {
  const part = parseJsonRecord(raw);
  if (!part) return undefined;
  switch (part.type) {
    case "text":
      return textPart(part);
    case "tool-invocation":
    case "tool-call":
      return toolCallPart(part);
    case "tool-result":
      return toolResultPart(part);
    default:
      return undefined;
  }
}

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

  private messageFromRow(row: PartRow): Message | undefined {
    if (row.role !== "user" && row.role !== "assistant") return undefined;
    const timestamp = Number(row.tc);
    if (!Number.isFinite(timestamp)) return undefined;
    const dateValue = new Date(timestamp);
    if (Number.isNaN(dateValue.getTime())) return undefined;
    const part = parsePart(row.pdata);
    if (!part) return undefined;

    const role = part.role ?? row.role;
    const author =
      !part.botAuthor && role === "user"
        ? this.user
        : { platform: "cli", name: "opencode", isBot: true };
    return {
      source: this.name,
      sessionId: row.sid,
      role,
      timestamp,
      date: dateValue.toISOString().split("T")[0],
      blocks: part.blocks,
      channel: this.channel,
      author,
    };
  }

  async *read(): AsyncGenerator<Message> {
    const db = await openDatabase(this.dbPath);
    try {
      let boundary: Boundary | undefined;
      while (true) {
        const boundarySql = boundary
          ? "WHERE (p.time_created > ? OR (p.time_created = ? AND p.rowid > ?))"
          : "";
        const rowsResult = await db.execute({
          sql: `
    SELECT
      p.data as pdata,
      json_extract(m.data, '$.role') as role,
      p.time_created as tc,
      p.session_id as sid,
      p.rowid as rid
    FROM part p
    JOIN message m ON p.message_id = m.id
    ${boundarySql}
    ORDER BY p.time_created, p.rowid
    LIMIT ?
  `,
          args: boundary
            ? [boundary.timestamp, boundary.timestamp, boundary.rowId, WINDOW]
            : [WINDOW],
        });
        const rows = rowsResult.rows as unknown as PartRow[];
        if (rows.length === 0) break;

        const last = rows.at(-1);
        if (!last) break;
        boundary = { timestamp: last.tc, rowId: last.rid };

        for (const row of rows) {
          const message = this.messageFromRow(row);
          if (message) yield message;
        }
      }
    } finally {
      db.close();
    }
  }
}
