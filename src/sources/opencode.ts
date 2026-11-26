import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { directoryPrefix, inDirectory } from "../core/cwd.ts";
import { openDatabase } from "../core/db.ts";
import { home, osUser } from "../core/env.ts";
import { INJECTED_PREFIXES } from "../tool-snippet.ts";
import type {
  Block,
  Channel,
  Message,
  Participant,
  Source,
  SessionListFilter,
  SourceReadOptions,
  SourceSummaryWindow,
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
  readonly cwd?: unknown;
}

/** Which sessions an `activeSince` read keeps. */
interface Reach {
  /** Kept ids as a JSON array when SQL filters the pages. */
  readonly json?: string;
  /** Nothing reaches the bound. */
  readonly empty: boolean;
  keeps(sessionId: string): boolean;
}

const EVERY_SESSION: Reach = { empty: false, keeps: () => true };

interface ParsedPart {
  readonly role?: Message["role"];
  readonly blocks: Block[];
  readonly botAuthor: boolean;
}

interface SessionRow {
  readonly id: unknown;
  readonly directory: unknown;
}

interface SummaryRow {
  readonly sid: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
  readonly messageCount: unknown;
  readonly snippetText: unknown;
  readonly cwd: unknown;
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

/**
 * OpenCode keeps a session's directory on its `session` row.
 * @param row - One part row, with `session.directory` joined in.
 * @returns {Pick<Message, "context">} `context.cwd`, or nothing when the row has none.
 */
function contextOf(row: Readonly<PartRow>): Pick<Message, "context"> {
  const cwd = scalarText(row.cwd);
  return cwd ? { context: { cwd } } : {};
}

/**
 * Builds the WHERE clause of one keyset page.
 * @param sessionId - Exact session, or all.
 * @param reached - Kept ids as a JSON array, or all.
 * @param boundary - Last row of the previous page.
 * @returns {{ whereSql: string, args: Array<string | number> }} Clause and arguments.
 */
function partPage(
  sessionId: string | undefined,
  reached: string | undefined,
  boundary: Readonly<Boundary> | undefined,
): { readonly whereSql: string; readonly args: Array<string | number> } {
  const predicates: string[] = [];
  const args: Array<string | number> = [];
  if (sessionId) {
    predicates.push("p.session_id = ?");
    args.push(sessionId);
  }
  if (reached !== undefined) {
    predicates.push("p.session_id IN (SELECT value FROM json_each(?))");
    args.push(reached);
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

/**
 * Sessions whose row names the directory or one below it, by the rule every source uses.
 * @param db - Open OpenCode database.
 * @param cwd - Absolute directory filter.
 * @returns {{ sql: string, args: string[] }} Clause for the part scan and its arguments.
 */
function directorySessions(
  db: Readonly<DatabaseSync>,
  cwd: string | undefined,
): { readonly sql: string; readonly args: string[] } {
  if (cwd === undefined) return { sql: "", args: [] };
  const prefix = directoryPrefix(cwd);
  const rows = db.prepare("SELECT id, directory FROM session").all();
  const ids = (rows as unknown as readonly SessionRow[]).flatMap(({ id, directory }) =>
    typeof id === "string" && typeof directory === "string" && inDirectory(directory, prefix)
      ? [id]
      : [],
  );
  return {
    sql: "AND p.session_id IN (SELECT value FROM json_each(?))",
    args: [JSON.stringify(ids)],
  };
}

/**
 * Finds the kept sessions once. Past half the parts, a plain scan beats the session index.
 * @param db - Open OpenCode database.
 * @param since - Inclusive bound on a session's last part.
 * @returns {Reach} Kept sessions, all without a bound.
 */
function reach(db: Readonly<DatabaseSync>, since: number | undefined): Reach {
  if (since === undefined) return EVERY_SESSION;
  const row = db
    .prepare(
      `
      WITH sessions AS (
        SELECT session_id, MAX(time_created) >= ? AS reached, COUNT(*) AS parts
        FROM part
        GROUP BY session_id
      )
      SELECT
        json_group_array(session_id) FILTER (WHERE reached) AS ids,
        COALESCE(SUM(parts) FILTER (WHERE reached), 0) AS reachedParts,
        COALESCE(SUM(parts), 0) AS allParts
      FROM sessions
    `,
    )
    .get(since);
  const json = typeof row?.ids === "string" ? row.ids : "[]";
  const empty = json === "[]";
  if (Number(row?.reachedParts) * 2 <= Number(row?.allParts)) {
    return { json, empty, keeps: () => true };
  }
  const parsed: unknown = JSON.parse(json);
  const ids = new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  return { empty, keeps: (sessionId) => ids.has(sessionId) };
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
      ...contextOf(row),
    };
  }

  /**
   * Messages of one page from the kept sessions.
   * @param rows - One page of part rows.
   * @param reached - Sessions to keep.
   * @yields {Message} Each kept message.
   */
  private *messagesOf(rows: readonly PartRow[], reached: Readonly<Reach>): Generator<Message> {
    for (const row of rows) {
      if (!reached.keeps(row.sid)) continue;
      const message = this.messageFromRow(row);
      if (message) yield message;
    }
  }

  async summaryWindow(
    offset: number,
    limit: number,
    range?: SessionListFilter,
  ): Promise<SourceSummaryWindow> {
    const reached = reachedSessions(range?.since);
    const db = await openDatabase(this.dbPath);
    try {
      const placed = directorySessions(db, range?.cwd);
      const rows = db
        .prepare(
          `
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
              ${placed.sql}
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
            (SELECT directory FROM session WHERE id = paged.sid) AS cwd,
            totals.total
          FROM totals
          LEFT JOIN paged ON TRUE
          ORDER BY paged.updatedAt DESC, paged.sid ASC
        `,
        )
        .all(
          ...reached.args,
          ...placed.args,
          range?.since ?? -8640000000000000,
          range?.until ?? 8640000000000000,
          limit,
          offset,
          ...SNIPPET_FILTER_ARGS,
        ) as unknown as SummaryRow[];
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
            ...(typeof row.cwd === "string" && row.cwd ? { cwd: row.cwd } : {}),
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
      const reached = reach(db, options?.activeSince);
      if (reached.empty) return;
      let boundary: Boundary | undefined;
      while (true) {
        const { whereSql, args } = partPage(options?.sessionId, reached.json, boundary);
        const rows = db
          .prepare(
            `
    SELECT
      p.data as pdata,
      json_extract(m.data, '$.role') as role,
      p.time_created as tc,
      p.session_id as sid,
      p.rowid as rid,
      s.directory as cwd
    FROM part p
    JOIN message m ON p.message_id = m.id
    LEFT JOIN session s ON s.id = p.session_id
    ${whereSql}
    ORDER BY p.time_created, p.rowid
    LIMIT ?
  `,
          )
          .all(...args) as unknown as PartRow[];
        if (rows.length === 0) break;

        const last = rows.at(-1);
        if (!last) break;
        boundary = { timestamp: last.tc, rowId: last.rid };

        yield* this.messagesOf(rows, reached);
      }
    } finally {
      db.close();
    }
  }
}
