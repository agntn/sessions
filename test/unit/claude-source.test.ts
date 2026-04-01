import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeSource } from "../../src/sources/claude.ts";
import { osUser } from "../../src/core/env.ts";
import type { Message } from "../../src/core/types.ts";

let tempDir: string;
let projectsDir: string;

function writeJsonl(filename: string, lines: Record<string, unknown>[], mtime?: Date): string {
  const dir = join(projectsDir, "test-project");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  if (mtime) {
    utimesSync(path, mtime, mtime);
  }
  return path;
}

async function collect(source: ClaudeSource, cursor = "0"): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const m of source.ingest(cursor)) messages.push(m);
  return messages;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "memxa-test-"));
  projectsDir = join(tempDir, "projects");
  mkdirSync(projectsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ClaudeSource", () => {
  it("parses user message with string content", async () => {
    writeJsonl("session-1.jsonl", [
      {
        type: "user",
        timestamp: "2026-03-10T10:00:00Z",
        message: { content: "hello world" },
      },
    ]);
    const source = new ClaudeSource(projectsDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].blocks).toEqual([{ type: "text", text: "hello world" }]);
    expect(msgs[0].source).toBe("claude");
    expect(msgs[0].sessionId).toBe("session-1");
  });

  it("parses assistant message with text and thinking blocks", async () => {
    writeJsonl("session-2.jsonl", [
      {
        type: "assistant",
        timestamp: "2026-03-10T10:00:01Z",
        message: {
          content: [
            { type: "text", text: "response text" },
            { type: "thinking", thinking: "let me think about this" },
          ],
        },
      },
    ]);
    const source = new ClaudeSource(projectsDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].blocks).toHaveLength(2);
    expect(msgs[0].blocks[0]).toEqual({ type: "text", text: "response text" });
    expect(msgs[0].blocks[1]).toEqual({ type: "thinking", text: "let me think about this" });
  });

  it("parses tool_use block as tool_call", async () => {
    writeJsonl("session-3.jsonl", [
      {
        type: "assistant",
        timestamp: "2026-03-10T10:00:02Z",
        message: {
          content: [
            {
              type: "tool_use",
              name: "read_file",
              id: "call-1",
              input: { path: "/foo" },
            },
          ],
        },
      },
    ]);
    const source = new ClaudeSource(projectsDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0]).toEqual({
      type: "tool_call",
      toolName: "read_file",
      toolCallId: "call-1",
      toolInput: '{"path":"/foo"}',
    });
  });

  it("parses tool_result block with string content", async () => {
    writeJsonl("session-4.jsonl", [
      {
        type: "user",
        timestamp: "2026-03-10T10:00:03Z",
        message: {
          content: [{ type: "tool_result", tool_use_id: "call-1", content: "file contents here" }],
        },
      },
    ]);
    const source = new ClaudeSource(projectsDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0]).toEqual({
      type: "tool_result",
      toolCallId: "call-1",
      text: "file contents here",
    });
  });

  it("parses tool_result block with array content", async () => {
    writeJsonl("session-5.jsonl", [
      {
        type: "user",
        timestamp: "2026-03-10T10:00:04Z",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-2",
              content: [
                { type: "text", text: "line one" },
                { type: "text", text: "line two" },
              ],
            },
          ],
        },
      },
    ]);
    const source = new ClaudeSource(projectsDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0]).toEqual({
      type: "tool_result",
      toolCallId: "call-2",
      text: "line one\nline two",
    });
  });

  it("skips lines with unknown type", async () => {
    writeJsonl("session-6.jsonl", [
      { type: "system", timestamp: "2026-03-10T10:00:00Z", message: { content: "skip me" } },
      { type: "user", timestamp: "2026-03-10T10:00:01Z", message: { content: "keep me" } },
    ]);
    const source = new ClaudeSource(projectsDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("keep me");
  });

  it("skips malformed JSON lines", async () => {
    const dir = join(projectsDir, "test-project");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session-7.jsonl"),
      [
        "not valid json",
        JSON.stringify({
          type: "user",
          timestamp: "2026-03-10T10:00:00Z",
          message: { content: "valid line" },
        }),
      ].join("\n"),
    );

    const source = new ClaudeSource(projectsDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("valid line");
  });

  it("preserves short messages but skips empty ones", async () => {
    writeJsonl("session-8.jsonl", [
      { type: "user", timestamp: "2026-03-10T10:00:00Z", message: { content: "" } },
      { type: "user", timestamp: "2026-03-10T10:00:01Z", message: { content: "ok" } },
      { type: "user", timestamp: "2026-03-10T10:00:02Z", message: { content: "y" } },
    ]);
    const source = new ClaudeSource(projectsDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(2);
    expect(msgs[0].blocks[0].text).toBe("ok");
    expect(msgs[1].blocks[0].text).toBe("y");
  });

  it("filters by cursor timestamp", async () => {
    const ts = new Date("2026-03-10T10:00:00Z").getTime();
    writeJsonl("session-9.jsonl", [
      { type: "user", timestamp: "2026-03-10T10:00:00Z", message: { content: "old message" } },
      { type: "user", timestamp: "2026-03-10T12:00:00Z", message: { content: "new message" } },
    ]);
    const source = new ClaudeSource(projectsDir);
    const msgs = await collect(source, String(ts));

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("new message");
  });

  it("cursor() returns max timestamp as string", () => {
    const source = new ClaudeSource(projectsDir);
    const msgs: Message[] = [
      {
        source: "claude",
        sessionId: "s1",
        role: "user",
        timestamp: 100,
        date: "1970-01-01",
        blocks: [{ type: "text", text: "a" }],
      },
      {
        source: "claude",
        sessionId: "s1",
        role: "user",
        timestamp: 300,
        date: "1970-01-01",
        blocks: [{ type: "text", text: "b" }],
      },
      {
        source: "claude",
        sessionId: "s1",
        role: "user",
        timestamp: 200,
        date: "1970-01-01",
        blocks: [{ type: "text", text: "c" }],
      },
    ];

    expect(source.cursor(msgs[1])).toBe("300");
  });

  it("assigns correct author for user and assistant", async () => {
    writeJsonl("session-10.jsonl", [
      { type: "user", timestamp: "2026-03-10T10:00:00Z", message: { content: "from user" } },
      {
        type: "assistant",
        timestamp: "2026-03-10T10:00:01Z",
        message: { content: [{ type: "text", text: "from assistant" }] },
      },
    ]);
    const source = new ClaudeSource(projectsDir);
    const msgs = await collect(source);

    expect(msgs[0].author).toEqual({ platform: "cli", name: osUser() });
    expect(msgs[1].author).toEqual({ platform: "cli", name: "claude-code", isBot: true });
  });

  it("sets channel to cli/claude-code", async () => {
    writeJsonl("session-11.jsonl", [
      { type: "user", timestamp: "2026-03-10T10:00:00Z", message: { content: "test channel" } },
    ]);
    const source = new ClaudeSource(projectsDir);
    const msgs = await collect(source);

    expect(msgs[0].channel).toEqual({ platform: "cli", name: "claude-code" });
  });

  it("accepts human type as user role", async () => {
    writeJsonl("session-12.jsonl", [
      { type: "human", timestamp: "2026-03-10T10:00:00Z", message: { content: "human message" } },
    ]);
    const source = new ClaudeSource(projectsDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
  });

  it("available() returns false for nonexistent dir", () => {
    const source = new ClaudeSource(join(tempDir, "nonexistent-claude-projects"));
    expect(source.available()).toBe(false);
  });

  it("available() returns true for existing dir", () => {
    const source = new ClaudeSource(projectsDir);
    expect(source.available()).toBe(true);
  });

  it("skips entries with missing message field", async () => {
    writeJsonl("session-no-msg.jsonl", [
      { type: "user", timestamp: "2026-03-10T10:00:00Z" },
      { type: "user", timestamp: "2026-03-10T10:00:01Z", message: { content: "valid" } },
    ]);
    const source = new ClaudeSource(projectsDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("valid");
  });

  it("handles nested project subdirectories", async () => {
    const dir = join(projectsDir, "test-project", "subdir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "deep.jsonl"),
      JSON.stringify({
        type: "user",
        timestamp: "2026-03-10T10:00:00Z",
        message: { content: "from nested dir" },
      }),
    );

    const source = new ClaudeSource(projectsDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("from nested dir");
  });

  it("truncates long text blocks at 8000 chars", async () => {
    writeJsonl("session-long.jsonl", [
      {
        type: "user",
        timestamp: "2026-03-10T10:00:00Z",
        message: { content: "x".repeat(10000) },
      },
    ]);
    const source = new ClaudeSource(projectsDir);
    const msgs = await collect(source);

    expect(msgs[0].blocks[0].text).toHaveLength(8000);
  });

  it("falls back to file mtime when entry has no timestamp", async () => {
    const mtime = new Date("2026-03-10T10:00:05.000Z");
    writeJsonl("session-no-ts.jsonl", [{ type: "user", message: { content: "no timestamp" } }], mtime);
    const source = new ClaudeSource(projectsDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(Math.abs(msgs[0].timestamp - mtime.getTime())).toBeLessThan(2000);
  });

  it("parses tool_use with string input", async () => {
    writeJsonl("session-tool-str.jsonl", [
      {
        type: "assistant",
        timestamp: "2026-03-10T10:00:00Z",
        message: {
          content: [
            {
              type: "tool_use",
              name: "bash",
              id: "call-str",
              input: "raw string input",
            },
          ],
        },
      },
    ]);
    const source = new ClaudeSource(projectsDir);
    const msgs = await collect(source);

    expect(msgs[0].blocks[0].toolInput).toBe("raw string input");
  });
});
