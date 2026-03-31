import { describe, it, expect } from "vitest";
import { ingest, BATCH_SIZE } from "../../src/core/ingest.ts";
import type { Source, Storage, Message } from "../../src/core/types.ts";

function makeSource(name: string, messages: Message[]): Source {
  return {
    name,
    available: () => true,
    async *ingest() {
      for (const m of messages) yield m;
    },
    cursor: (msg) => String(msg.timestamp),
  };
}

function makeFailingMidwaySource(name: string): Source {
  return {
    name,
    available: () => true,
    async *ingest() {
      yield {
        source: name,
        sessionId: "1",
        role: "user",
        timestamp: 100,
        date: "2026-03-14",
        blocks: [],
      };
      throw new Error("Midway failure in " + name);
    },
    cursor: () => "0",
  };
}

function makeStorage(): Storage {
  const cursors = new Map<string, string>();
  return {
    async init() {},
    async close() {},
    async createSession() {},
    async getSession() {
      return null;
    },
    async listSessions() {
      return [];
    },
    async deleteSession() {},
    async addMessage() {
      return crypto.randomUUID();
    },
    async getMessage() {
      return null;
    },
    async getMessages() {
      return [];
    },
    async insert() {},
    async getCursor(source) {
      return cursors.get(source) ?? "0";
    },
    async getCursorState(source) {
      return { cursor: cursors.get(source) ?? "0", lastRun: null };
    },
    async setCursor(source, cursor) {
      cursors.set(source, cursor);
    },
    async listCursors() {
      return [];
    },
    async deleteCursor() {},
    async deleteBySource() {
      return 0;
    },
    async purgeSource() {
      return 0;
    },
    async count() {
      return 0;
    },
    async search() {
      return [];
    },
    async sessionCount() {
      return 0;
    },
    async sourceStats() {
      return [];
    },
    async getParticipant() {
      return null;
    },
    async findParticipant() {
      return null;
    },
    async listParticipants() {
      return [];
    },
    async getSessionParticipants() {
      return [];
    },
    async getChannel() {
      return null;
    },
    async findChannel() {
      return null;
    },
    async listChannels() {
      return [];
    },
  };
}

