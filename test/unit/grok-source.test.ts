import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../../src/core/types.ts";
import { create, listSourceSessions, readSourceSession } from "../../src/index.ts";
import { GrokSource, sessionIdFromDirectory } from "../../src/sources/grok.ts";

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function writeSession(
  root: string,
  project: string,
  id: string,
  lines: readonly unknown[],
  summary?: unknown,
): string {
  const sessionDir = join(root, project, id);
  mkdirSync(sessionDir, { recursive: true });
  const chat = join(sessionDir, "chat_history.jsonl");
  writeFileSync(chat, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  if (summary !== undefined) {
    writeFileSync(join(sessionDir, "summary.json"), JSON.stringify(summary));
  }
  return chat;
}

async function collect(source: Readonly<GrokSource>, sessionId?: string): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const message of source.read(sessionId === undefined ? undefined : { sessionId })) {
    messages.push(message);
  }
  return messages;
}

describe("GrokSource", () => {
  it("keeps the directory name for this platform, including a backslash on POSIX", async () => {
    expect(sessionIdFromDirectory(join("project", "session-1"))).toBe("session-1");
    if (sep !== "/") return;
    directory = mkdtempSync(join(tmpdir(), "sessions-grok-"));
    const id = String.raw`run\alpha`;
    const sessionDir = join(directory, "project", id);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "chat_history.jsonl"),
      `${JSON.stringify({ type: "user", content: [{ type: "text", text: "kept" }] })}\r\n`,
    );
    const source = new GrokSource(directory);
    const messages = await collect(source, id);
    expect(messages.map((message) => message.sessionId)).toEqual([id]);
    expect(messages[0]).toMatchObject({ blocks: [{ type: "text", text: "kept" }] });
  });

  it("normalizes chat history and skips injected openers in the snippet", async () => {
    directory = mkdtempSync(join(tmpdir(), "sessions-grok-"));
    const action = { type: "search", query: "pi" };
    const chat = writeSession(
      directory,
      "project",
      "session-1",
      [
        { type: "system", content: "secret system" },
        { type: "user", content: [{ type: "text", text: "<user_info> OS Version" }] },
        {
          type: "user",
          synthetic_reason: "system_reminder",
          content: [{ type: "text", text: "<system-reminder> rules" }],
        },
        { type: "user", prompt_index: 0, content: [{ type: "text", text: "fix the build" }] },
        { type: "reasoning", summary: [], encrypted_content: "ciphertext", status: "completed" },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "look at the script" }],
          encrypted_content: "more ciphertext",
          status: "completed",
        },
        {
          type: "assistant",
          content: "",
          tool_calls: [{ id: "call-1", name: "read_file", arguments: '{ "target_file": "a.ts" }' }],
        },
        {
          type: "tool_result",
          tool_call_id: "call-1",
          content: "export const a = 1",
          images: [{ type: "image", url: "data:image/png;base64,aaaa" }],
        },
        {
          type: "backend_tool_call",
          kind: {
            tool_type: "x_search",
            name: "x_keyword_search",
            id: "xs-1",
            call_id: "xs_call",
            input: '{"query":"pi"}',
          },
        },
        {
          type: "backend_tool_call",
          kind: { tool_type: "web_search", id: "ws-1", status: "completed", action },
        },
      ],
      {
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T12:00:00.000Z",
        last_active_at: "2026-09-02T00:00:00.000Z",
        num_messages: 99,
        info: { id: "session-1" },
      },
    );
    writeFileSync(join(directory, "project", "prompt_history.jsonl"), '{"type":"user"}\n');
    writeFileSync(
      join(directory, "project", "session-1", "events.jsonl"),
      `${JSON.stringify({ type: "user", content: [{ type: "text", text: "event" }] })}\n`,
    );
    writeFileSync(chat, `not json\n${readFileSync(chat, "utf8")}`);

    const source = new GrokSource(directory);
    const messages = await collect(source);
    expect(
      messages.map((message) => [message.role, message.blocks.map((block) => block.type)]),
    ).toEqual([
      ["user", ["text"]],
      ["user", ["text"]],
      ["user", ["text"]],
      ["assistant", ["thinking"]],
      ["assistant", ["tool_call"]],
      ["tool", ["tool_result"]],
      ["assistant", ["tool_call"]],
      ["assistant", ["tool_call"]],
    ]);
    expect(JSON.stringify(messages)).not.toContain("secret system");
    expect(JSON.stringify(messages)).not.toContain("ciphertext");
    expect(JSON.stringify(messages)).not.toContain("event");
    expect(messages[1]).toMatchObject({ context: { syntheticReason: "system_reminder" } });
    expect(messages[3]).toMatchObject({
      blocks: [{ type: "thinking", text: "look at the script" }],
    });
    expect(messages[4]).toMatchObject({
      author: { platform: "cli", name: "grok", isBot: true },
      blocks: [
        {
          type: "tool_call",
          toolName: "read_file",
          toolCallId: "call-1",
          toolInput: '{ "target_file": "a.ts" }',
        },
      ],
    });
    expect(messages[5]).toMatchObject({
      blocks: [
        {
          type: "tool_result",
          toolCallId: "call-1",
          text: "export const a = 1\ndata:image/png;base64,aaaa",
        },
      ],
    });
    expect(messages[6]).toMatchObject({
      blocks: [
        {
          type: "tool_call",
          toolName: "x_keyword_search",
          toolCallId: "xs-1",
          toolInput: '{"query":"pi"}',
        },
      ],
    });
    expect(messages[7]).toMatchObject({
      blocks: [
        {
          type: "tool_call",
          toolName: "web_search",
          toolCallId: "ws-1",
          toolInput: JSON.stringify(action),
        },
      ],
    });
    expect(messages[0]).toMatchObject({
      source: "grok",
      sessionId: "session-1",
      timestamp: Date.parse("2026-09-01T00:00:00.000Z"),
      timestampSource: "session",
      channel: { platform: "cli", name: "grok" },
    });
    expect(messages[1]).toMatchObject({ timestamp: Date.parse("2026-09-01T00:00:00.000Z") });
    expect(messages[7]).toMatchObject({ timestamp: Date.parse("2026-09-02T00:00:00.000Z") });

    const page = await listSourceSessions(source, 0, 10);
    expect(page.sessions).toEqual([
      expect.objectContaining({ id: "session-1", snippet: "fix the build", messageCount: 8 }),
    ]);
    const filtered = await readSourceSession(source, "session-1", 0, 20, {
      since: Date.parse("2026-09-01T00:00:00.000Z"),
      until: Date.parse("2026-09-02T00:00:00.000Z"),
    });
    expect(filtered.total).toBe(8);
    expect(filtered.messages).toEqual([]);
  });

  it("keeps a tool result that completed without text", async () => {
    directory = mkdtempSync(join(tmpdir(), "sessions-grok-"));
    writeSession(
      directory,
      "project",
      "empty-result",
      [
        {
          type: "assistant",
          content: "",
          tool_calls: [{ id: "call-empty", name: "bash", arguments: "{}" }],
        },
        { type: "tool_result", tool_call_id: "call-empty", content: "" },
      ],
      {
        created_at: "2026-09-01T00:00:00.000Z",
        last_active_at: "2026-09-02T00:00:00.000Z",
      },
    );
    const messages = await collect(new GrokSource(directory));
    expect(messages.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(messages[1]).toMatchObject({
      timestamp: Date.parse("2026-09-02T00:00:00.000Z"),
      blocks: [{ type: "tool_result", toolCallId: "call-empty", text: "" }],
    });
  });

  it("uses the file time when the summary is missing and ignores unsafe ids", async () => {
    directory = mkdtempSync(join(tmpdir(), "sessions-grok-"));
    const chat = writeSession(directory, "project", "real", [
      { type: "user", content: [{ type: "text", text: "kept" }] },
    ]);
    writeSession(directory, "other", "other-id", [{ type: "assistant", content: "elsewhere" }]);
    writeFileSync(
      join(directory, "chat_history.jsonl"),
      `${JSON.stringify({ type: "user", content: [{ type: "text", text: "escaped" }] })}\n`,
    );
    const instant = "2026-09-20T12:00:00.000Z";
    utimesSync(chat, new Date(instant), new Date(instant));
    const source = new GrokSource(directory);

    expect(await collect(source, "..")).toEqual([]);
    expect(await collect(source, "project/real")).toEqual([]);
    const selected = await collect(source, "real");
    expect(selected.map((message) => message.blocks[0]?.text)).toEqual(["kept"]);
    expect(selected[0]).toMatchObject({
      timestamp: Date.parse(instant),
      timestampSource: "file",
    });
    expect((await collect(source)).map((message) => message.sessionId).sort()).toEqual([
      "other-id",
      "real",
    ]);
    expect(new GrokSource(join(directory, "missing")).available()).toBe(false);
  });

  it("reads $GROK_HOME/sessions when no path is passed", async () => {
    directory = mkdtempSync(join(tmpdir(), "sessions-grok-home-"));
    writeSession(join(directory, "sessions"), "project", "home-id", [
      { type: "user", content: [{ type: "text", text: "from home" }] },
    ]);
    const previous = process.env.GROK_HOME;
    process.env.GROK_HOME = directory;
    try {
      const sessions = await create("grok").list();
      expect(sessions.map((session) => session.id)).toEqual(["home-id"]);
      expect(sessions[0]?.messages[0]?.blocks[0]?.text).toBe("from home");
    } finally {
      if (previous === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = previous;
    }
  });
});
