import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { AeiSource } from "../../src/sources/aei.ts";
import type { Message } from "../../src/core/types.ts";

function mockMessagesAndBlocks(
  messages: Record<string, unknown>[],
  blocksByMessage: Record<string, unknown>[][],
): void {
  executeMock.mockResolvedValueOnce({ rows: messages });
  for (const blocks of blocksByMessage) {
    executeMock.mockResolvedValueOnce({ rows: blocks });
  }
}

async function collect(source: AeiSource, cursor = "0"): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const m of source.ingest(cursor)) messages.push(m);
  return messages;
}

describe("AeiSource", () => {
  beforeEach(() => {
    executeMock.mockReset();
    closeMock.mockReset();
  });

  it("parses user message with rich context", async () => {
    mockMessagesAndBlocks(
      [
        {
          id: 1,
          session_id: "ses-1",
          role: "user",
          timestamp: 1710000000000,
          date: "2026-03-10",
          cwd: "/home/user/project",
          git_branch: "main",
          git_commit: "abc123",
          git_worktree: null,
          git_dirty: 1,
          model: "claude-opus-4-0-20250514",
          sender_id: "ori",
          project: "memxa",
          git_remote: "github.com/oritwoen/memxa",
          hostname: "arch",
          os_user: "oritwoen",
          initiator_id: null,
        },
      ],
      [
        [
          {
            position: 0,
            type: "text",
            text: "hello world",
            tool_name: null,
            tool_input: null,
            tool_call_id: null,
          },
        ],
      ],
    );

    const source = new AeiSource("/tmp/aei.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].source).toBe("aei");
    expect(msgs[0].sessionId).toBe("ses-1");
    expect(msgs[0].timestamp).toBe(1710000000000);
    expect(msgs[0].date).toBe("2026-03-10");
    expect(msgs[0].blocks).toEqual([{ type: "text", text: "hello world" }]);
    expect(msgs[0].context).toEqual({
      cwd: "/home/user/project",
      git_branch: "main",
      git_commit: "abc123",
      git_dirty: "1",
      model: "claude-opus-4-0-20250514",
      sender_id: "ori",
      project: "memxa",
      git_remote: "github.com/oritwoen/memxa",
      hostname: "arch",
      os_user: "oritwoen",
    });
  });

  it("parses assistant message with correct author", async () => {
    mockMessagesAndBlocks(
      [
        {
          id: 2,
          session_id: "ses-2",
          role: "assistant",
          timestamp: 1710000001000,
          date: "2026-03-10",
          cwd: null,
          git_branch: null,
          git_commit: null,
          git_worktree: null,
          git_dirty: null,
          model: null,
          sender_id: "aei",
          project: null,
          git_remote: null,
          hostname: null,
          os_user: null,
          initiator_id: null,
        },
      ],
      [
        [
          {
            position: 0,
            type: "text",
            text: "assistant reply",
            tool_name: null,
            tool_input: null,
            tool_call_id: null,
          },
        ],
      ],
    );

    const source = new AeiSource("/tmp/aei.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].author).toEqual({ platform: "cli", name: "aei", isBot: true });
  });

  it("parses tool_call blocks", async () => {
    mockMessagesAndBlocks(
      [
        {
          id: 3,
          session_id: "ses-3",
          role: "assistant",
          timestamp: 1710000002000,
          date: "2026-03-10",
          cwd: null,
          git_branch: null,
          git_commit: null,
          git_worktree: null,
          git_dirty: null,
          model: null,
          sender_id: null,
          project: null,
          git_remote: null,
          hostname: null,
          os_user: null,
          initiator_id: null,
        },
      ],
      [
        [
          {
            position: 0,
            type: "tool_call",
            text: null,
            tool_name: "read_file",
            tool_input: '{"path":"/foo"}',
            tool_call_id: "call-1",
          },
        ],
      ],
    );

    const source = new AeiSource("/tmp/aei.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0]).toEqual({
      type: "tool_call",
      toolName: "read_file",
      toolInput: '{"path":"/foo"}',
      toolCallId: "call-1",
    });
  });

  it("skips messages with no blocks", async () => {
    mockMessagesAndBlocks(
      [
        {
          id: 4,
          session_id: "ses-4",
          role: "user",
          timestamp: 1710000003000,
          date: "2026-03-10",
          cwd: null,
          git_branch: null,
          git_commit: null,
          git_worktree: null,
          git_dirty: null,
          model: null,
          sender_id: null,
          project: null,
          git_remote: null,
          hostname: null,
          os_user: null,
          initiator_id: null,
        },
      ],
      [[]],
    );

    const source = new AeiSource("/tmp/aei.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("skips messages with invalid role", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          id: 5,
          session_id: "ses-5",
          role: "system",
          timestamp: 1710000004000,
          date: "2026-03-10",
          cwd: null,
          git_branch: null,
          git_commit: null,
          git_worktree: null,
          git_dirty: null,
          model: null,
          sender_id: null,
          project: null,
          git_remote: null,
          hostname: null,
          os_user: null,
          initiator_id: null,
        },
      ],
    });

    const source = new AeiSource("/tmp/aei.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("skips messages with non-finite timestamp", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          id: 6,
          session_id: "ses-6",
          role: "user",
          timestamp: "invalid",
          date: "2026-03-10",
          cwd: null,
          git_branch: null,
          git_commit: null,
          git_worktree: null,
          git_dirty: null,
          model: null,
          sender_id: null,
          project: null,
          git_remote: null,
          hostname: null,
          os_user: null,
          initiator_id: null,
        },
      ],
    });

    const source = new AeiSource("/tmp/aei.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("passes cursor as since parameter to SQL", async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });

    const source = new AeiSource("/tmp/aei.db");
    await collect(source, "1710000000000");

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [1710000000000],
      }),
    );
  });

  it("cursor() returns last message timestamp as string", () => {
    const source = new AeiSource("/tmp/aei.db");
    const msgs: Message[] = [
      {
        source: "aei",
        sessionId: "s1",
        role: "user",
        timestamp: 100,
        date: "1970-01-01",
        blocks: [{ type: "text", text: "a" }],
      },
      {
        source: "aei",
        sessionId: "s1",
        role: "user",
        timestamp: 300,
        date: "1970-01-01",
        blocks: [{ type: "text", text: "b" }],
      },
    ];

    expect(source.cursor(msgs)).toBe("300");
    expect(source.cursor([])).toBe("0");
  });

  it("omits context when all fields are null", async () => {
    mockMessagesAndBlocks(
      [
        {
          id: 7,
          session_id: "ses-7",
          role: "user",
          timestamp: 1710000005000,
          date: "2026-03-10",
          cwd: null,
          git_branch: null,
          git_commit: null,
          git_worktree: null,
          git_dirty: null,
          model: null,
          sender_id: null,
          project: null,
          git_remote: null,
          hostname: null,
          os_user: null,
          initiator_id: null,
        },
      ],
      [
        [
          {
            position: 0,
            type: "text",
            text: "no context msg",
            tool_name: null,
            tool_input: null,
            tool_call_id: null,
          },
        ],
      ],
    );

    const source = new AeiSource("/tmp/aei.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].context).toBeUndefined();
  });

  it("falls back to date from timestamp when row.date is null", async () => {
    mockMessagesAndBlocks(
      [
        {
          id: 8,
          session_id: "ses-8",
          role: "user",
          timestamp: 1710000000000,
          date: null,
          cwd: null,
          git_branch: null,
          git_commit: null,
          git_worktree: null,
          git_dirty: null,
          model: null,
          sender_id: null,
          project: null,
          git_remote: null,
          hostname: null,
          os_user: null,
          initiator_id: null,
        },
      ],
      [
        [
          {
            position: 0,
            type: "text",
            text: "fallback date",
            tool_name: null,
            tool_input: null,
            tool_call_id: null,
          },
        ],
      ],
    );

    const source = new AeiSource("/tmp/aei.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].date).toBe(new Date(1710000000000).toISOString().split("T")[0]);
  });

  it("always closes database connection", async () => {
    executeMock.mockRejectedValueOnce(new Error("db error"));

    const source = new AeiSource("/tmp/aei.db");
    await expect(async () => {
      for await (const _ of source.ingest("0")) {
        // consume
      }
    }).rejects.toThrow("db error");

    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
