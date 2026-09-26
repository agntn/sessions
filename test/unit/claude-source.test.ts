import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import type { Message, SourceReadOptions } from "../../src/core/types.ts";
import { ClaudeSource } from "../../src/sources/claude.ts";

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function userLine(text: string): string {
  return `${JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z", message: { content: text } })}\n`;
}

async function collect(
  source: Readonly<ClaudeSource>,
  options?: SourceReadOptions,
): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const message of source.read(options)) messages.push(message);
  return messages;
}

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

  it.each([
    { status: { is_error: true }, expected: { isError: true } },
    { status: { is_error: false }, expected: { isError: false } },
    { status: {}, expected: {} },
    { status: { is_error: "true" }, expected: {} },
  ])("preserves native tool status: $status", async ({ status, expected }) => {
    directory = mkdtempSync(join(tmpdir(), "sessions-claude-"));
    const project = join(directory, "project");
    mkdirSync(project);
    writeFileSync(
      join(project, "session.jsonl"),
      JSON.stringify({
        type: "user",
        timestamp: "2026-09-24T10:00:01.000Z",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "Exit code 1", ...status }],
        },
      }),
    );

    const messages = await collect(new ClaudeSource(directory));

    expect(messages.map((message) => message.blocks)).toEqual([
      [{ type: "tool_result", toolCallId: "t1", text: "Exit code 1", ...expected }],
    ]);
  });

  it("opens only the transcripts named after the requested session", async () => {
    directory = mkdtempSync(join(tmpdir(), "sessions-claude-"));
    for (const project of ["project-a", "project-b"]) {
      mkdirSync(join(directory, project));
      writeFileSync(join(directory, project, "wanted.jsonl"), userLine(`${project} wanted`));
    }
    writeFileSync(join(directory, "project-a", "other.jsonl"), userLine("other"));
    symlinkSync(join(directory, "missing.jsonl"), join(directory, "project-b", "trap.jsonl"));
    const source = new ClaudeSource(directory);

    await expect(collect(source)).rejects.toThrow(/ENOENT/);

    const messages = await collect(source, { sessionId: "wanted" });
    const turns = messages.map((message) => `${message.sessionId}: ${message.blocks[0]?.text}`);
    expect(turns.sort((left, right) => left.localeCompare(right))).toEqual([
      "wanted: project-a wanted",
      "wanted: project-b wanted",
    ]);
  });
});
