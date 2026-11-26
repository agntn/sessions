import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../../src/core/types.ts";
import { OpenBotSource } from "../../src/sources/openbot.ts";

const THREADS = `
CREATE TABLE projection_threads (
  thread_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, title TEXT NOT NULL, active_turn_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_event_sequence INTEGER NOT NULL);
CREATE TABLE projection_agents (
  agent_id TEXT PRIMARY KEY, thread_id TEXT, model TEXT NOT NULL, updated_at TEXT,
  sort_order INTEGER NOT NULL, agent_json TEXT NOT NULL, last_event_sequence INTEGER NOT NULL);
CREATE TABLE projection_provider_sessions (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, provider TEXT NOT NULL,
  external_session_id TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL, state TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resume_cursor TEXT,
  last_event_sequence INTEGER NOT NULL);
CREATE TABLE projection_turns (
  turn_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, provider_session_id TEXT, status TEXT NOT NULL,
  started_at TEXT NOT NULL, completed_at TEXT, last_event_sequence INTEGER NOT NULL);
CREATE TABLE projection_thread_messages (
  thread_id TEXT NOT NULL, message_id TEXT NOT NULL, turn_id TEXT, author TEXT NOT NULL,
  status TEXT NOT NULL, item_type TEXT, created_at TEXT NOT NULL, ordinal INTEGER NOT NULL,
  message_json TEXT NOT NULL, last_event_sequence INTEGER NOT NULL, group_start TEXT,
  group_first INTEGER, group_id TEXT, turn_rank INTEGER, PRIMARY KEY(thread_id, message_id));`;

const CHANNELS = `
CREATE TABLE projection_channels (channel_id TEXT PRIMARY KEY, channel_json TEXT NOT NULL);
CREATE TABLE projection_channel_messages (
  channel_id TEXT NOT NULL, message_id TEXT NOT NULL, sequence INTEGER NOT NULL,
  message_json TEXT NOT NULL, PRIMARY KEY(channel_id, message_id));`;

const THREAD = "openbot-thread-agent-1";
const CHANNEL = "channel-1";

let directory: string;
let dbPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sessions-openbot-"));
  dbPath = join(directory, "openbot.db");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function database(schema: string, statements: readonly string[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(schema);
    for (const sql of statements) db.exec(sql);
  } finally {
    db.close();
  }
}

function json(value: unknown): string {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'`;
}

function threadRow(ordinal: number, message: Readonly<Record<string, unknown>>): string {
  return `INSERT INTO projection_thread_messages
    (thread_id, message_id, turn_id, author, status, item_type, created_at, ordinal, message_json,
     last_event_sequence)
    VALUES ('${THREAD}', '${String(message.id)}', 'turn-1', '${String(message.author)}', 'completed',
     NULL, '${String(message.createdAt)}', ${ordinal}, ${json(message)}, 1)`;
}

function channelRow(sequence: number, row: Readonly<Record<string, unknown>>): string {
  return `INSERT INTO projection_channel_messages (channel_id, message_id, sequence, message_json)
    VALUES ('${CHANNEL}', '${String(row.id)}', ${sequence}, ${json(row)})`;
}

const AGENTS = [
  `INSERT INTO projection_agents VALUES ('agent-1', '${THREAD}', 'm', NULL, 0, ${json({ name: "Nova" })}, 1)`,
  `INSERT INTO projection_agents VALUES ('agent-2', NULL, 'm', NULL, 1, ${json({ name: "Juno" })}, 1)`,
  `INSERT INTO projection_threads VALUES ('${THREAD}', 'agent-1', 'Nova', NULL, 't', 't', 1)`,
  `INSERT INTO projection_provider_sessions VALUES
    ('ps-1', '${THREAD}', 'codex', 'rollout-1', 'gpt-test', 'high', 'inactive', 't', 't', NULL, 1)`,
  `INSERT INTO projection_turns VALUES ('turn-1', '${THREAD}', 'ps-1', 'completed', 't', NULL, 1)`,
];

async function collect(source: Readonly<OpenBotSource>, sessionId?: string): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const message of source.read(sessionId ? { sessionId } : undefined)) {
    messages.push(message);
  }
  return messages;
}

