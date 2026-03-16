import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexSource } from "../../src/sources/codex.ts";
import type { Message } from "../../src/core/types.ts";

let tempDir: string;

function writeJsonl(filename: string, lines: Record<string, unknown>[]): void {
  writeFileSync(join(tempDir, filename), lines.map((l) => JSON.stringify(l)).join("\n"));
}

function writeJson(filename: string, data: Record<string, unknown>): void {
  writeFileSync(join(tempDir, filename), JSON.stringify(data));
}

async function collect(source: CodexSource, cursor = "0"): Promise<Message[]> {
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

describe("CodexSource JSONL", () => {
  it("parses user event_msg", async () => {
    writeJsonl("rollout-2026-03-10T10-00-00-abc123.jsonl", [
      { type: "session_meta", payload: { cwd: "/home/user/project" } },
      {
        type: "event_msg",
        timestamp: "2026-03-10T10:00:00Z",
        payload: { type: "user_message", message: "fix the bug" },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].blocks).toEqual([{ type: "text", text: "fix the bug" }]);
    expect(msgs[0].context).toEqual({ cwd: "/home/user/project" });
    expect(msgs[0].source).toBe("codex");
  });

  it("parses assistant response_item message", async () => {
    writeJsonl("session-1.jsonl", [
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:01Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "I will fix it" }],
        },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].blocks).toEqual([{ type: "text", text: "I will fix it" }]);
    expect(msgs[0].author).toEqual({ platform: "cli", name: "codex", isBot: true });
  });

  it("parses function_call as tool_call", async () => {
    writeJsonl("session-2.jsonl", [
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:02Z",
        payload: {
          type: "function_call",
          name: "edit_file",
          call_id: "fc-1",
          arguments: '{"path":"/foo"}',
        },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].blocks[0]).toEqual({
      type: "tool_call",
      toolName: "edit_file",
      toolCallId: "fc-1",
      toolInput: '{"path":"/foo"}',
    });
  });

  it("parses function_call_output as tool_result", async () => {
    writeJsonl("session-3.jsonl", [
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:03Z",
        payload: { type: "function_call_output", call_id: "fc-1", output: "done" },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("tool");
    expect(msgs[0].blocks[0]).toEqual({
      type: "tool_result",
      toolCallId: "fc-1",
      text: "done",
    });
  });

  it("only uses first user_message event (seenUserEvent)", async () => {
    writeJsonl("session-4.jsonl", [
      {
        type: "event_msg",
        timestamp: "2026-03-10T10:00:00Z",
        payload: { type: "user_message", message: "first user message" },
      },
      {
        type: "event_msg",
        timestamp: "2026-03-10T10:00:01Z",
        payload: { type: "user_message", message: "second user message" },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("first user message");
  });

  it("skips duplicate user response_item when event_msg already seen", async () => {
    writeJsonl("session-5.jsonl", [
      {
        type: "event_msg",
        timestamp: "2026-03-10T10:00:00Z",
        payload: { type: "user_message", message: "event user msg" },
      },
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:01Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "response user msg" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:02Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "assistant reply" }],
        },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(2);
    expect(msgs[0].blocks[0].text).toBe("event user msg");
    expect(msgs[1].blocks[0].text).toBe("assistant reply");
  });

  it("extracts sessionId from rollout filename pattern", async () => {
    writeJsonl("rollout-2026-03-10T10-00-00-mySessionId.jsonl", [
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:00Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello" }],
        },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs[0].sessionId).toBe("mySessionId");
  });

  it("falls back to full filename for non-rollout files", async () => {
    writeJsonl("custom-session.jsonl", [
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:00Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello" }],
        },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs[0].sessionId).toBe("custom-session");
  });

  it("preserves short text blocks but skips empty ones", async () => {
    writeJsonl("session-6.jsonl", [
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:00Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:01Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("ok");
  });
});

describe("CodexSource JSON", () => {
  it("parses JSON session with items array", async () => {
    writeJson("session-json.json", {
      session: { id: "ses-json", timestamp: "2026-03-10T10:00:00Z" },
      items: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hi there" }],
        },
      ],
    });
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].sessionId).toBe("ses-json");
    expect(msgs[0].blocks[0].text).toBe("hello");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].blocks[0].text).toBe("hi there");
  });

  it("skips developer role in JSON format", async () => {
    writeJson("session-dev.json", {
      session: { id: "ses-dev" },
      items: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "system" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "user msg" }] },
      ],
    });
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("user msg");
  });

  it("handles empty items array", async () => {
    writeJson("session-empty.json", {
      session: { id: "ses-empty" },
      items: [],
    });
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("parses function_call in JSON items", async () => {
    writeJson("session-fc.json", {
      session: { id: "ses-fc", timestamp: "2026-03-10T10:00:00Z" },
      items: [
        {
          type: "function_call",
          name: "read_file",
          call_id: "fc-1",
          arguments: '{"path":"/bar"}',
        },
      ],
    });
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0]).toEqual({
      type: "tool_call",
      toolName: "read_file",
      toolCallId: "fc-1",
      toolInput: '{"path":"/bar"}',
    });
  });
});

describe("CodexSource cursor", () => {
  it("filters by cursor across formats", async () => {
    const ts = new Date("2026-03-10T10:00:00Z").getTime();
    writeJsonl("old.jsonl", [
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:00Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "old jsonl" }],
        },
      },
    ]);
    writeJson("old.json", {
      session: { id: "ses-old", timestamp: "2026-03-10T10:00:00Z" },
      items: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "old json" }] },
      ],
    });
    writeJsonl("new.jsonl", [
      {
        type: "response_item",
        timestamp: "2026-03-10T12:00:00Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "new jsonl" }],
        },
      },
    ]);
    writeJson("new.json", {
      session: { id: "ses-new", timestamp: "2026-03-10T12:00:00Z" },
      items: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "new json" }] },
      ],
    });
    const source = new CodexSource(tempDir);
    const msgs = await collect(source, String(ts));

    expect(msgs).toHaveLength(2);
    const texts = msgs.map((m) => m.blocks[0].text);
    expect(texts).toContain("new jsonl");
    expect(texts).toContain("new json");
  });

  it("cursor() returns max timestamp as string", () => {
    const source = new CodexSource(tempDir);
    const msgs: Message[] = [
      {
        source: "codex",
        sessionId: "s1",
        role: "user",
        timestamp: 200,
        date: "1970-01-01",
        blocks: [{ type: "text", text: "a" }],
      },
      {
        source: "codex",
        sessionId: "s1",
        role: "user",
        timestamp: 400,
        date: "1970-01-01",
        blocks: [{ type: "text", text: "b" }],
      },
    ];

    expect(source.cursor(msgs)).toBe("400");
    expect(source.cursor([])).toBe("0");
  });
});
