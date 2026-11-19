import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { openDatabase } from "../core/db.ts";
import { home } from "../core/env.ts";
import type {
  Block,
  Channel,
  Message,
  Participant,
  Source,
  SourceReadOptions,
} from "../core/types.ts";
import { isRecord, parseJsonRecord, scalarText } from "./parsing.ts";

/** Rows carry whole message JSON, so a page stays small enough to hold. */
const WINDOW = 1000;

type Row = Readonly<Record<string, unknown>>;
type Native = Readonly<Record<string, unknown>>;

/** What `projection_agents` says about one agent. */
interface Agent {
  readonly name?: string;
  /** `workspacePath`, the `cwd` its Claude Code runs report. */
  readonly cwd?: string;
}

type Agents = Readonly<Record<string, Readonly<Agent>>>;

/** Last row of a page, compared as a row value so equal ordinals never repeat or vanish. */
interface Cursor {
  readonly sid: string;
  readonly position: number;
  readonly mid: string;
}

/** Everything one native message needs besides its own JSON. */
interface Origin {
  readonly sessionId: string;
  readonly channel: Readonly<Channel>;
  readonly agent?: Readonly<Participant>;
  readonly context: Readonly<Record<string, string>>;
}

/** One OpenBot conversation table: agent threads or team channels. */
interface Stream {
  readonly tables: readonly string[];
  readonly where: string;
  readonly select: string;
  readonly from: string;
  readonly filter: string;
  readonly order: string;
  readonly toMessage: (row: Row, agents: Agents) => Message | undefined;
}

function text(value: unknown): string | undefined {
  const result = scalarText(value);
  return result === "" ? undefined : result;
}

function attachmentLine(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const name = text(value.name) ?? "attachment";
  const url = text(value.previewUrl);
  return url ? `[${name}](${url})` : name;
}

/**
 * Turns one native message into blocks: its text, then a link per attachment.
 * @param native - Parsed `message_json`, or the `message` inside a channel row.
 * @returns {Block[]} Empty when OpenBot kept nothing readable, such as encrypted reasoning.
 */
function blocksOf(native: Native): Block[] {
  const lines = Array.isArray(native.attachments)
    ? native.attachments.flatMap((item: unknown) => attachmentLine(item) ?? [])
    : [];
  const body = text(native.text);
  const parts = body === undefined ? lines : [body, ...lines];
  return parts.length > 0 ? [{ type: "text", text: parts.join("\n") }] : [];
}

/**
 * System notices such as memory saves and routing are app events, not conversation turns.
 * @param author - Native `author` of the message.
 * @returns {Message["role"] | undefined} The role, or nothing for a system notice.
 */
function roleOf(author: unknown): Message["role"] | undefined {
  if (author === "user" || author === "agent") return "user";
  return author === "assistant" ? "assistant" : undefined;
}

function contextOf(native: Native, base: Readonly<Record<string, string>>): Record<string, string> {
  const context: Record<string, string> = { ...base };
  const turnId = text(native.turnId);
  const itemType = text(native.itemType);
  const status = text(native.status);
  if (turnId) context.turnId = turnId;
  if (itemType) context.itemType = itemType;
  if (status && status !== "completed") context.status = status;
  return context;
}

function member(value: unknown): Participant | undefined {
  if (!isRecord(value)) return undefined;
  const name = text(value.name);
  return name ? { platform: "openbot", platformId: text(value.id), name } : undefined;
}

function routineAuthor(native: Native): Participant | undefined {
  if (native.source !== "routine") return undefined;
  const routine = isRecord(native.routine) ? native.routine : {};
  return {
    platform: "openbot",
    platformId: text(routine.id),
    name: text(routine.name) ?? "routine",
    isBot: true,
  };
}

function agentOf(agents: Agents, id: string | undefined): Readonly<Agent> | undefined {
  return id && Object.hasOwn(agents, id) ? agents[id] : undefined;
}

