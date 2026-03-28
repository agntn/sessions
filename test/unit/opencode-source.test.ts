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

import { OpenCodeSource } from "../../src/sources/opencode.ts";

describe("OpenCodeSource", () => {
  beforeEach(() => {
    executeMock.mockReset();
    closeMock.mockReset();
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
    const messages: Message[] = [];
    for await (const message of source.ingest("0")) {
      messages.push(message);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0].timestamp).toBe(1700000000000);
    expect(messages[0].date).toBe("2023-11-14");
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("treats non-finite cursor values as zero", async () => {
    executeMock.mockResolvedValue({ rows: [] });

    const source = new OpenCodeSource("/tmp/opencode.db");
    for await (const _ of source.ingest("Infinity")) {
    }

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [0, 0, 0, 5000],
      }),
    );
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
    const messages: Message[] = [];
    for await (const message of source.ingest("0")) {
      messages.push(message);
    }

    expect(messages).toHaveLength(2);
    expect(executeMock).toHaveBeenCalledTimes(3);
    // Second call should use keyset from first page
    expect(executeMock.mock.calls[1][0].args).toEqual([1000, 1000, 10, 5000]);
  });

  it("truncates tool_call input at 8000 chars", async () => {
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
    const messages: Message[] = [];
    for await (const message of source.ingest("0")) {
      messages.push(message);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0].blocks[0].type).toBe("tool_call");
    const block = messages[0].blocks[0] as { toolInput: string };
    expect(block.toolInput.length).toBe(8000);
  });
});