describe("OpenBotSource agent threads", () => {
  it("reads what the thread shows and names the provider session behind each turn", async () => {
    database(THREADS, [
      ...AGENTS,
      threadRow(0, {
        id: "u-1",
        author: "user",
        source: "user",
        text: "Check the lockfile",
        senderMember: { id: "member-1", name: "you@example.test" },
        attachments: [],
        createdAt: "2026-11-01T10:00:00.000Z",
        turnId: "turn-1",
      }),
      threadRow(1, {
        id: "rs_1",
        author: "assistant",
        text: "",
        itemType: "commentary",
        createdAt: "2026-11-01T10:00:01.000Z",
        turnId: "turn-1",
      }),
      threadRow(2, {
        id: "msg_1",
        author: "assistant",
        text: "Lockfile is clean.",
        itemType: "final_answer",
        status: "completed",
        createdAt: "2026-11-01T10:00:02.000Z",
        turnId: "turn-1",
      }),
      threadRow(3, {
        id: "turn-1:memory-changes",
        author: "system",
        source: "system",
        text: "Memory: 1 saved, 0 updated, 0 forgotten.",
        itemType: "memory-changes",
        createdAt: "2026-11-01T10:00:03.000Z",
      }),
    ]);

    const messages = await collect(new OpenBotSource(dbPath));

    expect(messages.map((message) => [message.role, message.blocks])).toEqual([
      ["user", [{ type: "text", text: "Check the lockfile" }]],
      ["assistant", [{ type: "text", text: "Lockfile is clean." }]],
    ]);
    expect(messages[0]).toMatchObject({
      source: "openbot",
      sessionId: THREAD,
      timestamp: Date.parse("2026-11-01T10:00:00.000Z"),
      timestampSource: "message",
      date: "2026-11-01",
      channel: { platform: "openbot", platformId: "agent-1", name: "Nova", type: "thread" },
      author: { platform: "openbot", platformId: "member-1", name: "you@example.test" },
    });
    expect(messages[0]?.author?.isBot).toBeUndefined();
    expect(messages[1]?.author).toEqual({
      platform: "openbot",
      platformId: "agent-1",
      name: "Nova",
      isBot: true,
    });
    expect(messages[1]?.context).toEqual({
      title: "Nova",
      provider: "codex",
      providerSessionId: "rollout-1",
      model: "gpt-test",
      turnId: "turn-1",
      itemType: "final_answer",
    });
  });

  it("keeps attachments, routine prompts, other agents and unfinished items", async () => {
    database(THREADS, [
      ...AGENTS,
      threadRow(0, {
        id: "routine-1",
        author: "user",
        source: "routine",
        text: "Hourly check",
        routine: { id: "r-1", name: "Hourly" },
        createdAt: "2026-11-01T11:00:00.000Z",
      }),
      threadRow(1, {
        id: "exchange-1",
        author: "agent",
        source: "agent",
        text: "Done on my side",
        senderAgentId: "agent-2",
        createdAt: "2026-11-01T11:00:01.000Z",
      }),
      threadRow(2, {
        id: "agent-attachments:1",
        author: "assistant",
        text: "",
        itemType: "agent_attachment",
        attachments: [
          { name: "report.md", previewUrl: "openbot-attachment://file/a-1" },
          { name: "draft.txt" },
        ],
        createdAt: "2026-11-01T11:00:02.000Z",
      }),
      threadRow(3, {
        id: "msg_2",
        author: "assistant",
        text: "Halfway there",
        itemType: "commentary",
        status: "interrupted",
        createdAt: "2026-11-01T11:00:03.000Z",
      }),
    ]);

    const messages = await collect(new OpenBotSource(dbPath));

    expect(messages.map((message) => [message.role, message.author?.name])).toEqual([
      ["user", "Hourly"],
      ["user", "Juno"],
      ["assistant", "Nova"],
      ["assistant", "Nova"],
    ]);
    expect(messages[0]?.author).toEqual({
      platform: "openbot",
      platformId: "r-1",
      name: "Hourly",
      isBot: true,
    });
    expect(messages[1]?.author).toEqual({
      platform: "openbot",
      platformId: "agent-2",
      name: "Juno",
      isBot: true,
    });
    expect(messages[2]?.blocks).toEqual([
      { type: "text", text: "[report.md](openbot-attachment://file/a-1)\ndraft.txt" },
    ]);
    expect(messages[3]?.context?.status).toBe("interrupted");
  });

  it("pages past rows that share an ordinal without repeating or dropping any", async () => {
    const rows = Array.from({ length: 1003 }, (_, index) =>
      threadRow(7, {
        id: `msg-${String(index).padStart(4, "0")}`,
        author: "assistant",
        text: `step ${index}`,
        createdAt: "2026-11-01T12:00:00.000Z",
      }),
    );
    database(THREADS, [...AGENTS, ...rows]);

    const messages = await collect(new OpenBotSource(dbPath));

    expect(messages).toHaveLength(1003);
    expect(new Set(messages.map((message) => message.blocks[0]?.text)).size).toBe(1003);
  });
});

