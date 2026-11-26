import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/core/types.ts";
import { HermesSource } from "../../src/sources/hermes.ts";
import { listSourceSessions, readSourceSession } from "../../src/tool-reader.ts";

/* The columns the reader touches, as Hermes schema 33 declares them. */
const SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, parent_session_id TEXT,
  started_at REAL NOT NULL, ended_at REAL, title TEXT, cwd TEXT);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT,
  timestamp REAL NOT NULL, finish_reason TEXT, reasoning TEXT, reasoning_content TEXT,
  active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0,
  display_kind TEXT, display_metadata TEXT);`;

/* 2026-11-20T10:00:00Z in the Unix seconds Hermes stores. */
const T0 = 1_795_168_800;

interface Row {
  readonly session: string;
  readonly role: string;
  readonly content?: string | null;
  readonly at: number;
  readonly toolCalls?: unknown;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly finish?: string;
  readonly reasoning?: string;
  readonly reasoningContent?: string;
  readonly active?: number;
  readonly compacted?: number;
  readonly kind?: string;
  readonly display?: unknown;
}

let directory: string;
let dbPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sessions-hermes-"));
  dbPath = join(directory, "state.db");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

/* One row's values in the column order of INSERT_MESSAGE. */
function values(row: Row): (string | number | null)[] {
  const tools = row.toolCalls === undefined ? null : JSON.stringify(row.toolCalls);
  const display = row.display === undefined ? null : JSON.stringify(row.display);
  const optional = [row.content, tools, row.toolCallId, row.toolName, row.finish, row.reasoning];
  return [
    row.session,
    row.role,
    row.at,
    ...optional.map((value) => value ?? null),
    row.reasoningContent ?? null,
    row.active ?? 1,
    row.compacted ?? 0,
    row.kind ?? null,
    display,
  ];
}

const INSERT_MESSAGE = `INSERT INTO messages (session_id, role, timestamp, content, tool_calls,
  tool_call_id, tool_name, finish_reason, reasoning, reasoning_content, active, compacted,
  display_kind, display_metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/* Writes the sessions, then the rows in order, so row ids follow the array. */
function database(
  sessions: readonly (readonly [string, string, Readonly<Record<string, string>>?])[],
  rows: readonly Row[],
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCHEMA);
    const session = db.prepare(
      "INSERT INTO sessions (id, source, started_at, title, cwd, parent_session_id) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const [id, source, extra = {}] of sessions) {
      session.run(id, source, T0, extra.title ?? null, extra.cwd ?? null, extra.parent ?? null);
    }
    const message = db.prepare(INSERT_MESSAGE);
    db.exec("BEGIN");
    for (const row of rows) message.run(...values(row));
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

/* Every message the reader yields for these options. */
async function read(options?: Parameters<HermesSource["read"]>[0]): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const message of new HermesSource(dbPath).read(options)) messages.push(message);
  return messages;
}

const call = {
  id: "call_1",
  call_id: "call_1",
  type: "function",
  function: { name: "read_file", arguments: '{"path": "a.txt"}' },
};

