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

import { MastraSource } from "../../src/sources/mastra.ts";

describe("MastraSource", () => {
  beforeEach(() => {
    executeMock.mockReset();
    closeMock.mockReset();
  });

  it("falls back to raw text when content is malformed JSON", async () => {
    executeMock.mockResolvedValue({
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
    const messages = [] as Awaited<ReturnType<MastraSource["ingest"]>> extends AsyncGenerator<
      infer T
    >
      ? T[]
      : never;

    for await (const message of source.ingest("")) {
      messages.push(message);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0].blocks).toEqual([{ type: "text", text: "malformed-json-content" }]);
    expect(messages[0].date).toBe("2026-03-10");
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes non-finite cursor row id to zero", async () => {
    executeMock.mockResolvedValue({ rows: [] });

    const source = new MastraSource("/tmp/mastra.db");
    for await (const _ of source.ingest("2026-03-01T00:00:00.000Z|Infinity")) {
    }

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z", 0],
      }),
    );
  });

  it("falls back to epoch cursor date when createdAt cursor part is invalid", async () => {
    executeMock.mockResolvedValue({ rows: [] });

    const source = new MastraSource("/tmp/mastra.db");
    for await (const _ of source.ingest("not-a-date|7")) {
    }

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["1970-01-01", "1970-01-01", 7],
      }),
    );
  });
});