describe("ingest error handling", () => {
  it("continues with other sources when one source fails and reports partial count", async () => {
    const storage = makeStorage();
    await storage.setCursor("s2", "50");

    const s1 = makeSource("s1", [
      {
        source: "s1",
        sessionId: "1",
        role: "user",
        timestamp: 100,
        date: "2026-03-14",
        blocks: [],
      },
    ]);
    const s2 = makeFailingMidwaySource("s2");
    const s3 = makeSource("s3", [
      {
        source: "s3",
        sessionId: "2",
        role: "user",
        timestamp: 200,
        date: "2026-03-14",
        blocks: [],
      },
    ]);

    const results = await ingest([s1, s2, s3], storage);

    expect(results).toHaveLength(3);

    expect(results[0].source).toBe("s1");
    expect(results[0].count).toBe(1);

    expect(results[1].source).toBe("s2");
    expect(results[1].count).toBe(1); // partial batch flushed on error
    expect(results[1].cursor).toBe("0"); // cursor advanced to partial progress
    expect(results[1].error).toBe("Midway failure in s2");

    expect(results[2].source).toBe("s3");
    expect(results[2].count).toBe(1);
  });

  it("flushes partial batch and advances cursor on mid-ingestion error", async () => {
    const storage = makeStorage();
    const inserted: Message[] = [];
    storage.insert = async (batch) => {
      inserted.push(...batch);
    };

    const source: Source = {
      name: "partial",
      available: () => true,
      async *ingest() {
        yield {
          source: "partial",
          sessionId: "1",
          role: "user",
          timestamp: 500,
          date: "2026-03-14",
          blocks: [{ type: "text", text: "saved before crash" }],
        };
        yield {
          source: "partial",
          sessionId: "1",
          role: "assistant",
          timestamp: 600,
          date: "2026-03-14",
          blocks: [{ type: "text", text: "also saved" }],
        };
        throw new Error("source crashed");
      },
      cursor: (msg) => String(msg.timestamp),
    };

    const results = await ingest([source], storage);

    expect(results[0].count).toBe(2);
    expect(results[0].cursor).toBe("600");
    expect(results[0].error).toBe("source crashed");
    expect(inserted).toHaveLength(2);
    expect(await storage.getCursor("partial")).toBe("600");
  });

  it("reports error when storage.insert() fails on final flush", async () => {
    const storage = makeStorage();
    storage.insert = async () => {
      throw new Error("disk full");
    };

    const source = makeSource("s1", [
      {
        source: "s1",
        sessionId: "1",
        role: "user",
        timestamp: 100,
        date: "2026-03-14",
        blocks: [{ type: "text", text: "test" }],
      },
    ]);

    const results = await ingest([source], storage);

    expect(results[0].error).toBe("disk full");
    expect(results[0].count).toBe(0);
  });

  it("reports recovery failure when cleanup insert also fails", async () => {
    const storage = makeStorage();
    let insertCount = 0;
    storage.insert = async () => {
      insertCount++;
      throw new Error(insertCount === 1 ? "first fail" : "recovery fail");
    };

    const errors: string[] = [];
    const source: Source = {
      name: "s1",
      available: () => true,
      async *ingest() {
        for (let i = 0; i < BATCH_SIZE + 1; i++) {
          yield {
            source: "s1",
            sessionId: "1",
            role: "user",
            timestamp: 100 + i,
            date: "2026-03-14",
            blocks: [],
          };
        }
      },
      cursor: () => "0",
    };

    const results = await ingest([source], storage, {
      onSourceError: (_s, err) => errors.push(err),
    });

    expect(results[0].error).toBe("first fail");
    expect(errors.some((e) => e.includes("recovery failed"))).toBe(true);
  });

  it("does not advance cursor when storage.insert fails in error handler", async () => {
    const storage = makeStorage();
    let insertCallCount = 0;
    storage.insert = async () => {
      insertCallCount++;
      if (insertCallCount > 1) throw new Error("insert failed in cleanup");
    };

    const source: Source = {
      name: "s1",
      available: () => true,
      async *ingest() {
        for (let i = 0; i < BATCH_SIZE; i++) {
          yield {
            source: "s1",
            sessionId: "1",
            role: "user",
            timestamp: 100 + i,
            date: "2026-03-14",
            blocks: [],
          };
        }
        yield {
          source: "s1",
          sessionId: "1",
          role: "user",
          timestamp: 9999,
          date: "2026-03-14",
          blocks: [],
        };
        throw new Error("source error");
      },
      cursor: (msg) => String(msg.timestamp),
    };

    const results = await ingest([source], storage);

    expect(results[0].error).toBe("source error");
    // First batch succeeded, so cursor should reflect that
    const cursor = await storage.getCursor("s1");
    expect(cursor).not.toBe("0"); // cursor was set after successful first batch
  });

  it("reports count of successfully inserted batches even when failure happens later", async () => {
    const storage = makeStorage();
    let batchInserted = 0;
    storage.insert = async (batch) => {
      batchInserted += batch.length;
    };

    const s1: Source = {
      name: "s1",
      available: () => true,
      async *ingest() {
        // Yield exactly BATCH_SIZE messages
        for (let i = 0; i < BATCH_SIZE; i++) {
          yield {
            source: "s1",
            sessionId: "1",
            role: "user",
            timestamp: 100 + i,
            date: "2026-03-14",
            blocks: [],
          };
        }
        // Then fail before the final flush or next yield
        throw new Error("Failure after first batch");
      },
      cursor: () => "0",
    };

    const results = await ingest([s1], storage);
    expect(results[0].count).toBe(BATCH_SIZE);
    expect(batchInserted).toBe(BATCH_SIZE);
    expect(results[0].error).toBe("Failure after first batch");
  });
});
