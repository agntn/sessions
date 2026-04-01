import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GeminiSource } from "../../src/sources/gemini.ts";
import { osUser } from "../../src/core/env.ts";
import type { Message } from "../../src/core/types.ts";

let tempDir: string;

function writeChat(project: string, filename: string, data: Record<string, unknown>): void {
  const dir = join(tempDir, project, "chats");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), JSON.stringify(data));
}

async function collect(source: GeminiSource, cursor = "0"): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const m of source.ingest(cursor)) messages.push(m);
  return messages;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "memxa-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("GeminiSource", () => {
  it("parses user message with string content", async () => {
    writeChat("project-1", "chat-001.json", {
      messages: [{ type: "user", timestamp: "2026-03-10T10:00:00Z", content: "what is 2+2" }],
    });
    const source = new GeminiSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].blocks).toEqual([{ type: "text", text: "what is 2+2" }]);
    expect(msgs[0].source).toBe("gemini");
    expect(msgs[0].sessionId).toBe("chat-001");
  });

  it("parses gemini message with content", async () => {
    writeChat("project-2", "chat-002.json", {
      messages: [{ type: "gemini", timestamp: "2026-03-10T10:00:00Z", content: "the answer is 4" }],
    });
    const source = new GeminiSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].blocks[0]).toEqual({ type: "text", text: "the answer is 4" });
  });

  it("parses thoughts as thinking blocks", async () => {
    writeChat("project-3", "chat-003.json", {
      messages: [
        {
          type: "gemini",
          timestamp: "2026-03-10T10:00:00Z",
          content: "result",
          thoughts: [{ subject: "math", description: "simple addition" }],
        },
      ],
    });
    const source = new GeminiSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks).toHaveLength(2);
    expect(msgs[0].blocks[0]).toEqual({ type: "thinking", text: "math: simple addition" });
    expect(msgs[0].blocks[1]).toEqual({ type: "text", text: "result" });
  });

  it("parses toolCalls as tool_call blocks", async () => {
    writeChat("project-4", "chat-004.json", {
      messages: [
        {
          type: "gemini",
          timestamp: "2026-03-10T10:00:00Z",
          content: "",
          toolCalls: [{ name: "calculator", id: "tc-1", args: { expr: "2+2" } }],
        },
      ],
    });
    const source = new GeminiSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0]).toEqual({
      type: "tool_call",
      toolName: "calculator",
      toolCallId: "tc-1",
      toolInput: '{"expr":"2+2"}',
    });
  });

  it("parses nested tool result from functionResponse", async () => {
    writeChat("project-5", "chat-005.json", {
      messages: [
        {
          type: "gemini",
          timestamp: "2026-03-10T10:00:00Z",
          content: "",
          toolCalls: [
            {
              name: "calculator",
              id: "tc-1",
              args: { expr: "2+2" },
              result: [{ functionResponse: { response: { output: "4" } } }],
            },
          ],
        },
      ],
    });
    const source = new GeminiSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks).toHaveLength(2);
    expect(msgs[0].blocks[0].type).toBe("tool_call");
    expect(msgs[0].blocks[1]).toEqual({
      type: "tool_result",
      toolCallId: "tc-1",
      text: "4",
    });
  });

  it("skips non-user/non-gemini types", async () => {
    writeChat("project-6", "chat-006.json", {
      messages: [
        { type: "system", timestamp: "2026-03-10T10:00:00Z", content: "skip" },
        { type: "user", timestamp: "2026-03-10T10:00:01Z", content: "keep" },
      ],
    });
    const source = new GeminiSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("keep");
  });

  it("skips entries with empty content and no tool calls", async () => {
    writeChat("project-7", "chat-007.json", {
      messages: [
        { type: "gemini", timestamp: "2026-03-10T10:00:00Z", content: "" },
        { type: "user", timestamp: "2026-03-10T10:00:01Z", content: "" },
        { type: "user", timestamp: "2026-03-10T10:00:02Z", content: "valid" },
      ],
    });
    const source = new GeminiSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("valid");
  });

  it("filters by cursor timestamp", async () => {
    const ts = new Date("2026-03-10T10:00:00Z").getTime();
    writeChat("project-8", "chat-008.json", {
      messages: [
        { type: "user", timestamp: "2026-03-10T10:00:00Z", content: "old" },
        { type: "user", timestamp: "2026-03-10T12:00:00Z", content: "new" },
      ],
    });
    const source = new GeminiSource(tempDir);
    const msgs = await collect(source, String(ts));

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("new");
  });

  it("handles multiple projects with separate chat dirs", async () => {
    writeChat("alpha", "chat-a.json", {
      messages: [{ type: "user", timestamp: "2026-03-10T10:00:00Z", content: "from alpha" }],
    });
    writeChat("beta", "chat-b.json", {
      messages: [{ type: "user", timestamp: "2026-03-10T10:00:01Z", content: "from beta" }],
    });
    const source = new GeminiSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(2);
    const texts = msgs.map((m) => m.blocks[0].text);
    expect(texts).toContain("from alpha");
    expect(texts).toContain("from beta");
  });

  it("assigns correct author for user and gemini", async () => {
    writeChat("project-9", "chat-009.json", {
      messages: [
        { type: "user", timestamp: "2026-03-10T10:00:00Z", content: "from user" },
        { type: "gemini", timestamp: "2026-03-10T10:00:01Z", content: "from gemini" },
      ],
    });
    const source = new GeminiSource(tempDir);
    const msgs = await collect(source);

    expect(msgs[0].author).toEqual({ platform: "cli", name: osUser() });
    expect(msgs[1].author).toEqual({ platform: "cli", name: "gemini", isBot: true });
  });

  it("cursor() returns max timestamp", () => {
    const source = new GeminiSource(tempDir);
    const msgs: Message[] = [
      {
        source: "gemini",
        sessionId: "s1",
        role: "user",
        timestamp: 500,
        date: "1970-01-01",
        blocks: [{ type: "text", text: "a" }],
      },
      {
        source: "gemini",
        sessionId: "s1",
        role: "user",
        timestamp: 100,
        date: "1970-01-01",
        blocks: [{ type: "text", text: "b" }],
      },
    ];

    expect(source.cursor(msgs[0])).toBe("500");
  });

  it("skips invalid JSON files gracefully", async () => {
    const dir = join(tempDir, "bad-project", "chats");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.json"), "not valid json");
    writeChat("good-project", "good.json", {
      messages: [{ type: "user", timestamp: "2026-03-10T10:00:00Z", content: "valid" }],
    });

    const source = new GeminiSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("valid");
  });

  it("truncates long content at 8000 chars", async () => {
    writeChat("project-trunc", "chat-trunc.json", {
      messages: [{ type: "user", timestamp: "2026-03-10T10:00:00Z", content: "x".repeat(10000) }],
    });
    const source = new GeminiSource(tempDir);
    const msgs = await collect(source);

    expect(msgs[0].blocks[0].text).toHaveLength(8000);
  });

  it("uses displayName as toolName fallback", async () => {
    writeChat("project-dn", "chat-dn.json", {
      messages: [
        {
          type: "gemini",
          timestamp: "2026-03-10T10:00:00Z",
          content: "",
          toolCalls: [{ displayName: "myTool", id: "tc-dn", args: {} }],
        },
      ],
    });
    const source = new GeminiSource(tempDir);
    const msgs = await collect(source);

    expect(msgs[0].blocks[0].toolName).toBe("myTool");
  });

  it("available() returns false for nonexistent directory", () => {
    const source = new GeminiSource(join(tempDir, "does-not-exist"));
    expect(source.available()).toBe(false);
  });

  it("available() returns true for existing directory", () => {
    const source = new GeminiSource(tempDir);
    expect(source.available()).toBe(true);
  });

  it("skips files that are not .json", async () => {
    const dir = join(tempDir, "project-txt", "chats");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "not a json file");
    writeChat("project-txt", "real.json", {
      messages: [{ type: "user", timestamp: "2026-03-10T10:00:00Z", content: "json file" }],
    });

    const source = new GeminiSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("json file");
  });

  it("falls back to file mtime when message has no timestamp", async () => {
    writeChat("project-nots", "chat-nots.json", {
      messages: [{ type: "user", content: "no timestamp" }],
    });
    const chatPath = join(tempDir, "project-nots", "chats", "chat-nots.json");
    const mtimeMs = statSync(chatPath).mtimeMs;
    const source = new GeminiSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].timestamp).toBe(mtimeMs);
  });
});
