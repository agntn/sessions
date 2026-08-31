import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/core/types.ts";

const { executeMock, closeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock("@libsql/client", () => ({
  createClient: () => ({
    execute: executeMock,
    close: closeMock,
  }),
}));

import { MastraSource } from "../../src/sources/mastra.ts";

async function collect(source: Readonly<MastraSource>): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const m of source.read()) messages.push(m);
  return messages;
}

describe("MastraSource", () => {
  beforeEach(() => {
    executeMock.mockReset();
    closeMock.mockReset();
  });

  it("parses user message with correct fields", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          rowId: 1,
          role: "user",
          content: "hello from user",
          createdAt: "2026-03-10T12:00:00.000Z",
          thread_id: "thread-1",
        },
      ],
    });

    const source = new MastraSource("/tmp/mastra.db");
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
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0]?.[0]).toHaveProperty("args", []);
    expect(executeMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "sql",
      expect.stringContaining("createdAt >"),
    );
  });

  it("parses assistant message with bot author", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          rowId: 2,
          role: "assistant",
          content: "assistant reply",
          createdAt: "2026-03-10T12:01:00.000Z",
          thread_id: "thread-1",
        },
      ],
    });

    const source = new MastraSource("/tmp/mastra.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].author).toEqual({ platform: "cli", name: "mastra", isBot: true });
  });

  it("parses format 2 content with text parts", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
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
        },
      ],
    });

    const source = new MastraSource("/tmp/mastra.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks).toEqual([
      { type: "text", text: "first part" },
      { type: "text", text: "second part" },
    ]);
  });

  it("reads the call fields and the result out of a nested toolInvocation part", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
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
        },
      ],
    });

    const msgs = await collect(new MastraSource("/tmp/mastra.db"));

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
    executeMock.mockResolvedValueOnce({
      rows: [
        {
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
        },
      ],
    });

    const source = new MastraSource("/tmp/mastra.db");
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
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          rowId: 1,
          role: "user",
          content: "malformed-json-content",
          createdAt: "2026-03-10T12:00:00.000Z",
          thread_id: "thread-1",
        },
      ],
    });

    const source = new MastraSource("/tmp/mastra.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks).toEqual([{ type: "text", text: "malformed-json-content" }]);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("skips rows with empty content", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          rowId: 5,
          role: "user",
          content: "",
          createdAt: "2026-03-10T12:00:00.000Z",
          thread_id: "thread-1",
        },
      ],
    });

    const source = new MastraSource("/tmp/mastra.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("skips rows with non-finite timestamp", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          rowId: 6,
          role: "user",
          content: "good content",
          createdAt: "invalid-date",
          thread_id: "thread-1",
        },
      ],
    });

    const source = new MastraSource("/tmp/mastra.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("skips rows with missing date part", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          rowId: 7,
          role: "user",
          content: "content",
          createdAt: "",
          thread_id: "thread-1",
        },
      ],
    });

    const source = new MastraSource("/tmp/mastra.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("includes mastraCreatedAt and mastraRowId in context", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          rowId: 42,
          role: "user",
          content: "test",
          createdAt: "2026-03-10T12:00:00.000Z",
          thread_id: "thread-1",
        },
      ],
    });

    const source = new MastraSource("/tmp/mastra.db");
    const msgs = await collect(source);

    expect(msgs[0].context).toEqual({
      mastraCreatedAt: "2026-03-10T12:00:00.000Z",
      mastraRowId: "42",
    });
  });

  it("always closes database connection", async () => {
    executeMock.mockRejectedValueOnce(new Error("db error"));

    const source = new MastraSource("/tmp/mastra.db");
    await expect(async () => {
      for await (const _ of source.read()) {
      }
    }).rejects.toThrow("db error");

    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
