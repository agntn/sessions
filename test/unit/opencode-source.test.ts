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
    executeMock.mockResolvedValue({
      rows: [
        {
          pdata: JSON.stringify({ type: "text", text: "bad" }),
          role: "user",
          tc: "invalid",
          sid: "s1",
        },
        {
          pdata: JSON.stringify({ type: "text", text: "good message" }),
          role: "assistant",
          tc: 1700000000000,
          sid: "s1",
        },
      ],
    });

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
        args: [0],
      }),
    );
  });
});
