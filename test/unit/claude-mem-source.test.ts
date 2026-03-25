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

import { ClaudeMemSource } from "../../src/sources/claude-mem.ts";
import type { Message } from "../../src/core/types.ts";

// With windowed queries the flow is:
// obs window 1 → obs window 2 (empty = done) → sum window 1 → sum window 2 (empty = done)

describe("ClaudeMemSource", () => {
  beforeEach(() => {
    executeMock.mockReset();
    closeMock.mockReset();
  });

  it("ingests observations with title, narrative, and text", async () => {
    executeMock
      // obs window 1: data
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            memory_session_id: "sess-1",
            project: "myproject",
            text: "raw observation text",
            type: "discovery",
            title: "Found a bug",
            subtitle: "in auth module",
            narrative: "The auth module has a race condition",
            facts: '["race condition in login"]',
            concepts: '["concurrency"]',
            files_read: '["src/auth.ts"]',
            files_modified: '["src/auth.ts"]',
            created_at_epoch: 1700000000000,
          },
        ],
      })
      // obs window 2: empty (< WINDOW so loop ends)
      // sum window 1: empty
      .mockResolvedValueOnce({ rows: [] });

    const source = new ClaudeMemSource("/tmp/test.db");
    const msgs: Message[] = [];
    for await (const m of source.ingest("0")) msgs.push(m);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].source).toBe("claude-mem");
    expect(msgs[0].sessionId).toBe("sess-1");
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].timestamp).toBe(1700000000000);
    expect(msgs[0].blocks).toHaveLength(6);
    expect(msgs[0].blocks[0]).toEqual({ type: "title", text: "Found a bug" });
    expect(msgs[0].blocks[1]).toEqual({ type: "subtitle", text: "in auth module" });
    expect(msgs[0].blocks[2]).toEqual({ type: "narrative", text: "The auth module has a race condition" });
    expect(msgs[0].blocks[3]).toEqual({ type: "text", text: "raw observation text" });
    expect(msgs[0].blocks[4]).toEqual({ type: "facts", text: '["race condition in login"]' });
    expect(msgs[0].blocks[5]).toEqual({ type: "concepts", text: '["concurrency"]' });
    expect(msgs[0].context?.project).toBe("myproject");
    expect(msgs[0].context?.observationType).toBe("discovery");
  });

  it("ingests session summaries", async () => {
    executeMock
      // obs window 1: empty
      .mockResolvedValueOnce({ rows: [] })
      // sum window 1: data
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            memory_session_id: "sess-2",
            project: "webapp",
            request: "Fix login page",
            investigated: "Auth flow and session handling",
            learned: "Sessions expire after 30min",
            completed: "Added refresh token logic",
            next_steps: "Add tests",
            files_read: '["src/login.ts"]',
            files_edited: '["src/auth.ts"]',
            notes: null,
            created_at_epoch: 1700000100000,
          },
        ],
      });
    // sum has <WINDOW rows so no second sum query needed

    const source = new ClaudeMemSource("/tmp/test.db");
    const msgs: Message[] = [];
    for await (const m of source.ingest("0")) msgs.push(m);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks).toHaveLength(5);
    expect(msgs[0].blocks[0]).toEqual({ type: "request", text: "Fix login page" });
    expect(msgs[0].blocks[1]).toEqual({ type: "investigated", text: "Auth flow and session handling" });
    expect(msgs[0].blocks[2]).toEqual({ type: "learned", text: "Sessions expire after 30min" });
    expect(msgs[0].blocks[3]).toEqual({ type: "completed", text: "Added refresh token logic" });
    expect(msgs[0].blocks[4]).toEqual({ type: "next_steps", text: "Add tests" });
    expect(msgs[0].channel?.type).toBe("summary");
    expect(msgs[0].context?.observationType).toBe("summary");
  });

  it("filters by cursor timestamp", async () => {
    executeMock
      // obs window 1: empty
      .mockResolvedValueOnce({ rows: [] })
      // sum window 1: empty
      .mockResolvedValueOnce({ rows: [] });

    const source = new ClaudeMemSource("/tmp/test.db");
    for await (const _ of source.ingest("1700000000000")) {
    }

    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(executeMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ args: [1700000000000, 100, 0] }),
    );
    expect(executeMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ args: [1700000000000, 100, 0] }),
    );
  });

  it("skips observations with no text content", async () => {
    executeMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            memory_session_id: "sess-3",
            project: null,
            text: null,
            type: null,
            title: null,
            subtitle: null,
            narrative: null,
            facts: null,
            concepts: null,
            files_read: null,
            files_modified: null,
            created_at_epoch: 1700000000000,
          },
        ],
      })
      // sum window 1: empty
      .mockResolvedValueOnce({ rows: [] });

    const source = new ClaudeMemSource("/tmp/test.db");
    const msgs: Message[] = [];
    for await (const m of source.ingest("0")) msgs.push(m);

    expect(msgs).toHaveLength(0);
  });

  it("closes database connection on completion", async () => {
    executeMock.mockResolvedValue({ rows: [] });

    const source = new ClaudeMemSource("/tmp/test.db");
    for await (const _ of source.ingest("0")) {
    }

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("closes database connection on error", async () => {
    executeMock.mockRejectedValueOnce(new Error("db error"));

    const source = new ClaudeMemSource("/tmp/test.db");
    const drain = async () => {
      for await (const _ of source.ingest("0")) {
      }
    };
    await expect(drain()).rejects.toThrow("db error");

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("estimate() returns sum of pending observations and summaries", async () => {
    executeMock
      .mockResolvedValueOnce({ rows: [{ c: 10 }] })
      .mockResolvedValueOnce({ rows: [{ c: 5 }] });

    const source = new ClaudeMemSource("/tmp/test.db");
    const count = await source.estimate("1700000000000");

    expect(count).toBe(15);
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(executeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ args: [1700000000000] }));
    expect(executeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ args: [1700000000000] }));
  });

  it("cursor returns timestamp string", () => {
    const source = new ClaudeMemSource("/tmp/test.db");
    expect(
      source.cursor({
        source: "claude-mem",
        sessionId: "s1",
        role: "assistant",
        timestamp: 1700000000000,
        date: "2023-11-14",
        blocks: [{ type: "text", text: "test" }],
      }),
    ).toBe("1700000000000");
  });
});
