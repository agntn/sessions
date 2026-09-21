import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { OmpSource } from "../../src/sources/omp.ts";
import type { Message } from "../../src/core/types.ts";

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function writeSession(name: string, entries: readonly Readonly<Record<string, unknown>>[]): string {
  const project = join(directory!, "project");
  mkdirSync(project, { recursive: true });
  const path = join(project, name);
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return path;
}

describe("OmpSource", () => {
  it("normalizes native roles, thinking, tool calls, and tool results", async () => {
    directory = mkdtempSync(join(tmpdir(), "sessions-omp-"));
    const entries = [
      {
        type: "session",
        version: 3,
        id: "01a00c04-6116-7000-ae3d-c623f8a6977a",
        timestamp: "2026-08-16T19:20:08.726Z",
        cwd: "/tmp/project",
      },
      {
        type: "message",
        id: "m1",
        timestamp: "2026-08-16T19:20:30.384Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      },
      {
        type: "message",
        id: "m2",
        timestamp: "2026-08-16T19:20:35.754Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "considering" },
            {
              type: "toolCall",
              id: "call_1",
              name: "read",
              arguments: { path: "file.txt" },
            },
          ],
        },
      },
      {
        type: "message",
        id: "m3",
        timestamp: "2026-08-16T19:20:37.204Z",
        message: {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "file body" }],
        },
      },
    ];
    const path = writeSession("2026-08-16T19-20-08-726Z_01a00c04.jsonl", entries);

    const messages: Message[] = [];
    for await (const message of new OmpSource(directory).read()) messages.push(message);

    expect(messages).toHaveLength(3);
    expect(messages.every((m) => m.sessionId === "01a00c04-6116-7000-ae3d-c623f8a6977a")).toBe(
      true,
    );
    expect(messages[0]).toMatchObject({
      role: "user",
      blocks: [{ type: "text", text: "hello" }],
    });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      blocks: [
        { type: "thinking", text: "considering" },
        {
          type: "tool_call",
          toolName: "read",
          toolCallId: "call_1",
          toolInput: '{"path":"file.txt"}',
        },
      ],
    });
    expect(messages[2]).toMatchObject({
      role: "tool",
      blocks: [{ type: "tool_result", toolCallId: "call_1", text: "file body" }],
    });
    void path;
  });

  it("reads a shortened filename by the full session id from its header", async () => {
    directory = mkdtempSync(join(tmpdir(), "sessions-omp-"));
    const fullId = "01a00c04-6116-7000-ae3d-c623f8a6977a";
    writeSession("2026-08-16T19-20-08-726Z_01a00c04.jsonl", [
      { type: "session", version: 3, id: fullId, timestamp: "2026-08-16T19:20:08.726Z" },
      {
        type: "message",
        id: "m1",
        timestamp: "2026-08-16T19:20:30.384Z",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      },
    ]);
    writeSession("2026-08-16T19-20-09-000Z_01a00c05.jsonl", [
      {
        type: "session",
        version: 3,
        id: "01a00c05-6116-7000-ae3d-c623f8a6977a",
        timestamp: "2026-08-16T19:20:09.000Z",
      },
      {
        type: "message",
        id: "m2",
        timestamp: "2026-08-16T19:20:31.000Z",
        message: { role: "user", content: [{ type: "text", text: "other" }] },
      },
    ]);

    const texts: string[] = [];
    for await (const message of new OmpSource(directory).read({ sessionId: fullId })) {
      texts.push(message.blocks[0]?.text ?? "");
    }
    expect(texts).toEqual(["hello"]);
  });

  it("skips harness bookkeeping entries and falls back to file mtime", async () => {
    directory = mkdtempSync(join(tmpdir(), "sessions-omp-"));
    const entries = [
      { type: "title", v: 1, title: "Plan", updatedAt: "2026-08-16T19:28:16.444Z" },
      { type: "model_change", id: "22a2cbc4", model: "openai-codex/gpt-5.6-sol" },
      { type: "custom", customType: "tool_execution_start", id: "6c350091" },
      {
        type: "message",
        id: "m1",
        message: { role: "system", content: [{ type: "text", text: "ignored" }] },
      },
      {
        type: "message",
        id: "m2",
        message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
      },
    ];
    const path = writeSession("title-first.jsonl", entries);
    const mtime = new Date("2026-01-02T03:04:05.000Z");
    utimesSync(path, mtime, mtime);

    const messages: Message[] = [];
    for await (const message of new OmpSource(directory).read()) messages.push(message);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      sessionId: "title-first",
      role: "assistant",
      timestamp: mtime.getTime(),
      blocks: [{ type: "text", text: "answer" }],
    });
  });

  it("keeps the filename fallback when a session header has an empty id", async () => {
    directory = mkdtempSync(join(tmpdir(), "sessions-omp-"));
    writeSession("blank.jsonl", [
      { type: "session", id: "" },
      {
        type: "message",
        timestamp: "2026-08-16T19:20:30.384Z",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      },
    ]);

    const messages: Message[] = [];
    for await (const message of new OmpSource(directory).read()) messages.push(message);

    expect(messages).toHaveLength(1);
    expect(messages[0].sessionId).toBe("blank");
  });

  it("skips null content items without aborting the rest of the archive", async () => {
    directory = mkdtempSync(join(tmpdir(), "sessions-omp-"));
    writeSession("null-block.jsonl", [
      { type: "session", version: 3, id: "sess-null", timestamp: "2026-01-01T00:00:00.000Z" },
      {
        type: "message",
        id: "m1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "before" }] },
      },
      {
        type: "message",
        id: "m2",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "assistant", content: [null, { type: "text", text: "kept" }] },
      },
      {
        type: "message",
        id: "m3",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: { role: "user", content: [{ type: "text", text: "after" }] },
      },
    ]);

    const messages: Message[] = [];
    for await (const message of new OmpSource(directory).read()) messages.push(message);

    expect(messages.map((m) => m.blocks[0]?.text)).toEqual(["before", "kept", "after"]);
  });

  it("reads nested subagent transcripts under their own session ids", async () => {
    directory = mkdtempSync(join(tmpdir(), "sessions-omp-"));
    const parent = join(directory, "project");
    const sub = join(parent, "2026-06-08T19-19-19-314Z_parent");
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(parent, "parent.jsonl"),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "019ea8ac-d412-7000-8c77-9f306621b899",
        cwd: "/tmp/project",
      })}\n`,
    );
    writeFileSync(
      join(sub, "ProjectsWikiMemory.jsonl"),
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "019ea8ae-72e0-7000-b9ff-27282062a997",
          cwd: "/tmp/project",
        }),
        JSON.stringify({
          type: "message",
          id: "s1",
          timestamp: "2026-06-08T19:21:10.000Z",
          message: { role: "user", content: [{ type: "text", text: "subagent task" }] },
        }),
      ].join("\n") + "\n",
    );

    const messages: Message[] = [];
    for await (const message of new OmpSource(directory).read()) messages.push(message);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      sessionId: "019ea8ae-72e0-7000-b9ff-27282062a997",
      role: "user",
      blocks: [{ type: "text", text: "subagent task" }],
    });
  });

  it("joins multi-part tool result text blocks", async () => {
    directory = mkdtempSync(join(tmpdir(), "sessions-omp-"));
    writeSession("multi.jsonl", [
      {
        type: "session",
        version: 3,
        id: "sess-multi",
        timestamp: "2026-08-16T19:20:08.726Z",
      },
      {
        type: "message",
        id: "m1",
        timestamp: "2026-08-16T19:20:40.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call_9",
          isError: true,
          content: [
            { type: "text", text: "first part" },
            { type: "image", source: "ignored" },
            { type: "text", text: "second part" },
          ],
        },
      },
    ]);

    const messages: Message[] = [];
    for await (const message of new OmpSource(directory).read()) messages.push(message);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "tool",
      blocks: [{ type: "tool_result", toolCallId: "call_9", text: "first part\nsecond part" }],
    });
  });
});
