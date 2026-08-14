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

async function collect(source: CodexSource): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const m of source.read()) messages.push(m);
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

  it("keeps each user turn while skipping its mirrored event", async () => {
    writeJsonl("session-4.jsonl", [
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:00Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "first user message" }],
        },
      },
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
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:01Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "second user message" }],
        },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(2);
    expect(msgs.map((message) => message.blocks[0].text)).toEqual([
      "first user message",
      "second user message",
    ]);
  });

  it("keeps consecutive event-only user messages", async () => {
    writeJsonl("session-5.jsonl", [
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

    expect(msgs).toHaveLength(2);
    expect(msgs.map((message) => message.blocks[0].text)).toEqual([
      "first user message",
      "second user message",
    ]);
  });

  it("keeps adjacent user records with different text", async () => {
    writeJsonl("session-6.jsonl", [
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:00Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "first user message" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-03-10T10:00:01Z",
        payload: { type: "user_message", message: "second user message" },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs.map((message) => message.blocks[0].text)).toEqual([
      "first user message",
      "second user message",
    ]);
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

describe("CodexSource error handling", () => {
  it("skips malformed JSONL lines and continues", async () => {
    writeFileSync(
      join(tempDir, "mixed.jsonl"),
      [
        "not valid json {{{",
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-03-10T10:00:00Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "survived" }],
          },
        }),
        "{truncated",
      ].join("\n"),
    );
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("survived");
  });

  it("skips corrupted JSON files gracefully", async () => {
    writeFileSync(join(tempDir, "bad.json"), "not json at all");
    writeJsonl("good.jsonl", [
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:00Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "from jsonl" }],
        },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("from jsonl");
  });

  it("skips response_item with null payload", async () => {
    writeJsonl("null-payload.jsonl", [
      { type: "response_item", timestamp: "2026-03-10T10:00:00Z", payload: null },
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:01Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "valid" }],
        },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("valid");
  });

  it("skips message with empty content array", async () => {
    writeJsonl("empty-content.jsonl", [
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:00Z",
        payload: { type: "message", role: "assistant", content: [] },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("skips function_call_output with empty output", async () => {
    writeJsonl("empty-output.jsonl", [
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:00Z",
        payload: { type: "function_call_output", call_id: "fc-1", output: "" },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("available() returns false for non-existent directory", () => {
    const missingDir = join(tempDir, "nonexistent-codex-dir");
    const source = new CodexSource(missingDir);
    expect(source.available()).toBe(false);
  });

  it("JSON session falls back to filename sessionId when session.id missing", async () => {
    writeJson("fallback-session.json", {
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    });
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].sessionId).toBe("fallback-session");
  });
});