function senderAgent(native: Native, agents: Agents): Participant | undefined {
  const id = text(native.senderAgentId);
  if (!id) return undefined;
  const name = agentOf(agents, id)?.name;
  return { platform: "openbot", platformId: id, name: name ?? id, isBot: true };
}

/**
 * Names who wrote a thread message: the agent itself, a routine, another agent or a member.
 * @param native - Parsed `message_json` of a thread row.
 * @param origin - Thread metadata, including its agent.
 * @param agents - Agents by id, for messages one agent sent another.
 * @returns {Participant | undefined} The author, when OpenBot recorded one.
 */
function threadAuthor(
  native: Native,
  origin: Readonly<Origin>,
  agents: Agents,
): Participant | undefined {
  if (native.author === "assistant") return origin.agent;
  if (native.author === "agent") return senderAgent(native, agents);
  return routineAuthor(native) ?? member(native.senderMember);
}

function message(
  native: Native,
  origin: Readonly<Origin>,
  author: Readonly<Participant> | undefined,
): Message | undefined {
  const role = roleOf(native.author);
  const timestamp = Date.parse(text(native.createdAt) ?? "");
  const blocks = blocksOf(native);
  if (!role || !Number.isFinite(timestamp) || blocks.length === 0) return undefined;
  return {
    source: "openbot",
    sessionId: origin.sessionId,
    role,
    timestamp,
    timestampSource: "message",
    date: new Date(timestamp).toISOString().slice(0, 10),
    blocks,
    context: contextOf(native, origin.context),
    channel: origin.channel,
    ...(author ? { author } : {}),
  };
}

function threadContext(row: Row): Record<string, string> {
  const context: Record<string, string> = {};
  for (const key of ["title", "provider", "providerSessionId", "model"]) {
    const value = text(row[key]);
    if (value) context[key] = value;
  }
  return context;
}

function threadMessage(row: Row, agents: Agents): Message | undefined {
  const native = parseJsonRecord(scalarText(row.body) ?? "");
  const sessionId = text(row.sid);
  if (!native || !sessionId) return undefined;
  const agentId = text(row.agentId);
  const { name, cwd } = agentOf(agents, agentId) ?? {};
  const origin: Origin = {
    sessionId,
    channel: { platform: "openbot", platformId: agentId, name: name ?? agentId, type: "thread" },
    agent: { platform: "openbot", platformId: agentId, name: name ?? "openbot", isBot: true },
    context: { ...threadContext(row), ...(cwd ? { cwd } : {}) },
  };
  return message(native, origin, threadAuthor(native, origin, agents));
}

function channelAuthor(value: unknown): Participant | undefined {
  const author = member(value);
  if (!author || !isRecord(value) || value.kind === "member") return author;
  return { ...author, isBot: true };
}

function channelMessage(row: Row): Message | undefined {
  const outer = parseJsonRecord(scalarText(row.body) ?? "");
  const sessionId = text(row.sid);
  if (!outer || !isRecord(outer.message) || !sessionId) return undefined;
  const taskId = text(outer.taskId);
  const origin: Origin = {
    sessionId,
    channel: { platform: "openbot", platformId: sessionId, name: text(row.name), type: "channel" },
    context: taskId ? { taskId } : {},
  };
  return message(outer.message, origin, channelAuthor(outer.author));
}

