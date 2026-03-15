import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenClawSource } from "../../src/sources/openclaw.ts";
import type { Message } from "../../src/core/types.ts";

let tempDir: string;

function writeJsonl(filename: string, lines: Record<string, unknown>[]): void {
  writeFileSync(join(tempDir, filename), lines.map((l) => JSON.stringify(l)).join("\n"));
}

async function collect(source: OpenClawSource, cursor = "0"): Promise<Message[]> {
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

describe("OpenClawSource basic parsing", () => {
  it("parses user and assistant messages", async () => {
    writeJsonl("session-1.jsonl", [
      { type: "session", timestamp: "2026-03-10T10:00:00Z" },
      {
        type: "message",
        timestamp: "2026-03-10T10:00:01Z",
        message: { role: "user", content: [{ type: "text", text: "hello from user" }] },
      },
      {
        type: "message",
        timestamp: "2026-03-10T10:00:02Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello from assistant" }],
        },
      },
    ]);
    const source = new OpenClawSource([tempDir]);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].blocks[0].text).toBe("hello from user");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].blocks[0].text).toBe("hello from assistant");
    expect(msgs[0].source).toBe("openclaw");
    expect(msgs[0].sessionId).toBe("session-1");
  });

  it("parses toolCall block", async () => {
    writeJsonl("session-tc.jsonl", [
      {
        type: "message",
        timestamp: "2026-03-10T10:00:00Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "search", id: "tc-1", input: "query text" }],
        },
      },
    ]);
    const source = new OpenClawSource([tempDir]);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0]).toEqual({
      type: "tool_call",
      toolName: "search",
      toolCallId: "tc-1",
      toolInput: "query text",
    });
  });

  it("parses toolResult block with string content", async () => {
    writeJsonl("session-tr.jsonl", [
      {
        type: "message",
        timestamp: "2026-03-10T10:00:00Z",
        message: {
          role: "assistant",
          content: [{ type: "toolResult", id: "tc-1", content: "search results" }],
        },
      },
    ]);
    const source = new OpenClawSource([tempDir]);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0]).toEqual({
      type: "tool_result",
      toolCallId: "tc-1",
      text: "search results",
    });
  });

  it("parses toolResult block with array content", async () => {
    writeJsonl("session-tra.jsonl", [
      {
        type: "message",
        timestamp: "2026-03-10T10:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolResult",
              id: "tc-2",
              content: [
                { type: "text", text: "result line 1" },
                { type: "text", text: "result line 2" },
              ],
            },
          ],
        },
      },
    ]);
    const source = new OpenClawSource([tempDir]);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0]).toEqual({
      type: "tool_result",
      toolCallId: "tc-2",
      text: "result line 1\nresult line 2",
    });
  });

  it("uses session timestamp as fallback when message has no timestamp", async () => {
    writeJsonl("session-fallback.jsonl", [
      { type: "session", timestamp: "2026-03-10T10:00:00Z" },
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "no timestamp" }] },
      },
    ]);
    const source = new OpenClawSource([tempDir]);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].timestamp).toBe(new Date("2026-03-10T10:00:00Z").getTime());
  });

  it("filters by cursor", async () => {
    const ts = new Date("2026-03-10T10:00:01Z").getTime();
    writeJsonl("session-cur.jsonl", [
      {
        type: "message",
        timestamp: "2026-03-10T10:00:01Z",
        message: { role: "user", content: [{ type: "text", text: "old" }] },
      },
      {
        type: "message",
        timestamp: "2026-03-10T12:00:00Z",
        message: { role: "user", content: [{ type: "text", text: "new" }] },
      },
    ]);
    const source = new OpenClawSource([tempDir]);
    const msgs = await collect(source, String(ts));

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("new");
  });

  it("skips unknown roles", async () => {
    writeJsonl("session-roles.jsonl", [
      {
        type: "message",
        timestamp: "2026-03-10T10:00:00Z",
        message: { role: "system", content: [{ type: "text", text: "skip" }] },
      },
      {
        type: "message",
        timestamp: "2026-03-10T10:00:01Z",
        message: { role: "user", content: [{ type: "text", text: "keep" }] },
      },
    ]);
    const source = new OpenClawSource([tempDir]);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("keep");
  });
});

