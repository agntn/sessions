import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../core/db.ts";
import { home, osUser } from "../core/env.ts";
import { INJECTED_PREFIXES } from "../tool-snippet.ts";
import type {
  Block,
  Channel,
  Message,
  Participant,
  Source,
  SourceReadOptions,
  SourceSummaryWindow,
  SessionTimeRange,
} from "../core/types.ts";
import { isRecord, parseJsonRecord, scalarText } from "./parsing.ts";

// Large window keeps keyset pagination bounded without truncating native payloads.
const WINDOW = 5000;
const SNIPPET_FILTER_SQL = INJECTED_PREFIXES.map(
  () => "AND ltrim(candidate.textValue, char(9) || char(10) || char(13) || ' ') NOT GLOB ?",
).join("\n");
const SNIPPET_FILTER_ARGS = INJECTED_PREFIXES.map((prefix) => `${prefix}*`);

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

interface SummaryRow {
  readonly sid: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
  readonly messageCount: unknown;
  readonly snippetText: unknown;
  readonly total: unknown;
}

function textPart(part: Readonly<Record<string, unknown>>): ParsedPart | undefined {
  const text = scalarText(part.text) ?? "";
  return text ? { blocks: [{ type: "text", text }], botAuthor: false } : undefined;
}

function reasoningPart(part: Readonly<Record<string, unknown>>): ParsedPart | undefined {
  const text = scalarText(part.text) ?? "";
  return text ? { blocks: [{ type: "thinking", text }], botAuthor: false } : undefined;
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

function currentToolResult(
  state: Readonly<Record<string, unknown>>,
  toolCallId: string,
): Block | undefined {
  if (state.status === "completed" && state.output !== undefined) {
    return {
      type: "tool_result",
      toolCallId,
      text: typeof state.output === "string" ? state.output : (JSON.stringify(state.output) ?? ""),
      isError: false,
    };
  }
  if (state.status === "error" && state.error !== undefined) {
    return {
      type: "tool_result",
      toolCallId,
      text: typeof state.error === "string" ? state.error : (JSON.stringify(state.error) ?? ""),
      isError: true,
    };
  }
  return undefined;
}

function currentToolPart(part: Readonly<Record<string, unknown>>): ParsedPart {
  const state = isRecord(part.state) ? part.state : {};
  const toolCallId = scalarText(part.callID) ?? scalarText(part.callId) ?? "";
  const blocks: Block[] = [
    {
      type: "tool_call",
      toolName: scalarText(part.tool) ?? "",
      toolCallId,
      toolInput: toolInput(state),
    },
  ];
  const result = currentToolResult(state, toolCallId);
  if (result) blocks.push(result);
  return { blocks, botAuthor: true };
}

function parsePart(raw: string): ParsedPart | undefined {
  const part = parseJsonRecord(raw);
  if (!part) return undefined;
  switch (part.type) {
    case "text":
      return textPart(part);
    case "reasoning":
      return reasoningPart(part);
    case "tool-invocation":
    case "tool-call":
      return toolCallPart(part);
    case "tool":
      return currentToolPart(part);
    case "tool-result":
      return toolResultPart(part);
    default:
      return undefined;
  }
}

function partPage(
  options: Readonly<SourceReadOptions> | undefined,
  boundary: Readonly<Boundary> | undefined,
): { readonly whereSql: string; readonly args: Array<string | number> } {
  const predicates: string[] = [];
  const args: Array<string | number> = [];
  if (options?.sessionId) {
    predicates.push("p.session_id = ?");
    args.push(options.sessionId);
  }
  if (boundary) {
    predicates.push("(p.time_created > ? OR (p.time_created = ? AND p.rowid > ?))");
    args.push(boundary.timestamp, boundary.timestamp, boundary.rowId);
  }
  args.push(WINDOW);
  return {
    whereSql: predicates.length ? `WHERE ${predicates.join(" AND ")}` : "",
    args,
  };
}

/**
 * Narrows a bounded listing to sessions with a part created at or after `since`. The raw part
 * clock bounds the summary clock, which keeps only a subset of those parts, and one sequential
 * pass over it leaves every part body unparsed.
 * @param since - Inclusive lower bound on last activity, or no narrowing when omitted.
 * @returns {{ sql: string, args: number[] }} The predicate joined to the part scan and its argument.
 */
function reachedSessions(since: number | undefined): {
  readonly sql: string;
  readonly args: number[];
} {
  if (since === undefined) return { sql: "", args: [] };
  return {
    sql: "AND p.session_id IN (SELECT session_id FROM part WHERE time_created >= ?)",
    args: [since],
  };
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

  async summaryWindow(
    offset: number,
    limit: number,
    range?: SessionTimeRange,
  ): Promise<SourceSummaryWindow> {
    const reached = reachedSessions(range?.since);
    const db = await openDatabase(this.dbPath);
    try {
      const result = await db.execute({
        sql: `
          WITH parsed AS (
            SELECT
              p.session_id AS sid,
              p.time_created AS timestamp,
              p.rowid AS rowId,
              CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') END AS role,
              CASE WHEN json_valid(p.data) THEN json_extract(p.data, '$.type') END AS partType,
              CASE
                WHEN json_valid(p.data) AND json_type(p.data, '$.text') = 'true' THEN 'true'
                WHEN json_valid(p.data) AND json_type(p.data, '$.text') = 'false' THEN 'false'
                WHEN json_valid(p.data) AND json_type(p.data, '$.text') IN ('text', 'integer', 'real')
                  THEN CAST(json_extract(p.data, '$.text') AS TEXT)
              END AS textValue
            FROM part p
            JOIN message m ON p.message_id = m.id
            WHERE p.time_created BETWEEN -8640000000000000 AND 8640000000000000
              ${reached.sql}
          ),
          summaries AS (
            SELECT
              sid,
              MIN(timestamp) AS createdAt,
              MAX(timestamp) AS updatedAt,
              COUNT(*) AS messageCount
            FROM parsed
            WHERE role IN ('user', 'assistant')
              AND (
                partType IN ('tool-invocation', 'tool-call', 'tool-result', 'tool')
                OR (partType IN ('text', 'reasoning') AND COALESCE(textValue, '') <> '')
              )
            GROUP BY sid
            HAVING MAX(timestamp) >= ? AND MAX(timestamp) <= ?
          ),
          paged AS (
            SELECT *
            FROM summaries
            ORDER BY updatedAt DESC, sid ASC
            LIMIT ? OFFSET ?
          ),
          totals AS (SELECT COUNT(*) AS total FROM summaries)
          SELECT
            paged.sid,
            paged.createdAt,
            paged.updatedAt,
            paged.messageCount,
            (
              SELECT substr(candidate.textValue, 1, 2048)
              FROM (
                SELECT
                  p2.time_created AS timestamp,
                  p2.rowid AS rowId,
                  json_extract(m2.data, '$.role') AS role,
                  json_extract(p2.data, '$.type') AS partType,
                  CASE
                    WHEN json_type(p2.data, '$.text') = 'true' THEN 'true'
                    WHEN json_type(p2.data, '$.text') = 'false' THEN 'false'
                    WHEN json_type(p2.data, '$.text') IN ('text', 'integer', 'real')
                      THEN CAST(json_extract(p2.data, '$.text') AS TEXT)
                  END AS textValue
                FROM part p2
                JOIN message m2 ON p2.message_id = m2.id
                WHERE p2.session_id = paged.sid
                  AND json_valid(p2.data)
                  AND json_valid(m2.data)
              ) AS candidate
              WHERE candidate.role IN ('user', 'assistant')
                AND candidate.partType = 'text'
                AND COALESCE(candidate.textValue, '') <> ''
                ${SNIPPET_FILTER_SQL}
              ORDER BY
                CASE candidate.role WHEN 'user' THEN 0 ELSE 1 END,
                candidate.timestamp,
                candidate.rowId
              LIMIT 1
            ) AS snippetText,
            totals.total
          FROM totals
          LEFT JOIN paged ON TRUE
          ORDER BY paged.updatedAt DESC, paged.sid ASC
        `,
        args: [
          ...reached.args,
          range?.since ?? -8640000000000000,
          range?.until ?? 8640000000000000,
          limit,
          offset,
          ...SNIPPET_FILTER_ARGS,
        ],
      });
      const rows = result.rows as unknown as SummaryRow[];
      const total = Number(rows[0]?.total ?? 0);
      const sessions = rows.flatMap((row) => {
        if (typeof row.sid !== "string") return [];
        return [
          {
            id: row.sid,
            source: this.name,
            createdAt: Number(row.createdAt),
            updatedAt: Number(row.updatedAt),
            messageCount: Number(row.messageCount),
            snippetText: typeof row.snippetText === "string" ? row.snippetText : undefined,
          },
        ];
      });
      return { total, sessions };
    } finally {
      db.close();
    }
  }

  async *read(options?: SourceReadOptions): AsyncGenerator<Message> {
    const db = await openDatabase(this.dbPath);
    try {
      let boundary: Boundary | undefined;
      while (true) {
        const { whereSql, args } = partPage(options, boundary);
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
    ${whereSql}
    ORDER BY p.time_created, p.rowid
    LIMIT ?
  `,
          args,
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
