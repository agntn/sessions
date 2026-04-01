import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeSource } from "../../src/sources/claude.ts";
import { GeminiSource } from "../../src/sources/gemini.ts";
import { ingest } from "../../src/core/ingest.ts";
import { createSqliteStorage, SqliteStorage } from "../../src/storage/sqlite.ts";

let tempDir: string;
let storage: SqliteStorage;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "memxa-test-"));
  storage = await createSqliteStorage(join(tempDir, "test.db"));
});

afterEach(async () => {
  await storage.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("round-trip: source → ingest → storage → search", () => {
  it("Claude JSONL → ingest → search returns stored text", async () => {
    const projectsDir = join(tempDir, "projects", "test-project");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(
      join(projectsDir, "session-rt.jsonl"),
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-03-10T10:00:00Z",
          message: { content: "implement the auth module" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-03-10T10:00:01Z",
          message: { content: [{ type: "text", text: "I will implement the auth module now" }] },
        }),
      ].join("\n"),
    );

    const source = new ClaudeSource(join(tempDir, "projects"));
    const results = await ingest([source], storage);

    expect(results).toHaveLength(1);
    expect(results[0].count).toBe(2);

    const searchResults = await storage.search("auth module");
    expect(searchResults.length).toBeGreaterThanOrEqual(1);
    expect(searchResults.some((r) => r.text?.includes("auth module"))).toBe(true);

    expect(await storage.count("claude")).toBe(2);
  });

  it("cursor re-ingestion yields 0 new messages", async () => {
    const projectsDir = join(tempDir, "projects", "test-project");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(
      join(projectsDir, "session-cursor.jsonl"),
      JSON.stringify({
        type: "user",
        timestamp: "2026-03-10T10:00:00Z",
        message: { content: "first ingest message" },
      }),
    );

    const source = new ClaudeSource(join(tempDir, "projects"));

    const first = await ingest([source], storage);
    expect(first[0].count).toBe(1);

    const second = await ingest([source], storage);
    expect(second[0].count).toBe(0);
  });

  it("multi-source round-trip with sourceStats", async () => {
    const claudeDir = join(tempDir, "claude-projects", "proj");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "session-c.jsonl"),
      JSON.stringify({
        type: "user",
        timestamp: "2026-03-10T10:00:00Z",
        message: { content: "claude user message for stats" },
      }),
    );

    const geminiDir = join(tempDir, "gemini-dir", "proj", "chats");
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(
      join(geminiDir, "chat-g.json"),
      JSON.stringify({
        messages: [
          {
            type: "user",
            timestamp: "2026-03-10T10:00:01Z",
            content: "gemini user message for stats",
          },
        ],
      }),
    );

    const claude = new ClaudeSource(join(tempDir, "claude-projects"));
    const gemini = new GeminiSource(join(tempDir, "gemini-dir"));
    const results = await ingest([claude, gemini], storage);

    expect(results).toHaveLength(2);
    expect(results[0].count).toBe(1);
    expect(results[1].count).toBe(1);

    const stats = await storage.sourceStats();
    expect(stats).toHaveLength(2);
    expect(stats.find((s) => s.source === "claude")?.messages).toBe(1);
    expect(stats.find((s) => s.source === "gemini")?.messages).toBe(1);
  });

  it("session and messages are retrievable after ingest", async () => {
    const projectsDir = join(tempDir, "projects", "test-project");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(
      join(projectsDir, "my-session.jsonl"),
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-03-10T10:00:00Z",
          message: { content: "first message" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-03-10T10:00:01Z",
          message: { content: [{ type: "text", text: "second message" }] },
        }),
      ].join("\n"),
    );

    const source = new ClaudeSource(join(tempDir, "projects"));
    await ingest([source], storage);

    const session = await storage.getSession("my-session");
    expect(session).not.toBeNull();
    expect(session!.source).toBe("claude");

    const msgs = await storage.getMessages("my-session");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
  });

  it("Claude JSONL tool blocks survive ingest → storage → retrieve cycle", async () => {
    const projectsDir = join(tempDir, "projects", "test-project");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(
      join(projectsDir, "session-tools.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-03-10T10:00:00Z",
          message: {
            content: [
              {
                type: "tool_use",
                id: "call-abc",
                name: "read_file",
                input: { path: "/src/main.ts" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-03-10T10:00:01Z",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-abc",
                content: "file contents here",
              },
            ],
          },
        }),
      ].join("\n"),
    );

    const source = new ClaudeSource(join(tempDir, "projects"));
    await ingest([source], storage);

    const msgs = await storage.getMessages("session-tools");
    expect(msgs).toHaveLength(2);

    expect(msgs[0].blocks[0].type).toBe("tool_call");
    expect(msgs[0].blocks[0].toolName).toBe("read_file");
    expect(msgs[0].blocks[0].toolCallId).toBe("call-abc");
    expect(msgs[0].blocks[0].toolInput).toBe(JSON.stringify({ path: "/src/main.ts" }));

    expect(msgs[1].blocks[0].type).toBe("tool_result");
    expect(msgs[1].blocks[0].toolCallId).toBe("call-abc");
    expect(msgs[1].blocks[0].text).toBe("file contents here");
  });

  it("search filters by source correctly", async () => {
    const claudeDir = join(tempDir, "claude-proj", "proj");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "session-sf.jsonl"),
      JSON.stringify({
        type: "user",
        timestamp: "2026-03-10T10:00:00Z",
        message: { content: "search filtering test from claude" },
      }),
    );

    const geminiDir = join(tempDir, "gemini-proj", "proj", "chats");
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(
      join(geminiDir, "chat-sf.json"),
      JSON.stringify({
        messages: [
          {
            type: "user",
            timestamp: "2026-03-10T10:00:01Z",
            content: "search filtering test from gemini",
          },
        ],
      }),
    );

    const claude = new ClaudeSource(join(tempDir, "claude-proj"));
    const gemini = new GeminiSource(join(tempDir, "gemini-proj"));
    await ingest([claude, gemini], storage);

    const claudeResults = await storage.search("filtering test", { source: "claude" });
    expect(claudeResults).toHaveLength(1);
    expect(claudeResults[0].source).toBe("claude");

    const geminiResults = await storage.search("filtering test", { source: "gemini" });
    expect(geminiResults).toHaveLength(1);
    expect(geminiResults[0].source).toBe("gemini");
  });

  it("search filters by role correctly", async () => {
    const projectsDir = join(tempDir, "projects-role", "proj");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(
      join(projectsDir, "session-role.jsonl"),
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-03-10T10:00:00Z",
          message: { content: "user asks about deployment" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-03-10T10:00:01Z",
          message: { content: [{ type: "text", text: "assistant explains deployment" }] },
        }),
      ].join("\n"),
    );

    const source = new ClaudeSource(join(tempDir, "projects-role"));
    await ingest([source], storage);

    const userResults = await storage.search("deployment", { role: "user" });
    expect(userResults).toHaveLength(1);
    expect(userResults[0].role).toBe("user");

    const assistantResults = await storage.search("deployment", { role: "assistant" });
    expect(assistantResults).toHaveLength(1);
    expect(assistantResults[0].role).toBe("assistant");
  });

  it("purgeSource removes data and cursor for a source", async () => {
    const projectsDir = join(tempDir, "projects-purge", "proj");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(
      join(projectsDir, "session-purge.jsonl"),
      JSON.stringify({
        type: "user",
        timestamp: "2026-03-10T10:00:00Z",
        message: { content: "will be purged" },
      }),
    );

    const source = new ClaudeSource(join(tempDir, "projects-purge"));
    await ingest([source], storage);

    expect(await storage.count("claude")).toBe(1);
    const cursor = await storage.getCursor("claude");
    expect(cursor).not.toBe("0");

    await storage.purgeSource("claude");

    expect(await storage.count("claude")).toBe(0);
    expect(await storage.getCursor("claude")).toBe("0");
  });
});