describe("OpenBotSource team channels", () => {
  const channel = `INSERT INTO projection_channels VALUES ('${CHANNEL}', ${json({ name: "Release" })})`;

  it("reads the live channel and leaves replaced revisions to the agent threads", async () => {
    database(`${THREADS}${CHANNELS}`, [
      ...AGENTS,
      channel,
      channelRow(1, {
        id: "c-1",
        channelId: CHANNEL,
        taskId: "task-1",
        author: { kind: "member", id: "member-1", name: "You" },
        superseded: false,
        message: {
          id: "c-1",
          author: "user",
          text: "Ship it when green",
          createdAt: "2026-11-02T09:00:00.000Z",
        },
      }),
      channelRow(2, {
        id: "result-1-revision-1",
        channelId: CHANNEL,
        author: { kind: "agent", id: "agent-1", name: "Nova" },
        superseded: true,
        message: {
          id: "result-1-revision-1",
          author: "assistant",
          text: "Draft result",
          createdAt: "2026-11-02T09:01:00.000Z",
        },
      }),
      channelRow(3, {
        id: "result-1-revision-2",
        channelId: CHANNEL,
        author: { kind: "agent", id: "agent-1", name: "Nova" },
        superseded: false,
        message: {
          id: "result-1-revision-2",
          author: "assistant",
          text: "Green and shipped",
          createdAt: "2026-11-02T09:02:00.000Z",
        },
      }),
      channelRow(4, {
        id: "routing-1",
        channelId: CHANNEL,
        author: { kind: "agent", id: "agent-1", name: "Nova" },
        superseded: false,
        message: {
          id: "routing-1",
          author: "system",
          text: "Assigned to Nova",
          itemType: "channel-routing-event:assigned:agent-1",
          createdAt: "2026-11-02T09:03:00.000Z",
        },
      }),
    ]);

    const messages = await collect(new OpenBotSource(dbPath));

    expect(messages.map((message) => [message.role, message.blocks[0]?.text])).toEqual([
      ["user", "Ship it when green"],
      ["assistant", "Green and shipped"],
    ]);
    expect(messages[0]).toMatchObject({
      sessionId: CHANNEL,
      channel: { platform: "openbot", platformId: CHANNEL, name: "Release", type: "channel" },
      author: { platform: "openbot", platformId: "member-1", name: "You" },
      context: { taskId: "task-1" },
    });
    expect(messages[0]?.author?.isBot).toBeUndefined();
    expect(messages[1]?.author).toEqual({
      platform: "openbot",
      platformId: "agent-1",
      name: "Nova",
      isBot: true,
    });
  });

  it("reads only the requested session", async () => {
    database(`${THREADS}${CHANNELS}`, [
      ...AGENTS,
      channel,
      threadRow(0, {
        id: "u-1",
        author: "user",
        text: "thread",
        createdAt: "2026-11-02T08:00:00.000Z",
      }),
      channelRow(1, {
        id: "c-1",
        author: { kind: "member", id: "member-1", name: "You" },
        message: { id: "c-1", author: "user", text: "channel", createdAt: "2026-11-02T09:00:00Z" },
      }),
    ]);
    const source = new OpenBotSource(dbPath);

    expect((await collect(source, CHANNEL)).map((message) => message.blocks[0]?.text)).toEqual([
      "channel",
    ]);
    expect((await collect(source, THREAD)).map((message) => message.blocks[0]?.text)).toEqual([
      "thread",
    ]);
    expect(await collect(source, "missing")).toEqual([]);
  });

  it("still reads threads from a database without channels", async () => {
    database(THREADS, [
      ...AGENTS,
      threadRow(0, {
        id: "u-1",
        author: "user",
        text: "no channels yet",
        createdAt: "2026-11-02T08:00:00.000Z",
      }),
    ]);

    const messages = await collect(new OpenBotSource(dbPath));

    expect(messages.map((message) => message.blocks[0]?.text)).toEqual(["no channels yet"]);
  });
});

describe("OpenBotSource location", () => {
  it("finds the app database under the home directory", () => {
    const previous = process.env.HOME;
    process.env.HOME = directory;
    try {
      expect(new OpenBotSource().available()).toBe(false);
      mkdirSync(join(directory, ".config", "OpenBot"), { recursive: true });
      writeFileSync(join(directory, ".config", "OpenBot", "openbot.db"), "");
      expect(new OpenBotSource().available()).toBe(true);
    } finally {
      process.env.HOME = previous;
    }
  });
});
