import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message, Source } from "../../src/core/types.ts";
import { ClaudeSource } from "../../src/sources/claude.ts";
import { GeminiSource } from "../../src/sources/gemini.ts";
import { GrokSource } from "../../src/sources/grok.ts";
import { MastraSource } from "../../src/sources/mastra.ts";
import { OmpSource } from "../../src/sources/omp.ts";
import { OpenBotSource } from "../../src/sources/openbot.ts";
import { OpenClawSource } from "../../src/sources/openclaw.ts";
import { OpenCodeSource } from "../../src/sources/opencode.ts";
import { PiSource } from "../../src/sources/pi.ts";

const CWD = "/work/project";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sessions-cwd-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/* Every message's `context.cwd`, `undefined` where a message has none. */
async function cwds(source: Readonly<Source>): Promise<(string | undefined)[]> {
  const messages: Message[] = [];
  for await (const message of source.read()) messages.push(message);
  expect(messages.length).toBeGreaterThan(0);
  return messages.map((message) => message.context?.cwd);
}

function jsonl(path: string, entries: readonly unknown[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

async function sqlite(path: string, statements: readonly string[]): Promise<void> {
  const db = createClient({ url: `file:${path}` });
  try {
    for (const sql of statements) await db.execute(sql);
  } finally {
    db.close();
  }
}

const piMessage = (text: string) => ({
  type: "message",
  timestamp: "2026-11-01T10:00:01.000Z",
  message: { role: "user", content: [{ type: "text", text }] },
});

describe("context.cwd", () => {
  it.each([
    ["pi", PiSource],
    ["omp", OmpSource],
  ])("comes from the %s session header", async (_name, Reader) => {
    jsonl(join(directory, "with.jsonl"), [
      { type: "session", id: "with", cwd: CWD },
      piMessage("here"),
    ]);
    jsonl(join(directory, "without.jsonl"), [{ type: "session", id: "without" }, piMessage("x")]);

    expect(new Set(await cwds(new Reader(directory)))).toEqual(new Set([CWD, undefined]));
  });

  it("follows Claude Code entries, each of which names its own cwd", async () => {
    const user = (text: string, cwd?: string) => ({
      type: "user",
      timestamp: "2026-11-01T10:00:00.000Z",
      ...(cwd ? { cwd } : {}),
      message: { content: text },
    });
    jsonl(join(directory, "project", "session.jsonl"), [
      { type: "custom-title", customTitle: "no cwd yet" },
      user("before"),
      user("start", CWD),
      user("moved", "/work/other"),
    ]);

    expect(await cwds(new ClaudeSource(directory))).toEqual([undefined, CWD, "/work/other"]);
  });

  it("comes from the OpenClaw header without touching its Discord context", async () => {
    jsonl(join(directory, "session.jsonl"), [
      { type: "session", timestamp: "2026-11-01T10:00:00Z", cwd: CWD },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "[Discord Guild #general channel id:1] alice: hi" }],
        },
      },
    ]);
    const messages: Message[] = [];
    for await (const message of new OpenClawSource([directory]).read()) messages.push(message);

    expect(messages[0]?.context).toMatchObject({ cwd: CWD, origin: "discord:guild" });
    expect(messages[0]?.author?.name).toBe("alice");
  });

  it("comes from Grok's summary.json, not from the project folder name", async () => {
    const session = join(directory, "%2Fsomewhere%2Felse", "session-1");
    jsonl(join(session, "chat_history.jsonl"), [
      { type: "user", content: [{ type: "text", text: "hi" }] },
      { type: "assistant", content: "hello" },
    ]);
    writeFileSync(join(session, "summary.json"), JSON.stringify({ info: { cwd: CWD } }));
    const bare = join(directory, "%2Fguess%2Fme", "session-2");
    jsonl(join(bare, "chat_history.jsonl"), [{ type: "assistant", content: "no summary" }]);

    expect(new Set(await cwds(new GrokSource(directory)))).toEqual(new Set([CWD, undefined]));
  });

  it("comes from Gemini's .project_root, and a hashed folder without one says nothing", async () => {
    const chat = { messages: [{ type: "user", content: "hi", timestamp: "2026-11-01T10:00:00Z" }] };
    for (const project of ["project", "4f2c0d9e"]) {
      mkdirSync(join(directory, project, "chats"), { recursive: true });
      writeFileSync(join(directory, project, "chats", `${project}.json`), JSON.stringify(chat));
    }
    writeFileSync(join(directory, "project", ".project_root"), CWD);

    expect(new Set(await cwds(new GeminiSource(directory)))).toEqual(new Set([CWD, undefined]));
  });

  it("comes from the OpenCode session row", async () => {
    const path = join(directory, "opencode.db");
    await sqlite(path, [
      "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL)",
      "CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT)",
      "CREATE TABLE part (session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT)",
      `INSERT INTO session VALUES ('known', '${CWD}')`,
      `INSERT INTO message VALUES ('m', '{"role":"user"}')`,
      `INSERT INTO part VALUES ('known', 'm', 100, '{"type":"text","text":"a"}'),
        ('orphan', 'm', 200, '{"type":"text","text":"b"}')`,
    ]);

    expect(await cwds(new OpenCodeSource(path))).toEqual([CWD, undefined]);
  });

  it("comes from the projectPath in Mastra's JSONB thread metadata", async () => {
    const path = join(directory, "mastra.db");
    await sqlite(path, [
      `CREATE TABLE mastra_messages (id TEXT, thread_id TEXT, content TEXT, role TEXT,
        type TEXT, createdAt TEXT, resourceId TEXT)`,
      "CREATE TABLE mastra_threads (id TEXT PRIMARY KEY, resourceId TEXT, title TEXT, metadata TEXT)",
      `INSERT INTO mastra_threads VALUES ('jsonb', 'r', 't', jsonb('{"projectPath":"${CWD}"}')),
        ('text', 'r', 't', '{"projectPath":"/work/text"}'), ('broken', 'r', 't', 'not json')`,
      `INSERT INTO mastra_messages VALUES
        ('1', 'jsonb', 'a', 'user', 'v2', '2026-11-01T10:00:00.000Z', 'r'),
        ('2', 'text', 'b', 'user', 'v2', '2026-11-01T10:00:01.000Z', 'r'),
        ('3', 'broken', 'c', 'user', 'v2', '2026-11-01T10:00:02.000Z', 'r'),
        ('4', 'missing', 'd', 'user', 'v2', '2026-11-01T10:00:03.000Z', 'r')`,
    ]);

    expect(await cwds(new MastraSource(path))).toEqual([CWD, "/work/text", undefined, undefined]);
  });

  it("comes from the workspace of the OpenBot agent that owns the thread", async () => {
    const path = join(directory, "openbot.db");
    const agent = (id: string, json: string) =>
      `INSERT INTO projection_agents VALUES ('${id}', '${json}')`;
    const row = (thread: string, id: string) => `INSERT INTO projection_thread_messages VALUES
      ('${thread}', '${id}', NULL, 0,
      '{"id":"${id}","author":"user","text":"hi","createdAt":"2026-11-01T10:00:00.000Z"}')`;
    await sqlite(path, [
      "CREATE TABLE projection_agents (agent_id TEXT PRIMARY KEY, agent_json TEXT NOT NULL)",
      "CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, agent_id TEXT, title TEXT)",
      "CREATE TABLE projection_turns (turn_id TEXT PRIMARY KEY, provider_session_id TEXT)",
      "CREATE TABLE projection_provider_sessions (id TEXT PRIMARY KEY, provider TEXT, external_session_id TEXT, model TEXT)",
      `CREATE TABLE projection_thread_messages (thread_id TEXT, message_id TEXT, turn_id TEXT,
        ordinal INTEGER, message_json TEXT)`,
      agent("a1", `{"name":"Nova","workspacePath":"${CWD}"}`),
      agent("a2", `{"name":"Juno"}`),
      "INSERT INTO projection_threads VALUES ('t1', 'a1', 'Nova'), ('t2', 'a2', 'Juno')",
      row("t1", "m1"),
      row("t2", "m2"),
    ]);

    expect(await cwds(new OpenBotSource(path))).toEqual([CWD, undefined]);
  });
});
