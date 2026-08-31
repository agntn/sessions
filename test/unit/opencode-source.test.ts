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

vi.mock("../../src/core/env.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/env.ts")>();
  return { ...actual, osUser: () => "testuser" };
});

import { OpenCodeSource } from "../../src/sources/opencode.ts";

async function collect(source: Readonly<OpenCodeSource>): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const message of source.read()) messages.push(message);
  return messages;
}

describe("OpenCodeSource", () => {
  beforeEach(() => {
    executeMock.mockReset();
    closeMock.mockReset();
  });

  it("parses user text message with correct author", async () => {
    executeMock
      .mockResolvedValueOnce({
        rows: [
          {
            pdata: JSON.stringify({ type: "text", text: "hello from user" }),
            role: "user",
            tc: 1700000000000,
            sid: "session-1",
            rid: 1,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const source = new OpenCodeSource("/tmp/opencode.db");
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
    executeMock
      .mockResolvedValueOnce({
        rows: [
          {
            pdata: JSON.stringify({ type: "text", text: "assistant reply" }),
            role: "assistant",
            tc: 1700000001000,
            sid: "session-1",
            rid: 2,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const source = new OpenCodeSource("/tmp/opencode.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].author).toEqual({ platform: "cli", name: "opencode", isBot: true });
  });

  it("parses tool-invocation blocks", async () => {
    executeMock
      .mockResolvedValueOnce({
        rows: [
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
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const source = new OpenCodeSource("/tmp/opencode.db");
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
    executeMock
      .mockResolvedValueOnce({
        rows: [
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
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const source = new OpenCodeSource("/tmp/opencode.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0]).toEqual({
      type: "tool_call",
      toolName: "write_file",
      toolCallId: "tc-2",
      toolInput: '{"content":"hi"}',
    });
  });

  it("parses tool-result blocks", async () => {
    executeMock
      .mockResolvedValueOnce({
        rows: [
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
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const source = new OpenCodeSource("/tmp/opencode.db");
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
    executeMock
      .mockResolvedValueOnce({
        rows: [
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
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const source = new OpenCodeSource("/tmp/opencode.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe('{"ok":true,"lines":42}');
  });

  it("skips rows with invalid timestamps instead of throwing", async () => {
    executeMock
      .mockResolvedValueOnce({
        rows: [
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
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const source = new OpenCodeSource("/tmp/opencode.db");
    const messages = await collect(source);

    expect(messages).toHaveLength(1);
    expect(messages[0].timestamp).toBe(1700000000000);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("skips non-user/non-assistant roles", async () => {
    executeMock
      .mockResolvedValueOnce({
        rows: [
          {
            pdata: JSON.stringify({ type: "text", text: "system message" }),
            role: "system",
            tc: 1700000000000,
            sid: "s1",
            rid: 1,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const source = new OpenCodeSource("/tmp/opencode.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("skips text parts with empty text", async () => {
    executeMock
      .mockResolvedValueOnce({
        rows: [
          {
            pdata: JSON.stringify({ type: "text", text: "" }),
            role: "user",
            tc: 1700000000000,
            sid: "s1",
            rid: 1,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const source = new OpenCodeSource("/tmp/opencode.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("skips rows with malformed JSON pdata", async () => {
    executeMock
      .mockResolvedValueOnce({
        rows: [
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
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const source = new OpenCodeSource("/tmp/opencode.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("valid");
  });

  it("skips unknown part types", async () => {
    executeMock
      .mockResolvedValueOnce({
        rows: [
          {
            pdata: JSON.stringify({ type: "image", url: "https://example.com/img.png" }),
            role: "assistant",
            tc: 1700000000000,
            sid: "s1",
            rid: 1,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const source = new OpenCodeSource("/tmp/opencode.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("paginates through results using keyset cursor", async () => {
    executeMock
      .mockResolvedValueOnce({
        rows: [
          {
            pdata: JSON.stringify({ type: "text", text: "first" }),
            role: "user",
            tc: 1000,
            sid: "s1",
            rid: 10,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            pdata: JSON.stringify({ type: "text", text: "second" }),
            role: "assistant",
            tc: 2000,
            sid: "s1",
            rid: 20,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const source = new OpenCodeSource("/tmp/opencode.db");
    const messages = await collect(source);

    expect(messages).toHaveLength(2);
    expect(executeMock).toHaveBeenCalledTimes(3);
    const calls: readonly (readonly unknown[])[] = executeMock.mock.calls;
    expect(calls[1]?.[0]).toEqual(expect.objectContaining({ args: [1000, 1000, 10, 5000] }));
  });

  it("preserves complete tool_call input", async () => {
    executeMock
      .mockResolvedValueOnce({
        rows: [
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
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const source = new OpenCodeSource("/tmp/opencode.db");
    const messages = await collect(source);

    expect(messages).toHaveLength(1);
    expect(messages[0].blocks[0].type).toBe("tool_call");
    const block = messages[0].blocks[0] as { toolInput: string };
    expect(block.toolInput.length).toBe(10000);
  });

  it("preserves complete text blocks", async () => {
    executeMock
      .mockResolvedValueOnce({
        rows: [
          {
            pdata: JSON.stringify({ type: "text", text: "y".repeat(10000) }),
            role: "user",
            tc: 1000,
            sid: "s1",
            rid: 1,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const source = new OpenCodeSource("/tmp/opencode.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text!.length).toBe(10000);
  });

  it("prefers string input when args uses a non-string representation", async () => {
    executeMock
      .mockResolvedValueOnce({
        rows: [
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
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const messages = await collect(new OpenCodeSource("/tmp/opencode.db"));

    expect(messages[0].blocks[0].toolInput).toBe('{"command":"current"}');
  });

  it.each([0, false])("preserves falsy tool values: %j", async (value) => {
    executeMock
      .mockResolvedValueOnce({
        rows: [
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
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const messages = await collect(new OpenCodeSource("/tmp/opencode.db"));

    expect(messages[0].blocks[0].toolInput).toBe(JSON.stringify(value));
    expect(messages[1].blocks[0].text).toBe(JSON.stringify(value));
  });

  it("always closes database connection", async () => {
    executeMock.mockRejectedValueOnce(new Error("db error"));

    const source = new OpenCodeSource("/tmp/opencode.db");
    await expect(async () => {
      for await (const _ of source.read()) {
      }
    }).rejects.toThrow("db error");

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("serializes non-string args to JSON for tool_call", async () => {
    executeMock
      .mockResolvedValueOnce({
        rows: [
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
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const source = new OpenCodeSource("/tmp/opencode.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].toolInput).toBe('{"query":"test","limit":10}');
  });
});
