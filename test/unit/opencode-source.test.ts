import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Message } from "../../src/core/types.ts";

vi.mock("../../src/core/env.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/env.ts")>();
  return { ...actual, osUser: () => "testuser" };
});

import { OpenCodeSource } from "../../src/sources/opencode.ts";

/** One OpenCode part as the reader selects it, with `rid` as its rowid. */
interface Part {
  readonly pdata: string;
  readonly role: string;
  readonly tc: number | string;
  readonly sid: string;
  readonly rid: number;
}

let directory: string;
let dbPath: string;

/* Writes the parts into a real OpenCode database, one native message per part. */
function database(
  parts: readonly Part[],
  sessions: readonly (readonly [string, string])[] = [],
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, directory TEXT);
      CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE IF NOT EXISTS part (session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);
    `);
    db.exec("BEGIN");
    const message = db.prepare("INSERT INTO message VALUES (?, ?)");
    const part = db.prepare(
      "INSERT INTO part (rowid, session_id, message_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
    );
    for (const { pdata, role, tc, sid, rid } of parts) {
      message.run(`m${rid}`, JSON.stringify({ role }));
      part.run(rid, sid, `m${rid}`, tc, pdata);
    }
    const session = db.prepare("INSERT INTO session VALUES (?, ?)");
    for (const [id, cwd] of sessions) session.run(id, cwd);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

const text = (sid: string, rid: number, tc: number, body: string): Part => ({
  pdata: JSON.stringify({ type: "text", text: body }),
  role: "user",
  tc,
  sid,
  rid,
});

async function collect(source: Readonly<OpenCodeSource>): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const message of source.read()) messages.push(message);
  return messages;
}

describe("OpenCodeSource", () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "sessions-opencode-"));
    dbPath = join(directory, "opencode.db");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it("parses user text message with correct author", async () => {
    database([
      {
        pdata: JSON.stringify({ type: "text", text: "hello from user" }),
        role: "user",
        tc: 1700000000000,
        sid: "session-1",
        rid: 1,
      },
    ]);

    const source = new OpenCodeSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].source).toBe("opencode");
    expect(msgs[0].sessionId).toBe("session-1");
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].timestamp).toBe(1700000000000);
    expect(msgs[0].date).toBe("2023-11-14");
    expect(msgs[0].blocks).toEqual([{ type: "text", text: "hello from user" }]);
    expect(msgs[0].author).toEqual({ platform: "cli", name: "testuser" });
    expect(msgs[0].channel?.name).toBe("opencode");
  });

  it("parses assistant text message with bot author", async () => {
    database([
      {
        pdata: JSON.stringify({ type: "text", text: "assistant reply" }),
        role: "assistant",
        tc: 1700000001000,
        sid: "session-1",
        rid: 2,
      },
    ]);

    const source = new OpenCodeSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].author).toEqual({ platform: "cli", name: "opencode", isBot: true });
  });

  it("parses tool-invocation blocks", async () => {
    database([
      {
        pdata: JSON.stringify({
          type: "tool-invocation",
          toolName: "read_file",
          toolCallId: "tc-1",
          args: '{"path":"/foo"}',
        }),
        role: "assistant",
        tc: 1700000002000,
        sid: "s1",
        rid: 3,
      },
    ]);

    const source = new OpenCodeSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0]).toEqual({
      type: "tool_call",
      toolName: "read_file",
      toolCallId: "tc-1",
      toolInput: '{"path":"/foo"}',
    });
  });

  it("parses tool-call blocks with name and input fields", async () => {
    database([
      {
        pdata: JSON.stringify({
          type: "tool-call",
          name: "write_file",
          id: "tc-2",
          input: '{"content":"hi"}',
        }),
        role: "assistant",
        tc: 1700000003000,
        sid: "s1",
        rid: 4,
      },
    ]);

    const source = new OpenCodeSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0]).toEqual({
      type: "tool_call",
      toolName: "write_file",
      toolCallId: "tc-2",
      toolInput: '{"content":"hi"}',
    });
  });

  it("parses current tool blocks with nested input and completed output", async () => {
    database([
      {
        pdata: JSON.stringify({
          type: "tool",
          callID: "tc-current",
          tool: "read",
          state: {
            status: "completed",
            input: { path: "/foo" },
            output: "file contents here",
          },
        }),
        role: "assistant",
        tc: 1700000003500,
        sid: "s1",
        rid: 5,
      },
    ]);

    const source = new OpenCodeSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks).toEqual([
      {
        type: "tool_call",
        toolName: "read",
        toolCallId: "tc-current",
        toolInput: '{"path":"/foo"}',
      },
      {
        type: "tool_result",
        toolCallId: "tc-current",
        text: "file contents here",
        isError: false,
      },
    ]);
  });

  it.each([
    {
      state: { status: "completed", input: {}, output: "file contents here" },
      expected: { text: "file contents here", isError: false },
    },
    {
      state: { status: "error", input: {}, error: "File not found: /foo" },
      expected: { text: "File not found: /foo", isError: true },
    },
  ])("preserves native tool status: $state.status", async ({ state, expected }) => {
    database([
      {
        pdata: JSON.stringify({ type: "tool", callID: "tc-status", tool: "read", state }),
        role: "assistant",
        tc: 1700000003500,
        sid: "s1",
        rid: 5,
      },
    ]);

    const msgs = await collect(new OpenCodeSource(dbPath));

    expect(msgs[0].blocks[1]).toEqual({
      type: "tool_result",
      toolCallId: "tc-status",
      ...expected,
    });
  });

  it("parses tool-result blocks", async () => {
    database([
      {
        pdata: JSON.stringify({
          type: "tool-result",
          toolCallId: "tc-1",
          result: "file contents here",
        }),
        role: "assistant",
        tc: 1700000004000,
        sid: "s1",
        rid: 5,
      },
    ]);

    const source = new OpenCodeSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("tool");
    expect(msgs[0].blocks[0]).toEqual({
      type: "tool_result",
      toolCallId: "tc-1",
      text: "file contents here",
    });
  });

  it("serializes non-string tool-result to JSON", async () => {
    database([
      {
        pdata: JSON.stringify({
          type: "tool-result",
          toolCallId: "tc-3",
          result: { ok: true, lines: 42 },
        }),
        role: "assistant",
        tc: 1700000005000,
        sid: "s1",
        rid: 6,
      },
    ]);

    const source = new OpenCodeSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe('{"ok":true,"lines":42}');
  });

  it("skips rows with invalid timestamps instead of throwing", async () => {
    database([
      {
        pdata: JSON.stringify({ type: "text", text: "bad" }),
        role: "user",
        tc: "invalid",
        sid: "s1",
        rid: 1,
      },
      {
        pdata: JSON.stringify({ type: "text", text: "good message" }),
        role: "assistant",
        tc: 1700000000000,
        sid: "s1",
        rid: 2,
      },
    ]);

    const source = new OpenCodeSource(dbPath);
    const messages = await collect(source);

    expect(messages).toHaveLength(1);
    expect(messages[0].timestamp).toBe(1700000000000);
  });

  it("skips non-user/non-assistant roles", async () => {
    database([
      {
        pdata: JSON.stringify({ type: "text", text: "system message" }),
        role: "system",
        tc: 1700000000000,
        sid: "s1",
        rid: 1,
      },
    ]);

    const source = new OpenCodeSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("parses reasoning parts as thinking blocks", async () => {
    database([
      {
        pdata: JSON.stringify({
          type: "reasoning",
          text: "The user wants the parser fixed.",
          time: { start: 1700000001000, end: 1700000001500 },
        }),
        role: "assistant",
        tc: 1700000001000,
        sid: "session-1",
        rid: 2,
      },
      {
        pdata: JSON.stringify({ type: "text", text: "Fixing it now." }),
        role: "assistant",
        tc: 1700000002000,
        sid: "session-1",
        rid: 3,
      },
    ]);

    const source = new OpenCodeSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].blocks).toEqual([
      { type: "thinking", text: "The user wants the parser fixed." },
    ]);
    expect(msgs[0].author).toEqual({ platform: "cli", name: "opencode", isBot: true });
    expect(msgs[1].blocks).toEqual([{ type: "text", text: "Fixing it now." }]);
  });

  it("skips reasoning parts with empty text", async () => {
    database([
      {
        pdata: JSON.stringify({ type: "reasoning", text: "", time: { start: 1700000000000 } }),
        role: "assistant",
        tc: 1700000000000,
        sid: "s1",
        rid: 1,
      },
    ]);

    const source = new OpenCodeSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("skips text parts with empty text", async () => {
    database([
      {
        pdata: JSON.stringify({ type: "text", text: "" }),
        role: "user",
        tc: 1700000000000,
        sid: "s1",
        rid: 1,
      },
    ]);

    const source = new OpenCodeSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("skips rows with malformed JSON pdata", async () => {
    database([
      {
        pdata: "not valid json {{{",
        role: "user",
        tc: 1700000000000,
        sid: "s1",
        rid: 1,
      },
      {
        pdata: JSON.stringify({ type: "text", text: "valid" }),
        role: "user",
        tc: 1700000001000,
        sid: "s1",
        rid: 2,
      },
    ]);

    const source = new OpenCodeSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("valid");
  });

  it("skips unknown part types", async () => {
    database([
      {
        pdata: JSON.stringify({ type: "image", url: "https://example.com/img.png" }),
        role: "assistant",
        tc: 1700000000000,
        sid: "s1",
        rid: 1,
      },
    ]);

    const source = new OpenCodeSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("reads past one keyset window without repeating or dropping a part", async () => {
    database(
      Array.from({ length: 5002 }, (_, index) =>
        text("s1", index + 1, 1000 + ((index + 1) >> 1), `part ${index}`),
      ),
    );

    const messages = await collect(new OpenCodeSource(dbPath));

    expect(messages).toHaveLength(5002);
    expect(messages.map(({ blocks }) => blocks[0]?.text)).toEqual(
      Array.from({ length: 5002 }, (_, index) => `part ${index}`),
    );
  });

  it("reads only the requested session", async () => {
    database([
      text("other", 1, 1000, "not this one"),
      text("wanted", 2, 1000, "only this session"),
    ]);

    const messages: Message[] = [];
    for await (const message of new OpenCodeSource(dbPath).read({ sessionId: "wanted" })) {
      messages.push(message);
    }

    expect(messages.map(({ sessionId, blocks }) => [sessionId, blocks[0]?.text])).toEqual([
      ["wanted", "only this session"],
    ]);
  });

  it.each([
    { live: 2, ended: 7 },
    { live: 7, ended: 2 },
  ])(
    "keeps the whole session that reaches activeSince with $live of 9 parts",
    async ({ live, ended }) => {
      database([
        ...Array.from({ length: ended }, (_, index) => text("ended", index + 1, 1, "ended")),
        ...Array.from({ length: live }, (_, index) =>
          text("live", ended + index + 1, index === live - 1 ? 2 : 1, `live ${index}`),
        ),
      ]);

      const texts: string[] = [];
      for await (const message of new OpenCodeSource(dbPath).read({ activeSince: 2 })) {
        texts.push(`${message.sessionId}: ${message.blocks[0]?.text ?? ""}`);
      }

      expect(texts).toEqual(Array.from({ length: live }, (_, index) => `live: live ${index}`));
    },
  );

  it("reads nothing when no session reaches activeSince", async () => {
    database([text("ended", 1, 1, "old")]);

    const messages: Message[] = [];
    for await (const message of new OpenCodeSource(dbPath).read({ activeSince: 2 })) {
      messages.push(message);
    }

    expect(messages).toEqual([]);
  });

  it("returns a bounded session summary page from SQL", async () => {
    const tool = JSON.stringify({ type: "tool", callID: "c", tool: "read", state: {} });
    database(
      [
        text("old", 1, 1000, "old session"),
        text("middle", 2, 1500, "<system-reminder> injected"),
        text("middle", 3, 1600, "fix the tool read"),
        { pdata: tool, role: "assistant", tc: 1700, sid: "middle", rid: 4 },
        {
          pdata: JSON.stringify({ type: "step-start" }),
          role: "assistant",
          tc: 2000,
          sid: "middle",
          rid: 5,
        },
        text("middle", 6, 1800, ""),
        text("new", 7, 3000, "newest session"),
      ],
      [["middle", "/work/project"]],
    );

    const result = await new OpenCodeSource(dbPath).summaryWindow(1, 1);

    expect(result).toEqual({
      total: 3,
      sessions: [
        {
          id: "middle",
          source: "opencode",
          createdAt: 1500,
          updatedAt: 1700,
          messageCount: 3,
          snippetText: "fix the tool read",
          cwd: "/work/project",
        },
      ],
    });
  });

  it("preserves complete tool_call input", async () => {
    database([
      {
        pdata: JSON.stringify({
          type: "tool-invocation",
          toolName: "read",
          toolCallId: "tc1",
          args: "x".repeat(10000),
        }),
        role: "assistant",
        tc: 1000,
        sid: "s1",
        rid: 1,
      },
    ]);

    const source = new OpenCodeSource(dbPath);
    const messages = await collect(source);

    expect(messages).toHaveLength(1);
    expect(messages[0].blocks[0].type).toBe("tool_call");
    const block = messages[0].blocks[0] as { toolInput: string };
    expect(block.toolInput.length).toBe(10000);
  });

  it("preserves complete text blocks", async () => {
    database([
      {
        pdata: JSON.stringify({ type: "text", text: "y".repeat(10000) }),
        role: "user",
        tc: 1000,
        sid: "s1",
        rid: 1,
      },
    ]);

    const source = new OpenCodeSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text!.length).toBe(10000);
  });

  it("prefers string input when args uses a non-string representation", async () => {
    database([
      {
        pdata: JSON.stringify({
          type: "tool-call",
          name: "run",
          id: "tc1",
          args: { command: "stale" },
          input: '{"command":"current"}',
        }),
        role: "assistant",
        tc: 1000,
        sid: "s1",
        rid: 1,
      },
    ]);

    const messages = await collect(new OpenCodeSource(dbPath));

    expect(messages[0].blocks[0].toolInput).toBe('{"command":"current"}');
  });

  it.each([0, false])("preserves falsy tool values: %j", async (value) => {
    database([
      {
        pdata: JSON.stringify({
          type: "tool-invocation",
          toolName: "run",
          toolCallId: "tc1",
          args: value,
        }),
        role: "assistant",
        tc: 1000,
        sid: "s1",
        rid: 1,
      },
      {
        pdata: JSON.stringify({ type: "tool-result", toolCallId: "tc1", result: value }),
        role: "assistant",
        tc: 1001,
        sid: "s1",
        rid: 2,
      },
    ]);

    const messages = await collect(new OpenCodeSource(dbPath));

    expect(messages[0].blocks[0].toolInput).toBe(JSON.stringify(value));
    expect(messages[1].blocks[0].text).toBe(JSON.stringify(value));
  });

  it("always closes database connection", async () => {
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    new DatabaseSync(dbPath).close();
    close.mockClear();

    await expect(collect(new OpenCodeSource(dbPath))).rejects.toThrow("no such table");

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("serializes non-string args to JSON for tool_call", async () => {
    database([
      {
        pdata: JSON.stringify({
          type: "tool-invocation",
          toolName: "search",
          toolCallId: "tc-5",
          args: { query: "test", limit: 10 },
        }),
        role: "assistant",
        tc: 1700000000000,
        sid: "s1",
        rid: 1,
      },
    ]);

    const source = new OpenCodeSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].toolInput).toBe('{"query":"test","limit":10}');
  });
});