/** Replaced channel revisions are skipped, since each one still sits in its agent's thread. */
const STREAMS: readonly Stream[] = [
  {
    tables: [
      "projection_thread_messages",
      "projection_threads",
      "projection_turns",
      "projection_provider_sessions",
    ],
    where: "1",
    select: `m.thread_id AS sid, m.ordinal AS position, m.message_id AS mid, m.message_json AS body,
      t.agent_id AS agentId, t.title AS title, p.provider AS provider,
      p.external_session_id AS providerSessionId, p.model AS model`,
    from: `projection_thread_messages m
      JOIN projection_threads t ON t.thread_id = m.thread_id
      LEFT JOIN projection_turns u ON u.turn_id = m.turn_id
      LEFT JOIN projection_provider_sessions p ON p.id = u.provider_session_id`,
    filter: "m.thread_id",
    order: "m.thread_id, m.ordinal, m.message_id",
    toMessage: threadMessage,
  },
  {
    tables: ["projection_channel_messages", "projection_channels"],
    where: "coalesce(json_extract(c.message_json, '$.superseded'), 0) <> 1",
    select: `c.channel_id AS sid, c.sequence AS position, c.message_id AS mid, c.message_json AS body,
      json_extract(h.channel_json, '$.name') AS name`,
    from: `projection_channel_messages c
      JOIN projection_channels h ON h.channel_id = c.channel_id`,
    filter: "c.channel_id",
    order: "c.channel_id, c.sequence, c.message_id",
    toMessage: (row) => channelMessage(row),
  },
];

function pageSql(stream: Readonly<Stream>, sessionId: boolean, cursor: boolean): string {
  const predicates = [stream.where];
  if (sessionId) predicates.push(`${stream.filter} = ?`);
  if (cursor) predicates.push(`(${stream.order}) > (?, ?, ?)`);
  return `SELECT ${stream.select} FROM ${stream.from}
    WHERE ${predicates.join(" AND ")} ORDER BY ${stream.order} LIMIT ?`;
}

function cursorOf(row: Row | undefined): Cursor | undefined {
  const sid = text(row?.sid);
  const mid = text(row?.mid);
  const position = Number(row?.position);
  return sid && mid && Number.isFinite(position) ? { sid, position, mid } : undefined;
}

async function tables(db: Readonly<Client>): Promise<ReadonlySet<string>> {
  const result = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
  return new Set(result.rows.flatMap((row) => scalarText(row.name) ?? []));
}

async function agentsOf(db: Readonly<Client>, present: boolean): Promise<Agents> {
  const agents: Record<string, Agent> = {};
  if (!present) return agents;
  const result =
    await db.execute(`SELECT agent_id AS id, json_extract(agent_json, '$.name') AS name,
    json_extract(agent_json, '$.workspacePath') AS cwd FROM projection_agents`);
  for (const row of result.rows) {
    const id = scalarText(row.id);
    const name = text(row.name);
    const cwd = text(row.cwd);
    if (id && (name || cwd)) agents[id] = { ...(name ? { name } : {}), ...(cwd ? { cwd } : {}) };
  }
  return agents;
}

/**
 * OpenBot agent threads and team channels, one session each. Tool calls stay with the provider:
 * `providerSessionId` is the Codex or Claude Code session id, and for Pi its session file.
 */
export class OpenBotSource implements Source {
  name = "openbot";
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(home(), ".config/OpenBot/openbot.db");
  }

  available(): boolean {
    return existsSync(this.dbPath);
  }

  async *read(options?: SourceReadOptions): AsyncGenerator<Message> {
    const db = await openDatabase(this.dbPath);
    try {
      const known = await tables(db);
      const agents = await agentsOf(db, known.has("projection_agents"));
      for (const stream of STREAMS) {
        if (stream.tables.every((table) => known.has(table)))
          yield* this.stream(db, stream, agents, options?.sessionId);
      }
    } finally {
      db.close();
    }
  }

  private async *stream(
    db: Readonly<Client>,
    stream: Readonly<Stream>,
    agents: Agents,
    sessionId: string | undefined,
  ): AsyncGenerator<Message> {
    let cursor: Cursor | undefined;
    while (true) {
      const args = [
        ...(sessionId === undefined ? [] : [sessionId]),
        ...(cursor ? [cursor.sid, cursor.position, cursor.mid] : []),
        WINDOW,
      ];
      const sql = pageSql(stream, sessionId !== undefined, cursor !== undefined);
      const { rows } = await db.execute({ sql, args });
      for (const row of rows) {
        const result = stream.toMessage(row, agents);
        if (result) yield result;
      }
      cursor = cursorOf(rows.at(-1));
      if (!cursor || rows.length < WINDOW) return;
    }
  }
}
