import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Message } from "../../src/core/types.ts";
import { MastraSource } from "../../src/sources/mastra.ts";

/** One `mastra_messages` row as the reader selects it, with `rowId` as its rowid. */
interface Row {
  readonly rowId: number;
  readonly role: string;
  readonly content: string;
  readonly createdAt: string;
  readonly thread_id: string;
}

let directory: string;
let dbPath: string;

/* Writes the rows into a real Mastra Code database. */
function database(...rows: readonly Row[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mastra_messages (id TEXT, thread_id TEXT, content TEXT, role TEXT,
        type TEXT, createdAt TEXT, resourceId TEXT);
      CREATE TABLE IF NOT EXISTS mastra_threads (id TEXT PRIMARY KEY, resourceId TEXT, title TEXT,
        metadata TEXT);
    `);
    const insert = db.prepare(
      "INSERT INTO mastra_messages (rowid, id, thread_id, content, role, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const { rowId, role, content, createdAt, thread_id } of rows) {
      insert.run(rowId, String(rowId), thread_id, content, role, createdAt);
    }
  } finally {
    db.close();
  }
}

async function collect(source: Readonly<MastraSource>): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const m of source.read()) messages.push(m);
  return messages;
}

describe("MastraSource", () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "sessions-mastra-"));
    dbPath = join(directory, "mastra.db");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it("parses user message with correct fields", async () => {
    database({
      rowId: 1,
      role: "user",
      content: "hello from user",
      createdAt: "2026-03-10T12:00:00.000Z",
      thread_id: "thread-1",
    });

    const source = new MastraSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].source).toBe("mastra");
    expect(msgs[0].sessionId).toBe("thread-1");
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].date).toBe("2026-03-10");
    expect(msgs[0].timestamp).toBe(new Date("2026-03-10T12:00:00.000Z").getTime());
    expect(msgs[0].blocks).toEqual([{ type: "text", text: "hello from user" }]);
    expect(msgs[0].author?.isBot).toBeUndefined();
    expect(msgs[0].channel?.name).toBe("mastra");
  });

  it("parses assistant message with bot author", async () => {
    database({
      rowId: 2,
      role: "assistant",
      content: "assistant reply",
      createdAt: "2026-03-10T12:01:00.000Z",
      thread_id: "thread-1",
    });

    const source = new MastraSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].author).toEqual({ platform: "cli", name: "mastra", isBot: true });
  });

  it("parses format 2 content with text parts", async () => {
    database({
      rowId: 3,
      role: "assistant",
      content: JSON.stringify({
        format: 2,
        parts: [
          { type: "text", text: "first part" },
          { type: "text", text: "second part" },
        ],
      }),
      createdAt: "2026-03-10T12:02:00.000Z",
      thread_id: "thread-1",
    });

    const source = new MastraSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks).toEqual([
      { type: "text", text: "first part" },
      { type: "text", text: "second part" },
    ]);
  });

  it("reads the call fields and the result out of a nested toolInvocation part", async () => {
    database({
      rowId: 7,
      role: "assistant",
      content: JSON.stringify({
        format: 2,
        parts: [
          {
            type: "tool-invocation",
            toolInvocation: {
              state: "result",
              toolCallId: "call_1",
              toolName: "mastra_workspace_list_files",
              args: { path: "." },
              result: "README.md",
            },
          },
        ],
      }),
      createdAt: "2026-03-10T12:05:00.000Z",
      thread_id: "thread-1",
    });

    const msgs = await collect(new MastraSource(dbPath));

    expect(msgs[0].blocks).toEqual([
      {
        type: "tool_call",
        toolName: "mastra_workspace_list_files",
        toolCallId: "call_1",
        toolInput: '{"path":"."}',
      },
      { type: "tool_result", toolCallId: "call_1", text: "README.md" },
    ]);
  });

  it("parses format 2 tool-invocation and tool-result parts", async () => {
    database({
      rowId: 4,
      role: "assistant",
      content: JSON.stringify({
        format: 2,
        parts: [
          {
            type: "tool-invocation",
            toolName: "read_file",
            toolCallId: "tc-1",
            args: '{"path":"/foo"}',
          },
          {
            type: "tool-result",
            toolCallId: "tc-1",
            result: "file contents",
          },
        ],
      }),
      createdAt: "2026-03-10T12:03:00.000Z",
      thread_id: "thread-1",
    });

    const source = new MastraSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks).toEqual([
      {
        type: "tool_call",
        toolName: "read_file",
        toolCallId: "tc-1",
        toolInput: '{"path":"/foo"}',
      },
      {
        type: "tool_result",
        toolCallId: "tc-1",
        text: "file contents",
      },
    ]);
  });

  it("falls back to raw text when content is malformed JSON", async () => {
    database({
      rowId: 1,
      role: "user",
      content: "malformed-json-content",
      createdAt: "2026-03-10T12:00:00.000Z",
      thread_id: "thread-1",
    });

    const source = new MastraSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks).toEqual([{ type: "text", text: "malformed-json-content" }]);
  });

  it("skips rows with empty content", async () => {
    database({
      rowId: 5,
      role: "user",
      content: "",
      createdAt: "2026-03-10T12:00:00.000Z",
      thread_id: "thread-1",
    });

    const source = new MastraSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("skips rows with non-finite timestamp", async () => {
    database({
      rowId: 6,
      role: "user",
      content: "good content",
      createdAt: "invalid-date",
      thread_id: "thread-1",
    });

    const source = new MastraSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("skips rows with missing date part", async () => {
    database({
      rowId: 7,
      role: "user",
      content: "content",
      createdAt: "",
      thread_id: "thread-1",
    });

    const source = new MastraSource(dbPath);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("includes mastraCreatedAt and mastraRowId in context", async () => {
    database({
      rowId: 42,
      role: "user",
      content: "test",
      createdAt: "2026-03-10T12:00:00.000Z",
      thread_id: "thread-1",
    });

    const source = new MastraSource(dbPath);
    const msgs = await collect(source);

    expect(msgs[0].context).toEqual({
      mastraCreatedAt: "2026-03-10T12:00:00.000Z",
      mastraRowId: "42",
    });
  });

  it("always closes database connection", async () => {
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    new DatabaseSync(dbPath).close();
    close.mockClear();

    await expect(collect(new MastraSource(dbPath))).rejects.toThrow("no such table");

    expect(close).toHaveBeenCalledTimes(1);
  });
});
