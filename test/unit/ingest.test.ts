import { describe, it, expect, vi } from "vitest";
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

function makeUnavailableSource(name: string): Source {
  return {
    name,
    available: () => false,
    async *ingest() {},
    cursor: () => "0",
  };
}

function makeStorage(): Storage & { inserted: Message[][]; cursors: Map<string, string> } {
  const cursors = new Map<string, string>();
  const inserted: Message[][] = [];
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
    async insert(batch) {
      inserted.push([...batch]);
    },
    async getCursor(source) {
      return cursors.get(source) || "0";
    },
    async setCursor(source, cursor) {
      cursors.set(source, cursor);
    },
    async count() {
      return inserted.reduce((sum, b) => sum + b.length, 0);
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
    inserted,
    cursors,
  };
}

function msg(source: string, ts: number): Message {
  return {
    source,
    sessionId: "s1",
    role: "user",
    timestamp: ts,
    date: "2026-03-07",
    blocks: [{ type: "text", text: "hello" }],
  };
}

describe("ingest", () => {
  it("ingests messages from a source into storage", async () => {
    const storage = makeStorage();
    const source = makeSource("test", [msg("test", 100), msg("test", 200)]);

    const results = await ingest([source], storage);

    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("test");
    expect(results[0].count).toBe(2);
    expect(storage.inserted.flat()).toHaveLength(2);
    expect(storage.cursors.get("test")).toBe("200");
  });

  it("skips unavailable sources", async () => {
    const storage = makeStorage();
    const source = makeUnavailableSource("missing");

    const results = await ingest([source], storage);

    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(true);
    expect(results[0].count).toBe(0);
  });

  it("filters by only option", async () => {
    const storage = makeStorage();
    const s1 = makeSource("a", [msg("a", 100)]);
    const s2 = makeSource("b", [msg("b", 200)]);

    const results = await ingest([s1, s2], storage, { only: ["a"] });

    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("a");
  });

  it("dry run does not write to storage", async () => {
    const storage = makeStorage();
    const source = makeSource("test", [msg("test", 100)]);
    const onMessage = vi.fn();

    const results = await ingest([source], storage, { dryRun: true, onMessage });

    expect(results[0].count).toBe(1);
    expect(storage.inserted).toHaveLength(0);
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it("dry run reads current cursor but does not persist updates", async () => {
    const storage = makeStorage();
    storage.cursors.set("test", "123");
    let receivedCursor = "";
    const source: Source = {
      name: "test",
      available: () => true,
      async *ingest(cursor: string) {
        receivedCursor = cursor;
        yield msg("test", 200);
      },
      cursor: (msgs) => (msgs.length ? String(msgs[msgs.length - 1].timestamp) : "0"),
    };

    const results = await ingest([source], storage, { dryRun: true });

    expect(receivedCursor).toBe("123");
    expect(results[0].count).toBe(1);
    expect(results[0].cursor).toBe("123");
    expect(storage.cursors.get("test")).toBe("123");
  });

  it("dry run respects previewLimit", async () => {
    const storage = makeStorage();
    const source = makeSource("test", [msg("test", 100), msg("test", 200), msg("test", 300)]);
    const onMessage = vi.fn();

    const results = await ingest([source], storage, {
      dryRun: true,
      previewLimit: 2,
      onMessage,
    });

    expect(results[0].count).toBe(3);
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it("dry run defaults previewLimit to 5", async () => {
    const storage = makeStorage();
    const messages = Array.from({ length: 8 }, (_, i) => msg("test", 100 + i));
    const source = makeSource("test", messages);
    const onMessage = vi.fn();

    await ingest([source], storage, { dryRun: true, onMessage });

    expect(onMessage).toHaveBeenCalledTimes(5);
  });

  it("advances cursor to max timestamp even when messages arrive out of order", async () => {
    const storage = makeStorage();
    const source: Source = {
      name: "test",
      available: () => true,
      async *ingest() {
        yield msg("test", 300);
        yield msg("test", 200);
      },
      cursor: (msgs) => String(Math.max(...msgs.map((m) => m.timestamp))),
    };

    const results = await ingest([source], storage);

    expect(results[0].cursor).toBe("300");
    expect(storage.cursors.get("test")).toBe("300");
  });
});
