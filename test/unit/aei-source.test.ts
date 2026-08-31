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

const ALL_EXTRA_MSG_COLS = [
  "cwd",
  "git_branch",
  "git_commit",
  "git_worktree",
  "git_dirty",
  "model",
  "sender_id",
];
const ALL_SESSION_COLS = ["id", "project", "git_remote", "hostname", "os_user", "initiator_id"];

function mockPragma(
  msgCols: readonly string[] = ALL_EXTRA_MSG_COLS,
  sesCols: readonly string[] = ALL_SESSION_COLS,
): void {
  const msgBaseRows = ["id", "session_id", "role", "timestamp", "date", "source"].map((name) => ({
    name,
  }));
  const msgExtraRows = msgCols.map((name) => ({ name }));
  executeMock.mockResolvedValueOnce({ rows: [...msgBaseRows, ...msgExtraRows] });
  const sesRows = sesCols.map((name) => ({ name }));
  executeMock.mockResolvedValueOnce({ rows: sesRows });
}

function mockMessagesAndBlocks(
  messages: readonly Readonly<Record<string, unknown>>[],
  blocksByMessage: readonly (readonly Readonly<Record<string, unknown>>[])[],
): void {
  executeMock.mockResolvedValueOnce({ rows: messages });
  const allBlocks: Record<string, unknown>[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msgId = messages[i].id;
    const msgBlocks = blocksByMessage[i] ?? [];
    for (const block of msgBlocks) {
      allBlocks.push({ message_id: msgId, ...block });
    }
  }
  executeMock.mockResolvedValueOnce({ rows: allBlocks });
}

async function collect(source: Readonly<AeiSource>): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const m of source.read()) messages.push(m);
  return messages;
}

describe("AeiSource", () => {
  beforeEach(() => {
    executeMock.mockReset();
    closeMock.mockReset();
  });

  it("parses user message with rich context", async () => {
    mockPragma();
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
      aeiMsgId: "1",
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
    mockPragma();
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
    mockPragma();
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
    mockPragma();
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
    mockPragma();
    mockMessagesAndBlocks(
      [
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
      [
        [
          {
            position: 0,
            type: "text",
            text: "system msg",
            tool_name: null,
            tool_input: null,
            tool_call_id: null,
          },
        ],
      ],
    );

    const source = new AeiSource("/tmp/aei.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("skips messages with non-finite timestamp", async () => {
    mockPragma();
    mockMessagesAndBlocks(
      [
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
      [
        [
          {
            position: 0,
            type: "text",
            text: "bad timestamp",
            tool_name: null,
            tool_input: null,
            tool_call_id: null,
          },
        ],
      ],
    );

    const source = new AeiSource("/tmp/aei.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("advances keyset across two pages sharing the same timestamp", async () => {
    mockPragma();
    // Page 1: exactly 500 rows (WINDOW) at the same timestamp, ending at id=500
    const page1Rows = Array.from({ length: 500 }, (_, i) => ({
      id: i + 1,
      session_id: "s1",
      role: "user",
      timestamp: 1710000000000,
      date: "2026-03-10",
    }));
    const page1Blocks = page1Rows.map(() => [{ position: 0, type: "text", text: "x" }]);
    mockMessagesAndBlocks(page1Rows, page1Blocks);
    // Page 2: next row at same timestamp, id=501
    mockMessagesAndBlocks(
      [{ id: 501, session_id: "s1", role: "user", timestamp: 1710000000000, date: "2026-03-10" }],
      [[{ position: 0, type: "text", text: "y" }]],
    );

    const source = new AeiSource("/tmp/aei.db");
    const msgs = await collect(source);

    expect(msgs).toHaveLength(501);
    // Page 2 query should advance keyset to (1710000000000, 500)
    expect(executeMock).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        args: [1710000000000, 1710000000000, 500, 500],
      }),
    );
  });

  it("includes only aeiMsgId in context when all other fields are null", async () => {
    mockPragma();
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
    expect(msgs[0].context).toEqual({ aeiMsgId: "7" });
  });

  it("falls back to date from timestamp when row.date is null", async () => {
    mockPragma();
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
      for await (const _ of source.read()) {
        // consume
      }
    }).rejects.toThrow("db error");

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("handles missing columns gracefully", async () => {
    // Simulate older schema without cwd, git_worktree, model columns and some session cols
    mockPragma(["git_branch", "git_commit", "git_dirty", "sender_id"], ["id", "project"]);
    mockMessagesAndBlocks(
      [
        {
          id: 9,
          session_id: "ses-9",
          role: "user",
          timestamp: 1710000006000,
          date: "2026-03-10",
          git_branch: "feat",
          git_commit: "def456",
          git_dirty: 0,
          sender_id: "ori",
          project: "test",
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
            text: "old schema",
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
    expect(msgs[0].context).toEqual({
      aeiMsgId: "9",
      git_branch: "feat",
      git_commit: "def456",
      git_dirty: "0",
      sender_id: "ori",
      project: "test",
    });
    // cwd, git_worktree, model not in context since not in schema
    expect(msgs[0].context!.cwd).toBeUndefined();
    expect(msgs[0].context!.model).toBeUndefined();
  });
});
