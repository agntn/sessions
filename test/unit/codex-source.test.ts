import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zstdCompressSync } from "node:zlib";
import { CodexSource } from "../../src/sources/codex.ts";
import type { Message, SourceReadOptions } from "../../src/core/types.ts";

let tempDir: string;

function writeJsonl(filename: string, lines: readonly Readonly<Record<string, unknown>>[]): void {
  writeFileSync(join(tempDir, filename), lines.map((l) => JSON.stringify(l)).join("\n"));
}

function writeJson(filename: string, data: Readonly<Record<string, unknown>>): void {
  writeFileSync(join(tempDir, filename), JSON.stringify(data));
}

async function collect(
  source: Readonly<CodexSource>,
  options?: SourceReadOptions,
): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const m of source.read(options)) messages.push(m);
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

  it("keeps a record whose text holds U+2028 and U+2029", async () => {
    writeJsonl("session-1.jsonl", [
      {
        type: "event_msg",
        timestamp: "2026-03-10T10:00:00Z",
        payload: { type: "user_message", message: "one two three" },
      },
      {
        type: "event_msg",
        timestamp: "2026-03-10T10:00:01Z",
        payload: { type: "user_message", message: "after" },
      },
    ]);
    const msgs = await collect(new CodexSource(tempDir));

    expect(msgs.map((m) => m.blocks[0].text)).toEqual(["one two three", "after"]);
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

  it("parses custom tool calls and textual output items", async () => {
    writeJsonl("session-custom.jsonl", [
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:04Z",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "custom-1",
          input: "*** Begin Patch",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:05Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "custom-1",
          output: [
            { type: "input_text", text: "Chunk ID: 123" },
            { type: "input_text", text: "Process exited with code 0" },
          ],
        },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(2);
    expect(msgs[0].blocks[0]).toEqual({
      type: "tool_call",
      toolName: "apply_patch",
      toolCallId: "custom-1",
      toolInput: "*** Begin Patch",
    });
    expect(msgs[1].blocks[0]).toEqual({
      type: "tool_result",
      toolCallId: "custom-1",
      text: "Chunk ID: 123\nProcess exited with code 0",
    });
  });

  it("keeps reasoning summaries and raw text as thinking blocks", async () => {
    writeJsonl("session-reasoning.jsonl", [
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:06Z",
        payload: {
          type: "reasoning",
          id: "rs_1",
          summary: [
            { type: "summary_text", text: "**Inspecting the parser**" },
            { type: "summary_text", text: "**Choosing a fix**" },
          ],
          content: [{ type: "reasoning_text", text: "The parser drops every reasoning item." }],
          encrypted_content: "gAAAAA",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:07Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "I will keep them." }],
        },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].author).toEqual({ platform: "cli", name: "codex", isBot: true });
    expect(msgs[0].blocks).toEqual([
      { type: "thinking", text: "**Inspecting the parser**" },
      { type: "thinking", text: "**Choosing a fix**" },
      { type: "thinking", text: "The parser drops every reasoning item." },
    ]);
    expect(msgs[1].blocks).toEqual([{ type: "text", text: "I will keep them." }]);
  });

  it("skips reasoning that carries only encrypted content", async () => {
    writeJsonl("session-encrypted.jsonl", [
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:08Z",
        payload: { type: "reasoning", id: "rs_2", summary: [], encrypted_content: "gAAAAA" },
      },
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:09Z",
        payload: { type: "reasoning", id: "rs_3", summary: [{ type: "summary_text", text: "" }] },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
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

  it("keeps repeated text from different turns", async () => {
    writeJsonl("session-7.jsonl", [
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:00Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "continue" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-03-10T10:00:01Z",
        payload: { type: "user_message", message: "continue" },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(2);
  });

  it("deduplicates mirrors separated by other records", async () => {
    writeJsonl("session-8.jsonl", [
      {
        type: "event_msg",
        timestamp: "2026-03-10T10:00:00Z",
        payload: { type: "user_message", message: "continue" },
      },
      {
        type: "event_msg",
        timestamp: "2026-03-10T10:00:00Z",
        payload: { type: "token_count", info: { total_token_usage: {} } },
      },
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:00Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "continue" }],
        },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("continue");
  });

  it("deduplicates reverse-order mirrors separated by other records", async () => {
    writeJsonl("session-9.jsonl", [
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:00Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "continue" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-03-10T10:00:00Z",
        payload: { type: "token_count", info: { total_token_usage: {} } },
      },
      {
        type: "event_msg",
        timestamp: "2026-03-10T10:00:00Z",
        payload: { type: "user_message", message: "continue" },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("continue");
  });

  it("pairs repeated mirrors one-to-one at the same timestamp", async () => {
    writeJsonl("session-10.jsonl", [
      {
        type: "response_item",
        timestamp: "2026-03-10T10:00:00Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "continue" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-03-10T10:00:00Z",
        payload: { type: "token_count", info: { total_token_usage: {} } },
      },
      ...Array.from({ length: 2 }, () => ({
        type: "event_msg",
        timestamp: "2026-03-10T10:00:00Z",
        payload: { type: "user_message", message: "continue" },
      })),
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(2);
  });

  it("preserves ambiguous mirrors without timestamps", async () => {
    writeJsonl("session-11.jsonl", [
      {
        type: "event_msg",
        payload: { type: "user_message", message: "continue" },
      },
      {
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: {} } },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "continue" }],
        },
      },
    ]);
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(2);
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

  it("opens only the rollout named after the requested session", async () => {
    const message = {
      type: "response_item",
      timestamp: "2026-03-10T10:00:00Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello" }],
      },
    };
    writeJsonl("rollout-2026-03-10T10-00-00-wanted.jsonl", [message]);
    writeJsonl("rollout-2026-03-10T10-00-01-other.jsonl", [message]);
    symlinkSync(
      join(tempDir, "missing.jsonl"),
      join(tempDir, "rollout-2026-03-10T10-00-02-trap.jsonl"),
    );
    const source = new CodexSource(tempDir);

    await expect(collect(source)).rejects.toThrow(/ENOENT/);

    const msgs = await collect(source, { sessionId: "wanted" });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].sessionId).toBe("wanted");
  });

  it("reads a rollout Codex compressed", async () => {
    const lines = [
      { type: "session_meta", payload: { cwd: "/home/user/project" } },
      {
        type: "event_msg",
        timestamp: "2026-03-10T10:00:00Z",
        payload: { type: "user_message", message: "still here" },
      },
    ];
    const text = lines.map((l) => JSON.stringify(l)).join("\n");
    writeFileSync(
      join(tempDir, "rollout-2026-03-10T10-00-00-cold.jsonl.zst"),
      zstdCompressSync(text),
    );
    const msgs = await collect(new CodexSource(tempDir), { sessionId: "cold" });

    expect(msgs).toHaveLength(1);
    expect(msgs[0].sessionId).toBe("cold");
    expect(msgs[0].blocks).toEqual([{ type: "text", text: "still here" }]);
    expect(msgs[0].context).toEqual({ cwd: "/home/user/project" });
  });

  it("prefers the plain rollout over its compressed copy", async () => {
    const line = (message: string): string =>
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-03-10T10:00:00Z",
        payload: { type: "user_message", message },
      });
    writeFileSync(join(tempDir, "rollout-2026-03-10T10-00-00-warm.jsonl"), line("plain"));
    writeFileSync(
      join(tempDir, "rollout-2026-03-10T10-00-00-warm.jsonl.zst"),
      zstdCompressSync(line("stale")),
    );
    const msgs = await collect(new CodexSource(tempDir));

    expect(msgs.map((m) => m.blocks[0].text)).toEqual(["plain"]);
  });

  it("skips rollouts whose header names another directory", async () => {
    const turn = (text: string) => ({
      type: "event_msg",
      timestamp: "2026-03-10T10:00:00Z",
      payload: { type: "user_message", message: text },
    });
    const meta = (cwd: string) => ({ type: "session_meta", payload: { id: "x", cwd } });
    writeJsonl("rollout-2026-03-10T10-00-00-here.jsonl", [meta("/work/app"), turn("here")]);
    writeJsonl("rollout-2026-03-10T10-00-01-below.jsonl", [meta("/work/app/web"), turn("below")]);
    writeJsonl("rollout-2026-03-10T10-00-02-sibling.jsonl", [
      meta("/work/app-two"),
      turn("sibling"),
    ]);
    writeFileSync(
      join(tempDir, "rollout-2026-03-10T10-00-03-packed.jsonl.zst"),
      zstdCompressSync(
        [meta("/elsewhere"), turn("packed")].map((l) => JSON.stringify(l)).join("\n"),
      ),
    );
    writeJsonl("rollout-2026-03-10T10-00-04-legacy.jsonl", [
      { id: "legacy", timestamp: "2026-03-10T10:00:00Z", instructions: "" },
      turn("legacy"),
    ]);
    writeJson("rollout-2026-03-10T10-00-05-old.json", {
      session: { id: "old", timestamp: "2026-03-10T10:00:00Z" },
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "old" }] }],
    });
    const source = new CodexSource(tempDir);
    const texts = async (cwd?: string): Promise<string[]> =>
      (await collect(source, { cwd })).map((m) => m.blocks[0].text ?? "").sort();

    expect(await texts("/work/app")).toEqual(["below", "here", "legacy", "old"]);
    expect(await texts("/elsewhere/")).toEqual(["legacy", "old", "packed"]);
    expect(await texts()).toHaveLength(6);
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