describe("OpenClawSource Discord header parsing", () => {
  it("parses Discord DM header", async () => {
    writeJsonl("session-dm.jsonl", [
      {
        type: "message",
        timestamp: "2026-03-10T10:00:00Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "[Discord alice user id:12345 some stuff] hello there",
            },
          ],
        },
      },
    ]);
    const source = new OpenClawSource([tempDir]);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].context?.origin).toBe("discord:dm");
    expect(msgs[0].context?.username).toBe("alice");
    expect(msgs[0].context?.userId).toBe("12345");
    expect(msgs[0].channel).toEqual({ platform: "discord", type: "dm" });
    expect(msgs[0].author?.platform).toBe("discord");
    expect(msgs[0].author?.name).toBe("alice");
    expect(msgs[0].author?.platformId).toBe("12345");
  });

  it("parses Discord Guild header", async () => {
    writeJsonl("session-guild.jsonl", [
      {
        type: "message",
        timestamp: "2026-03-10T10:00:00Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "[Discord Guild #general channel id:67890 guildname] alice: hello",
            },
          ],
        },
      },
    ]);
    const source = new OpenClawSource([tempDir]);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].context?.origin).toBe("discord:guild");
    expect(msgs[0].context?.channel).toBe("general");
    expect(msgs[0].context?.channelId).toBe("67890");
    expect(msgs[0].channel).toEqual({
      platform: "discord",
      type: "guild",
      platformId: "67890",
      name: "general",
    });
  });

  it("extracts [from: user (id)] within guild messages", async () => {
    writeJsonl("session-from.jsonl", [
      {
        type: "message",
        timestamp: "2026-03-10T10:00:00Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "[Discord Guild #dev channel id:111 server] bob (222): [from: charlie (333)] hey",
            },
          ],
        },
      },
    ]);
    const source = new OpenClawSource([tempDir]);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].context?.username).toBe("charlie");
    expect(msgs[0].context?.userId).toBe("333");
    expect(msgs[0].author?.name).toBe("charlie");
    expect(msgs[0].author?.platformId).toBe("333");
  });
});

describe("OpenClawSource session classification", () => {
  it("classifies cron sessions", async () => {
    writeJsonl("session-cron.jsonl", [
      {
        type: "message",
        timestamp: "2026-03-10T10:00:00Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "[cron:abc-123 daily-check] run the check" }],
        },
      },
    ]);
    const source = new OpenClawSource([tempDir]);
    const msgs = await collect(source);

    expect(msgs[0].context?.origin).toBe("cron");
    expect(msgs[0].context?.cronId).toBe("abc-123");
    expect(msgs[0].context?.cronTask).toBe("daily-check");
    expect(msgs[0].channel).toEqual({ platform: "system", type: "cron" });
  });

  it("classifies heartbeat sessions", async () => {
    writeJsonl("session-hb.jsonl", [
      {
        type: "message",
        timestamp: "2026-03-10T10:00:00Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "HEARTBEAT check status" }],
        },
      },
    ]);
    const source = new OpenClawSource([tempDir]);
    const msgs = await collect(source);

    expect(msgs[0].context?.origin).toBe("heartbeat");
    expect(msgs[0].channel).toEqual({ platform: "system", type: "heartbeat" });
  });

  it("classifies interactive sessions as default", async () => {
    writeJsonl("session-int.jsonl", [
      {
        type: "message",
        timestamp: "2026-03-10T10:00:00Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "just a normal message" }],
        },
      },
    ]);
    const source = new OpenClawSource([tempDir]);
    const msgs = await collect(source);

    expect(msgs[0].context?.origin).toBe("interactive");
    expect(msgs[0].channel).toEqual({ platform: "cli", type: "interactive" });
  });
});

describe("OpenClawSource multi-dir support", () => {
  it("accepts multiple sessionsDirs and reads from both", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "memxa-test-"));
    try {
      writeJsonl("session-a.jsonl", [
        {
          type: "message",
          timestamp: "2026-03-10T10:00:00Z",
          message: { role: "user", content: [{ type: "text", text: "from dir 1" }] },
        },
      ]);
      writeFileSync(
        join(dir2, "session-b.jsonl"),
        JSON.stringify({
          type: "message",
          timestamp: "2026-03-10T10:00:01Z",
          message: { role: "user", content: [{ type: "text", text: "from dir 2" }] },
        }),
      );

      const source = new OpenClawSource([tempDir, dir2]);
      const msgs = await collect(source);

      expect(msgs).toHaveLength(2);
      const texts = msgs.map((m) => m.blocks[0].text);
      expect(texts).toContain("from dir 1");
      expect(texts).toContain("from dir 2");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("cursor() returns max timestamp", () => {
    const source = new OpenClawSource([tempDir]);
    const msgs: Message[] = [
      {
        source: "openclaw",
        sessionId: "s1",
        role: "user",
        timestamp: 100,
        date: "1970-01-01",
        blocks: [{ type: "text", text: "a" }],
      },
      {
        source: "openclaw",
        sessionId: "s1",
        role: "user",
        timestamp: 300,
        date: "1970-01-01",
        blocks: [{ type: "text", text: "b" }],
      },
    ];

    expect(source.cursor(msgs[1])).toBe("300");
  });
});