describe("Hermes source", () => {
  it("reads a CLI turn with thinking, a tool call and its result", async () => {
    database(
      [["s1", "cli", { title: "Fix CI", cwd: "/work/shop" }]],
      [
        { session: "s1", role: "user", content: "Why is CI red?", at: T0 },
        {
          session: "s1",
          role: "assistant",
          content: "",
          at: T0 + 1.5,
          reasoning: "Read the file first.",
          toolCalls: [call],
          finish: "tool_calls",
        },
        {
          session: "s1",
          role: "tool",
          content: '{"content": "1|ok"}',
          at: T0 + 2,
          toolCallId: "call_1",
          toolName: "read_file",
        },
        { session: "s1", role: "assistant", content: "Fixed.", at: T0 + 3, finish: "stop" },
      ],
    );

    const messages = await read();

    expect(messages.map(({ role, blocks }) => ({ role, blocks }))).toEqual([
      { role: "user", blocks: [{ type: "text", text: "Why is CI red?" }] },
      {
        role: "assistant",
        blocks: [
          { type: "thinking", text: "Read the file first." },
          {
            type: "tool_call",
            toolName: "read_file",
            toolCallId: "call_1",
            toolInput: '{"path": "a.txt"}',
          },
        ],
      },
      {
        role: "tool",
        blocks: [
          {
            type: "tool_result",
            toolCallId: "call_1",
            toolName: "read_file",
            text: '{"content": "1|ok"}',
          },
        ],
      },
      { role: "assistant", blocks: [{ type: "text", text: "Fixed." }] },
    ]);
    expect(messages[1]).toMatchObject({
      source: "hermes",
      sessionId: "s1",
      timestamp: (T0 + 1.5) * 1000,
      timestampSource: "message",
      date: "2026-11-20",
      context: { title: "Fix CI", cwd: "/work/shop", hermesRowId: "2" },
      channel: { platform: "cli", name: "hermes" },
      author: { platform: "cli", name: "hermes", isBot: true },
    });
    expect(messages[0]?.author).toMatchObject({ platform: "cli" });
    expect(messages[0]?.author?.isBot).toBeUndefined();
  });

  it("keeps compacted history and leaves rewound rows out, as Hermes shows them", async () => {
    database(
      [["s1", "cli"]],
      [
        {
          session: "s1",
          role: "user",
          content: "before compaction",
          at: T0,
          active: 0,
          compacted: 1,
        },
        { session: "s1", role: "user", content: "rewound", at: T0 + 1, active: 0, compacted: 0 },
        { session: "s1", role: "user", content: "live", at: T0 + 2 },
      ],
    );

    const messages = await read();

    expect(messages.map((message) => message.blocks[0]?.text)).toEqual([
      "before compaction",
      "live",
    ]);
    expect(messages[0]?.context?.compacted).toBe("true");
    expect(messages[1]?.context?.compacted).toBeUndefined();
  });

  it("skips a row whose time Date can't hold instead of failing the read", async () => {
    database(
      [["s1", "cli"]],
      [
        { session: "s1", role: "user", content: "far future", at: 9e12 },
        { session: "s1", role: "user", content: "now", at: T0 },
      ],
    );

    expect((await read()).map((message) => message.blocks[0]?.text)).toEqual(["now"]);
  });

  it("follows row ids, not the clock, which Hermes says can regress", async () => {
    database(
      [["s1", "cli"]],
      [
        { session: "s1", role: "user", content: "first", at: T0 + 10 },
        { session: "s1", role: "assistant", content: "second", at: T0 },
      ],
    );

    expect((await read()).map((message) => message.blocks[0]?.text)).toEqual(["first", "second"]);
  });

  it("turns a failed request into a stop block with the provider error", async () => {
    database(
      [["s1", "cli"]],
      [
        { session: "s1", role: "user", content: "hi", at: T0 },
        {
          session: "s1",
          role: "assistant",
          content:
            "Your request was not processed. Send it again if you still want me to carry it out.",
          at: T0 + 1,
          kind: "failed_turn",
          display: { error: "Connection error.", error_surface: { code: "timeout" } },
        },
        { session: "s1", role: "assistant", content: "cut sh", at: T0 + 2, finish: "length" },
      ],
    );

    const [, failed, cut] = await read();

    expect(failed?.blocks).toEqual([
      { type: "stop", stopReason: "error", text: "Connection error." },
    ]);
    expect(cut?.blocks).toEqual([
      { type: "text", text: "cut sh" },
      { type: "stop", stopReason: "length" },
    ]);
  });

  it("reads structured content Hermes stores behind its JSON prefix", async () => {
    const parts = [
      { type: "text", text: "What is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ];
    database(
      [["s1", "cli"]],
      [
        { session: "s1", role: "user", content: `\u0000json:${JSON.stringify(parts)}`, at: T0 },
        { session: "s1", role: "user", content: "\u0000json:{broken", at: T0 + 1 },
      ],
    );

    const messages = await read();

    expect(messages.map((message) => message.blocks)).toEqual([
      [{ type: "text", text: "What is this?\n[image]" }],
      [{ type: "text", text: "\u0000json:{broken" }],
    ]);
  });

  it("leaves the author unset for prompts that came through a gateway or cron", async () => {
    database(
      [
        ["tg", "telegram"],
        ["cron", "cron"],
      ],
      [
        { session: "tg", role: "user", content: "from the phone", at: T0 },
        { session: "cron", role: "user", content: "scheduled", at: T0 + 1 },
        { session: "cron", role: "assistant", content: "done", at: T0 + 2 },
      ],
    );

    const messages = await read();

    expect(messages.map((message) => [message.channel?.platform, message.author?.name])).toEqual([
      ["telegram", undefined],
      ["cron", undefined],
      ["cron", "hermes"],
    ]);
  });

  it("names the session a compression continued from", async () => {
    database(
      [
        ["root", "cli"],
        ["child", "cli", { parent: "root" }],
      ],
      [
        { session: "root", role: "user", content: "start", at: T0 },
        { session: "child", role: "user", content: "go on", at: T0 + 60 },
      ],
    );

    const messages = await read({ sessionId: "child" });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.context?.parentSessionId).toBe("root");
  });

  it("skips empty rows and pages through more than one window", async () => {
    const rows: Row[] = Array.from({ length: 2_005 }, (_, index) => ({
      session: index % 2 === 0 ? "even" : "odd",
      role: "user",
      content: index === 7 ? "" : `m${index}`,
      at: T0 + index,
    }));
    database(
      [
        ["even", "cli"],
        ["odd", "cli"],
      ],
      rows,
    );

    const messages = await read();
    const odd = await read({ sessionId: "odd" });

    expect(messages).toHaveLength(2_004);
    expect(new Set(messages.map((message) => message.blocks[0]?.text)).size).toBe(2_004);
    expect(odd).toHaveLength(1_001);
    expect(odd.at(-1)?.blocks[0]?.text).toBe("m2003");
  });

  it("lists only sessions still active at a since bound", async () => {
    database(
      [
        ["old", "cli"],
        ["fresh", "cli"],
      ],
      [
        { session: "old", role: "user", content: "old", at: T0 },
        { session: "fresh", role: "user", content: "older half", at: T0 },
        { session: "fresh", role: "assistant", content: "fresh half", at: T0 + 3600 },
      ],
    );

    const reached = await read({ activeSince: (T0 + 60) * 1000 });
    const nothing = await read({ activeSince: (T0 + 7200) * 1000 });
    const listing = await listSourceSessions(new HermesSource(dbPath), 0, 10, {
      since: (T0 + 60) * 1000,
    });

    expect(reached.map((message) => message.blocks[0]?.text)).toEqual(["older half", "fresh half"]);
    expect(nothing).toEqual([]);
    expect(listing).toMatchObject({ total: 1, sessions: [{ id: "fresh", messageCount: 2 }] });
  });

  it("reads one bounded window of a session", async () => {
    database(
      [["s1", "cli"]],
      ["a", "b", "c"].map((content, index) => ({
        session: "s1",
        role: "user",
        content,
        at: T0 + index,
      })),
    );

    const window = await readSourceSession(new HermesSource(dbPath), "s1", 1, 1);

    expect(window).toMatchObject({ total: 3, indices: [1], nextMessage: 2 });
    expect(window.messages[0]?.blocks[0]?.text).toBe("b");
  });

  it("reads $HERMES_HOME/state.db when no path is passed", async () => {
    database([["s1", "cli"]], [{ session: "s1", role: "user", content: "home", at: T0 }]);
    vi.stubEnv("HERMES_HOME", directory);

    const source = new HermesSource();
    const messages: Message[] = [];
    for await (const message of source.read()) messages.push(message);

    expect(source.available()).toBe(true);
    expect(messages.map((message) => message.blocks[0]?.text)).toEqual(["home"]);
  });
});