describe("CodexSource archived sessions", () => {
  /* One user turn, zstd compressed for a `.zst` name like Codex archives. */
  function rollout(path: string, message: string, written: string): void {
    const file = join(tempDir, path);
    const line = JSON.stringify({
      type: "event_msg",
      timestamp: written,
      payload: { type: "user_message", message },
    });
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, file.endsWith(".zst") ? zstdCompressSync(line) : line);
    utimesSync(file, new Date(written), new Date(written));
  }

  beforeEach(() => {
    vi.stubEnv("HOME", tempDir);
    rollout(
      ".codex/sessions/2026/03/10/rollout-2026-03-10T10-00-00-live.jsonl",
      "live",
      "2026-03-10T10:00:00Z",
    );
    rollout(
      ".codex/archived_sessions/rollout-2026-03-09T10-00-00-shelved.jsonl.zst",
      "shelved",
      "2026-03-09T10:00:00Z",
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the archive beside the dated tree by default", async () => {
    const msgs = await collect(new CodexSource());

    expect(msgs.map((m) => [m.sessionId, m.blocks[0].text])).toEqual([
      ["shelved", "shelved"],
      ["live", "live"],
    ]);
  });

  it("finds a session that lives only in the archive", async () => {
    const msgs = await collect(new CodexSource(), { sessionId: "shelved" });

    expect(msgs.map((m) => m.blocks[0].text)).toEqual(["shelved"]);
  });

  it("is available with only an archive on disk", () => {
    rmSync(join(tempDir, ".codex/sessions"), { recursive: true });

    expect(new CodexSource().available()).toBe(true);
  });

  it("reads only the directory an override names", async () => {
    const msgs = await collect(new CodexSource(join(tempDir, ".codex/sessions")));

    expect(msgs.map((m) => m.sessionId)).toEqual(["live"]);
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

  it("keeps reasoning summaries in JSON items", async () => {
    writeJson("session-reasoning.json", {
      session: { id: "ses-rs", timestamp: "2026-03-10T10:00:00Z" },
      items: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "**Reading the diff**" }],
          encrypted_content: "gAAAAA",
        },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
      ],
    });
    const source = new CodexSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].blocks).toEqual([{ type: "thinking", text: "**Reading the diff**" }]);
    expect(msgs[1].blocks[0].text).toBe("Done.");
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

  it("settles a JSON session filter from the id inside the file", async () => {
    const items = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ];
    writeJson("rollout-2026-03-10-renamed.json", { session: { id: "wanted" }, items });
    writeJson("rollout-2026-03-10-other.json", { session: { id: "other" }, items });
    const source = new CodexSource(tempDir);

    const msgs = await collect(source, { sessionId: "wanted" });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].sessionId).toBe("wanted");
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
