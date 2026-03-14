import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSqliteStorage, SqliteStorage } from "../../src/storage/sqlite.ts";
import { createClient } from "@libsql/client";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Message } from "../../src/core/types.ts";

let storage: SqliteStorage;
let tempDir: string;

function msg(source: string, role: "user" | "assistant", ts: number, text: string): Message {
  return {
    source,
    sessionId: `session-${source}`,
    role,
    timestamp: ts,
    date: new Date(ts).toISOString().split("T")[0],
    blocks: [{ type: "text", text }],
  };
}

function toolMsg(source: string, ts: number): Message {
  return {
    source,
    sessionId: `session-${source}`,
    role: "assistant",
    timestamp: ts,
    date: new Date(ts).toISOString().split("T")[0],
    blocks: [
      {
        type: "tool_call",
        toolName: "read_file",
        toolCallId: "call-1",
        toolInput: '{"path": "/foo"}',
      },
    ],
  };
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "memxa-test-"));
  storage = await createSqliteStorage(join(tempDir, "test.db"));
});

afterEach(async () => {
  await storage.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("SqliteStorage", () => {
  it("initializes without errors", async () => {
    expect(await storage.count()).toBe(0);
  });

  it("inserts and counts messages", async () => {
    await storage.insert([
      msg("claude", "user", 1000, "hello"),
      msg("claude", "assistant", 2000, "hi there"),
    ]);

    expect(await storage.count()).toBe(2);
    expect(await storage.count("claude")).toBe(2);
    expect(await storage.count("mastra")).toBe(0);
  });

  it("manages cursors", async () => {
    expect(await storage.getCursor("test")).toBe("0");
    await storage.setCursor("test", "12345");
    expect(await storage.getCursor("test")).toBe("12345");
    await storage.setCursor("test", "99999");
    expect(await storage.getCursor("test")).toBe("99999");
  });

  it("inserts tool call blocks", async () => {
    await storage.insert([toolMsg("aei", 3000)]);
    expect(await storage.count()).toBe(1);
  });

  it("inserts messages with context", async () => {
    const m = msg("aei", "user", 4000, "test context");
    m.context = { cwd: "/home/user", model: "claude-3" };
    await storage.insert([m]);
    expect(await storage.count()).toBe(1);
  });

  it("searches across individual query terms", async () => {
    await storage.insert([
      msg("claude", "user", 1000, "the quick brown fox jumps over the lazy dog"),
      msg("claude", "user", 2000, "hello world from memxa"),
      msg("claude", "assistant", 2500, "we should refactor the auth flow soon"),
      msg("claude", "assistant", 3000, "response about something else entirely"),
    ]);

    const results = await storage.search("refactor auth module");
    expect(results.length).toBe(1);
    expect(results[0].text).toContain("refactor");
  });

  it("applies search filters", async () => {
    await storage.insert([
      msg("claude", "user", 1000, "auth plan for login module"),
      msg("claude", "assistant", 2000, "module cleanup is done"),
      msg("aei", "user", 3000, "auth migration checklist"),
    ]);

    const results = await storage.search("auth module", {
      source: "claude",
      role: "user",
      dateFrom: "1970-01-01",
      dateTo: "1970-01-01",
    });

    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("claude");
    expect(results[0].role).toBe("user");
  });

  it("handles multiple batches", async () => {
    await storage.insert([msg("a", "user", 1000, "first")]);
    await storage.insert([msg("a", "user", 2000, "second")]);
    expect(await storage.count()).toBe(2);
  });

  it("tracks source stats", async () => {
    await storage.insert([
      msg("claude", "user", 1000, "one"),
      msg("claude", "assistant", 2000, "two"),
      msg("aei", "user", 3000, "three"),
    ]);

    const stats = await storage.sourceStats();
    expect(stats.length).toBe(2);

    const claude = stats.find((s) => s.source === "claude");
    expect(claude?.messages).toBe(2);
  });

  it("counts sessions", async () => {
    await storage.insert([msg("claude", "user", 1000, "a"), msg("aei", "user", 2000, "b")]);
    expect(await storage.sessionCount()).toBe(2);
  });

  it("groups fallback session ids by source/date/channel when sessionId is missing", async () => {
    const m1: Message = {
      source: "fallback",
      sessionId: "",
      role: "user",
      timestamp: 1000,
      date: "1970-01-01",
      blocks: [{ type: "text", text: "alpha" }],
      channel: { platform: "cli", name: "main" },
    };
    const m2: Message = {
      source: "fallback",
      sessionId: "",
      role: "assistant",
      timestamp: 2000,
      date: "1970-01-01",
      blocks: [{ type: "text", text: "beta" }],
      channel: { platform: "cli", name: "main" },
    };

    await storage.insert([m1, m2]);

    const sessions = await storage.listSessions({ source: "fallback" });
    expect(sessions).toHaveLength(1);
  });

  it("derives stable fallback session id across insert and addMessage", async () => {
    const base: Message = {
      source: "fallback-stable",
      sessionId: "",
      role: "user",
      timestamp: 5000,
      date: "1970-01-01",
      blocks: [{ type: "text", text: "same payload" }],
      channel: { platform: "cli", name: "opencode" },
    };

    await storage.insert([base]);
    await storage.addMessage({ ...base });

    const sessions = await storage.listSessions({ source: "fallback-stable" });
    expect(sessions).toHaveLength(1);
    const msgs = await storage.getMessages(sessions[0].id);
    expect(msgs).toHaveLength(2);
  });

  it("derives different fallback session ids for different channels", async () => {
    await storage.insert([
      {
        source: "fallback-channel",
        sessionId: "",
        role: "user",
        timestamp: 1000,
        date: "1970-01-01",
        blocks: [{ type: "text", text: "same" }],
        channel: { platform: "cli", name: "a" },
      },
      {
        source: "fallback-channel",
        sessionId: "",
        role: "assistant",
        timestamp: 1500,
        date: "1970-01-01",
        blocks: [{ type: "text", text: "same" }],
        channel: { platform: "cli", name: "b" },
      },
    ]);

    const sessions = await storage.listSessions({ source: "fallback-channel" });
    expect(sessions).toHaveLength(2);
  });

  it("applies migrations idempotently", async () => {
    // Second init should be a no-op
    await storage.init();
    expect(await storage.count()).toBe(0);
  });

  it("imports legacy user_version metadata during initialization", async () => {
    const legacyPath = join(tempDir, "legacy.db");
    const legacy = createClient({ url: `file:${legacyPath}` });
    await legacy.execute("PRAGMA user_version = 7");
    legacy.close();

    const legacyStorage = await createSqliteStorage(legacyPath);
    await legacyStorage.close();

    const inspected = createClient({ url: `file:${legacyPath}` });
    const migrationTableResult = await inspected.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
    );
    const metadataResult = await inspected.execute({
      sql: "SELECT value FROM memxa_metadata WHERE key = ?",
      args: ["legacy_user_version"],
    });
    inspected.close();

    const migrationTable = migrationTableResult.rows[0] as unknown as { name: string } | undefined;
    const metadata = metadataResult.rows[0] as unknown as { value: string };

    expect(migrationTable?.name).toBe("__drizzle_migrations");
    expect(metadata.value).toBe("7");
  });

  it("returns empty array for blank search query", async () => {
    await storage.insert([msg("claude", "user", 1000, "some message")]);

    expect(await storage.search("")).toEqual([]);
    expect(await storage.search("   ")).toEqual([]);
  });

  it("clamps negative and zero limit to 1", async () => {
    await storage.insert([
      msg("claude", "user", 1000, "alpha message"),
      msg("claude", "user", 2000, "beta message"),
    ]);

    const negativeLimit = await storage.search("message", { limit: -1 });
    expect(negativeLimit).toHaveLength(1);

    const zeroLimit = await storage.search("message", { limit: 0 });
    expect(zeroLimit).toHaveLength(1);

    await storage.insert(
      Array.from({ length: 25 }, (_, i) => msg("claude", "user", 3000 + i, `extra message ${i}`)),
    );
    const nanLimit = await storage.search("message", { limit: NaN });
    expect(nanLimit).toHaveLength(20);
  });

  it("cascades deletes from sessions to messages, blocks and contexts", async () => {
    const m = msg("claude", "user", 1000, "cascade test");
    m.context = { cwd: "/tmp" };
    await storage.insert([m]);

    expect(await storage.count()).toBe(1);

    const db = storage.raw;
    await db.execute({ sql: "DELETE FROM sessions WHERE id = ?", args: ["session-claude"] });

    expect(await storage.count()).toBe(0);

    const blockCountResult = await db.execute("SELECT count(*) as c FROM blocks");
    const ctxCountResult = await db.execute("SELECT count(*) as c FROM contexts");
    const blockCount = blockCountResult.rows[0] as unknown as { c: number };
    const ctxCount = ctxCountResult.rows[0] as unknown as { c: number };
    expect(blockCount.c).toBe(0);
    expect(ctxCount.c).toBe(0);
  });

  it("enables foreign key enforcement on the active connection", async () => {
    const db = storage.raw;
    await expect(
      db.execute(`
        INSERT INTO blocks (message_id, position, type, text)
        VALUES ('nonexistent-uuid', 0, 'text', 'orphan block')
      `),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe("SqliteStorage CRUD", () => {
  it("creates and retrieves a session", async () => {
    const now = Date.now();
    await storage.createSession({ id: "ses-1", source: "test", createdAt: now });

    const session = await storage.getSession("ses-1");
    expect(session).not.toBeNull();
    expect(session!.id).toBe("ses-1");
    expect(session!.source).toBe("test");
    expect(session!.channelId).toBeNull();
    expect(session!.createdAt).toBe(now);
    expect(session!.updatedAt).toBeTypeOf("number");
  });

  it("creates a session with channelId", async () => {
    const m: Message = {
      source: "test",
      sessionId: "ses-ch",
      role: "user",
      timestamp: 1000,
      date: "1970-01-01",
      blocks: [{ type: "text", text: "hello" }],
      channel: { platform: "discord", platformId: "123", name: "general", type: "guild" },
    };
    await storage.insert([m]);

    const session = await storage.getSession("ses-ch");
    expect(session).not.toBeNull();
    expect(session!.channelId).toBeTypeOf("string");

    const ch = await storage.getChannel(session!.channelId!);
    expect(ch).not.toBeNull();
    expect(ch!.platform).toBe("discord");
    expect(ch!.platformId).toBe("123");
    expect(ch!.name).toBe("general");
    expect(ch!.type).toBe("guild");
  });

  it("returns null for nonexistent session", async () => {
    expect(await storage.getSession("nope")).toBeNull();
  });

  it("lists sessions with filters", async () => {
    await storage.createSession({ id: "ses-a", source: "claude" });
    await storage.createSession({ id: "ses-b", source: "aei" });
    await storage.createSession({ id: "ses-c", source: "claude" });

    const all = await storage.listSessions();
    expect(all).toHaveLength(3);

    const claudeOnly = await storage.listSessions({ source: "claude" });
    expect(claudeOnly).toHaveLength(2);
    expect(claudeOnly.every((s) => s.source === "claude")).toBe(true);

    const limited = await storage.listSessions({ limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it("clamps negative limit and offset in listSessions", async () => {
    await storage.createSession({ id: "ses-a", source: "test" });
    await storage.createSession({ id: "ses-b", source: "test" });

    const negLimit = await storage.listSessions({ limit: -1 });
    expect(negLimit).toHaveLength(1);

    const zeroLimit = await storage.listSessions({ limit: 0 });
    expect(zeroLimit).toHaveLength(1);

    const negOffset = await storage.listSessions({ limit: 10, offset: -5 });
    expect(negOffset).toHaveLength(2);

    const nanLimit = await storage.listSessions({ limit: Number.NaN });
    expect(nanLimit).toHaveLength(2);

    const fractionalLimit = await storage.listSessions({ limit: 1.9, offset: 0 });
    expect(fractionalLimit).toHaveLength(1);
  });

  it("clamps negative limit and offset in getMessages", async () => {
    await storage.insert([
      msg("test", "user", 1000, "a"),
      msg("test", "user", 2000, "b"),
    ]);

    const negLimit = await storage.getMessages("session-test", { limit: -1 });
    expect(negLimit).toHaveLength(1);

    const negOffset = await storage.getMessages("session-test", { limit: 10, offset: -5 });
    expect(negOffset).toHaveLength(2);

    const nanLimit = await storage.getMessages("session-test", { limit: Number.NaN });
    expect(nanLimit).toHaveLength(2);

    const fractionalLimit = await storage.getMessages("session-test", { limit: 1.9, offset: 0 });
    expect(fractionalLimit).toHaveLength(1);
    expect(fractionalLimit[0].blocks[0].text).toBe("a");

    const fractionalOffset = await storage.getMessages("session-test", { limit: 10, offset: 1.7 });
    expect(fractionalOffset).toHaveLength(1);
    expect(fractionalOffset[0].blocks[0].text).toBe("b");
  });

  it("clamps negative limit and offset in listParticipants", async () => {
    const m: Message = {
      source: "test",
      sessionId: "ses-clamp-p1",
      role: "user",
      timestamp: 1000,
      date: "1970-01-01",
      blocks: [{ type: "text", text: "hi" }],
      author: { platform: "discord", platformId: "clamp-1", name: "bob" },
    };
    const m2: Message = {
      source: "test",
      sessionId: "ses-clamp-p2",
      role: "user",
      timestamp: 2000,
      date: "1970-01-01",
      blocks: [{ type: "text", text: "hi" }],
      author: { platform: "discord", platformId: "clamp-2", name: "carol" },
    };
    await storage.insert([m, m2]);

    const negLimit = await storage.listParticipants({ limit: -1 });
    expect(negLimit).toHaveLength(1);

    const negOffset = await storage.listParticipants({ limit: 50, offset: -5 });
    expect(negOffset).toHaveLength(2);

    const nanLimit = await storage.listParticipants({ limit: Number.NaN });
    expect(nanLimit).toHaveLength(2);

    const fractionalLimit = await storage.listParticipants({ limit: 1.9, offset: 0 });
    expect(fractionalLimit).toHaveLength(1);

    const fractionalOffset = await storage.listParticipants({ limit: 50, offset: 1.7 });
    expect(fractionalOffset).toHaveLength(1);
  });

  it("clamps negative limit and offset in listChannels", async () => {
    const m: Message = {
      source: "test",
      sessionId: "ses-clamp-ch1",
      role: "user",
      timestamp: 1000,
      date: "1970-01-01",
      blocks: [{ type: "text", text: "hi" }],
      channel: { platform: "clamp-test", name: "chan-a" },
    };
    const m2: Message = {
      source: "test",
      sessionId: "ses-clamp-ch2",
      role: "user",
      timestamp: 2000,
      date: "1970-01-01",
      blocks: [{ type: "text", text: "hi" }],
      channel: { platform: "clamp-test", name: "chan-b" },
    };
    await storage.insert([m, m2]);

    const negLimit = await storage.listChannels({ limit: -1 });
    expect(negLimit).toHaveLength(1);

    const negOffset = await storage.listChannels({ limit: 50, offset: -5 });
    expect(negOffset).toHaveLength(2);

    const nanLimit = await storage.listChannels({ limit: Number.NaN });
    expect(nanLimit).toHaveLength(2);

    const fractionalLimit = await storage.listChannels({ limit: 1.9, offset: 0 });
    expect(fractionalLimit).toHaveLength(1);
  });

  it("deletes a session", async () => {
    await storage.createSession({ id: "ses-del", source: "test" });
    expect(await storage.getSession("ses-del")).not.toBeNull();

    await storage.deleteSession("ses-del");
    expect(await storage.getSession("ses-del")).toBeNull();
  });

  it("adds and retrieves a single message", async () => {
    const m = msg("test", "user", 5000, "hello crud");
    m.context = { model: "opus" };

    const id = await storage.addMessage(m);
    expect(id).toBeTypeOf("string");
    expect(id).toHaveLength(36); // UUID format

    const retrieved = await storage.getMessage(id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(id);
    expect(retrieved!.source).toBe("test");
    expect(retrieved!.role).toBe("user");
    expect(retrieved!.blocks).toHaveLength(1);
    expect(retrieved!.blocks[0].text).toBe("hello crud");
    expect(retrieved!.context).toEqual({ model: "opus" });
  });

  it("returns null for nonexistent message", async () => {
    expect(await storage.getMessage("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("retrieves messages for a session", async () => {
    await storage.insert([
      msg("test", "user", 1000, "first"),
      msg("test", "assistant", 2000, "second"),
      msg("test", "user", 3000, "third"),
    ]);

    const msgs = await storage.getMessages("session-test");
    expect(msgs).toHaveLength(3);
    expect(msgs[0].blocks[0].text).toBe("first");
    expect(msgs[2].blocks[0].text).toBe("third");

    // Each message has a UUID id
    for (const m of msgs) {
      expect(m.id).toBeTypeOf("string");
      expect(m.id).toHaveLength(36);
    }
  });

  it("paginates messages", async () => {
    await storage.insert([
      msg("test", "user", 1000, "a"),
      msg("test", "user", 2000, "b"),
      msg("test", "user", 3000, "c"),
    ]);

    const page1 = await storage.getMessages("session-test", { limit: 2 });
    expect(page1).toHaveLength(2);

    const page2 = await storage.getMessages("session-test", { limit: 2, offset: 2 });
    expect(page2).toHaveLength(1);
  });

  it("addMessage auto-creates session", async () => {
    const m = msg("auto", "user", 9000, "auto session");
    await storage.addMessage(m);

    const session = await storage.getSession("session-auto");
    expect(session).not.toBeNull();
    expect(session!.source).toBe("auto");
  });

  it("deleteSession cascades to messages", async () => {
    await storage.insert([msg("cascade", "user", 1000, "will be deleted")]);

    expect(await storage.count("cascade")).toBe(1);

    await storage.deleteSession("session-cascade");
    expect(await storage.count("cascade")).toBe(0);
  });

  it("resolves and retrieves participants", async () => {
    const m: Message = {
      source: "test",
      sessionId: "ses-p",
      role: "user",
      timestamp: 1000,
      date: "1970-01-01",
      blocks: [{ type: "text", text: "hi" }],
      author: { platform: "discord", platformId: "42", name: "alice" },
    };
    await storage.insert([m]);

    const found = await storage.findParticipant("discord", "42");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("alice");

    const byId = await storage.getParticipant(found!.id);
    expect(byId).not.toBeNull();
    expect(byId!.name).toBe("alice");

    const sessionParticipants = await storage.getSessionParticipants("ses-p");
    expect(sessionParticipants).toHaveLength(1);
    expect(sessionParticipants[0].name).toBe("alice");

    const all = await storage.listParticipants();
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  it("resolves and retrieves channels", async () => {
    const m: Message = {
      source: "test",
      sessionId: "ses-ch2",
      role: "user",
      timestamp: 2000,
      date: "1970-01-01",
      blocks: [{ type: "text", text: "hi" }],
      channel: { platform: "cli", name: "claude-code" },
    };
    await storage.insert([m]);

    const all = await storage.listChannels();
    expect(all.length).toBeGreaterThanOrEqual(1);
    const cli = all.find((c) => c.platform === "cli" && c.name === "claude-code");
    expect(cli).toBeDefined();

    const foundByName = await storage.findChannel("cli", { name: "claude-code" });
    expect(foundByName).not.toBeNull();
    expect(foundByName!.id).toBe(cli!.id);

    const foundByPlatformId = await storage.findChannel("discord", {
      platformId: "does-not-exist",
    });
    expect(foundByPlatformId).toBeNull();

    const byId = await storage.getChannel(cli!.id);
    expect(byId).not.toBeNull();
    expect(byId!.platform).toBe("cli");
  });

  it("deduplicates channels by platform + platformId", async () => {
    const base: Omit<Message, "sessionId"> = {
      source: "test",
      role: "user",
      timestamp: 1000,
      date: "1970-01-01",
      blocks: [{ type: "text", text: "x" }],
      channel: { platform: "discord", platformId: "999", name: "general", type: "guild" },
    };
    await storage.insert([
      { ...base, sessionId: "ses-dup1" },
      { ...base, sessionId: "ses-dup2" },
    ]);

    const discordChannels = await storage.listChannels({ platform: "discord" });
    const matching = discordChannels.filter((c) => c.platformId === "999");
    expect(matching).toHaveLength(1);

    const found = await storage.findChannel("discord", { platformId: "999" });
    expect(found).not.toBeNull();
    expect(found!.id).toBe(matching[0].id);
  });

  it("backfills channelId and updates updatedAt for existing sessions", async () => {
    const base: Omit<Message, "timestamp" | "channel"> = {
      source: "test",
      sessionId: "ses-backfill",
      role: "user",
      date: "1970-01-01",
      blocks: [{ type: "text", text: "x" }],
    };

    await storage.addMessage({ ...base, timestamp: 1000 });
    const first = await storage.getSession("ses-backfill");
    expect(first).not.toBeNull();
    expect(first!.channelId).toBeNull();
    expect(first!.updatedAt).toBe(1000);

    await storage.addMessage({
      ...base,
      timestamp: 2000,
      channel: { platform: "cli", name: "claude-code" },
    });

    const second = await storage.getSession("ses-backfill");
    expect(second).not.toBeNull();
    expect(second!.updatedAt).toBe(2000);
    expect(second!.channelId).not.toBeNull();

    const channel = await storage.getChannel(second!.channelId!);
    expect(channel).not.toBeNull();
    expect(channel!.platform).toBe("cli");
    expect(channel!.name).toBe("claude-code");
  });
});
