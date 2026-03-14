import { describe, it, expect } from "vitest";
import { ingest } from "../../src/core/ingest.ts";
import type { Source, Storage, Message } from "../../src/core/types.ts";

function makeSource(name: string, messages: Message[]): Source {
  return {
    name,
    available: () => true,
    async *ingest() {
      for (const m of messages) yield m;
    },
    cursor: (msgs) => (msgs.length ? String(msgs[msgs.length - 1].timestamp) : "0"),
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
      return cursors.get(source) || "0";
    },
    async setCursor(source, cursor) {
      cursors.set(source, cursor);
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
    storage.setCursor("s2", "50");

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
    expect(results[1].count).toBe(0); // 0 because the message was yielded but never flushed before failure
    expect(results[1].cursor).toBe("50"); // Original cursor preserved
    expect(results[1].error).toBe("Midway failure in s2");

    expect(results[2].source).toBe("s3");
    expect(results[2].count).toBe(1);
    });

    it("reports count of successfully inserted batches even when failure happens later", async () => {
    const storage = makeStorage();
    let batchInserted = 0;
    storage.insert = async (batch) => { batchInserted += batch.length; };

    const s1: Source = {
      name: "s1",
      available: () => true,
      async *ingest() {
        // Yield 1000 messages (default BATCH_SIZE)
        for (let i = 0; i < 1000; i++) {
          yield { source: "s1", sessionId: "1", role: "user", timestamp: 100 + i, date: "2026-03-14", blocks: [] };
        }
        // Then fail before the final flush or next yield
        throw new Error("Failure after first batch");
      },
      cursor: () => "0",
    };

    const results = await ingest([s1], storage);
    expect(results[0].count).toBe(1000);
    expect(batchInserted).toBe(1000);
    expect(results[0].error).toBe("Failure after first batch");
    });
    });
