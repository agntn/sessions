import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { ClaudeSource } from "../../src/sources/claude.ts";

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("ClaudeSource", () => {
  it("reads a native JSONL session without truncating message text", async () => {
    directory = mkdtempSync(join(tmpdir(), "sessions-claude-"));
    const project = join(directory, "project");
    mkdirSync(project);
    const text = "x".repeat(9000);
    writeFileSync(
      join(project, "session.jsonl"),
      `${JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z", message: { content: text } })}\n`,
    );

    const messages = [];
    for await (const message of new ClaudeSource(directory).read()) messages.push(message);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.sessionId).toBe("session");
    expect(messages[0]?.blocks[0]?.text).toBe(text);
  });

  it("normalizes native roles, thinking, tool calls, tool results, and mtime fallback", async () => {
    directory = mkdtempSync(join(tmpdir(), "sessions-claude-"));
    const project = join(directory, "project");
    mkdirSync(project);
    const sessionPath = join(project, "tools.jsonl");
    const entries = [
      {
        type: "assistant",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: {
          content: [
            { type: "thinking", thinking: "considering" },
            { type: "tool_use", id: "tool-1", name: "read", input: { path: "file.txt" } },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }] },
      },
      {
        type: "human",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-2",
              content: [
                { type: "text", text: "first" },
                { type: "image", source: "ignored" },
                { type: "text", text: "second" },
              ],
            },
          ],
        },
      },
    ];
    writeFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const mtime = new Date("2026-01-02T03:04:05.000Z");
    utimesSync(sessionPath, mtime, mtime);

    const messages = [];
    for await (const message of new ClaudeSource(directory).read()) messages.push(message);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      blocks: [
        { type: "thinking", text: "considering" },
        {
          type: "tool_call",
          toolName: "read",
          toolCallId: "tool-1",
          toolInput: '{"path":"file.txt"}',
        },
      ],
    });
    expect(messages[1]).toMatchObject({
      role: "user",
      blocks: [{ type: "tool_result", toolCallId: "tool-1", text: "done" }],
    });
    expect(messages[2]).toMatchObject({
      role: "user",
      timestamp: mtime.getTime(),
      blocks: [{ type: "tool_result", toolCallId: "tool-2", text: "first\nsecond" }],
    });
  });
});
