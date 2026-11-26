import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSessions } from "../../src/tool-operations.ts";
import { listSourceSessions } from "../../src/tool-reader.ts";
import { OpenBotSource } from "../../src/sources/openbot.ts";
import { OpenCodeSource } from "../../src/sources/opencode.ts";

let directory: string;
let dbPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sessions-owner-"));
  dbPath = join(directory, "openbot.db");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/* Same prompt, three threads: two for Nova, one for Juno, plus a team channel nobody owns. */
function twins(): void {
  const message = (thread: string, id: string, minute: number) =>
    `INSERT INTO projection_thread_messages VALUES ('${thread}', '${id}', NULL, ${minute},
      '{"id":"${id}","author":"user","text":"Run the weekly check","createdAt":"2026-11-01T10:0${minute}:00.000Z"}')`;
  const db = new DatabaseSync(dbPath);
  try {
    for (const sql of [
      "CREATE TABLE projection_agents (agent_id TEXT PRIMARY KEY, agent_json TEXT NOT NULL)",
      "CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, agent_id TEXT, title TEXT)",
      "CREATE TABLE projection_turns (turn_id TEXT PRIMARY KEY, provider_session_id TEXT)",
      "CREATE TABLE projection_provider_sessions (id TEXT PRIMARY KEY, provider TEXT, external_session_id TEXT, model TEXT)",
      "CREATE TABLE projection_thread_messages (thread_id TEXT, message_id TEXT, turn_id TEXT, ordinal INTEGER, message_json TEXT)",
      "CREATE TABLE projection_channels (channel_id TEXT PRIMARY KEY, channel_json TEXT NOT NULL)",
      "CREATE TABLE projection_channel_messages (channel_id TEXT, message_id TEXT, sequence INTEGER, message_json TEXT)",
      `INSERT INTO projection_agents VALUES ('agent-nova', '{"name":"Nova"}'), ('agent-juno', '{"name":"Juno"}')`,
      `INSERT INTO projection_threads VALUES ('t-nova', 'agent-nova', 'Nova'),
        ('t-nova-audit', 'agent-nova', 'Audit'), ('t-juno', 'agent-juno', 'Juno')`,
      message("t-nova", "m1", 1),
      message("t-nova-audit", "m2", 2),
      message("t-juno", "m3", 3),
      `INSERT INTO projection_channels VALUES ('c-team', '{"name":"Team"}')`,
      `INSERT INTO projection_channel_messages VALUES ('c-team', 'c1', 1,
        '{"author":{"kind":"member","id":"me","name":"You"},"message":{"author":"user","text":"Run the weekly check","createdAt":"2026-11-01T10:04:00.000Z"}}')`,
    ]) {
      db.exec(sql);
    }
  } finally {
    db.close();
  }
}

describe("session owners", () => {
  it("tell identical OpenBot threads apart by the agent that owns them", async () => {
    twins();
    const page = await listSourceSessions(new OpenBotSource(dbPath), 0, 10);

    expect(page.sessions.map(({ id, owner, title }) => [id, owner?.platformId, title])).toEqual([
      ["c-team", undefined, undefined],
      ["t-juno", "agent-juno", "Juno"],
      ["t-nova-audit", "agent-nova", "Audit"],
      ["t-nova", "agent-nova", "Nova"],
    ]);
    expect(page.sessions[1]?.owner).toEqual({
      platform: "openbot",
      platformId: "agent-juno",
      name: "Juno",
      isBot: true,
    });
  });

  it("keeps the owner from replies written by another agent", async () => {
    twins();
    const db = new DatabaseSync(dbPath);
    db.exec(`INSERT INTO projection_thread_messages VALUES ('t-juno', 'm4', NULL, 9,
      '{"id":"m4","author":"agent","senderAgentId":"agent-nova","text":"Done","createdAt":"2026-11-01T10:09:00.000Z"}')`);
    db.close();

    const messages = [];
    for await (const message of new OpenBotSource(dbPath).read({ sessionId: "t-juno" })) {
      messages.push(message);
    }
    expect(messages.map((message) => [message.author?.name, message.owner?.name])).toEqual([
      [undefined, "Juno"],
      ["Nova", "Juno"],
    ]);
  });

  it("filters by owner id before offset and limit", async () => {
    twins();
    const source = new OpenBotSource(dbPath);

    const first = await listSourceSessions(source, 0, 1, { owner: "agent-nova" });
    expect(first.total).toBe(2);
    expect(first.sessions.map(({ id }) => id)).toEqual(["t-nova-audit"]);
    const second = await listSourceSessions(source, 1, 1, { owner: "agent-nova" });
    expect(second.sessions.map(({ id }) => id)).toEqual(["t-nova"]);
    expect((await listSourceSessions(source, 0, 10, { owner: "Nova" })).total).toBe(0);
    await expect(listSourceSessions(source, 0, 1, { owner: " " })).rejects.toThrow(RangeError);
  });

  it("matches nothing in a source that records no owner", async () => {
    const path = join(directory, "opencode.db");
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE part (session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);
      INSERT INTO session VALUES ('s1', '/work');
      INSERT INTO message VALUES ('m', '{"role":"user"}');
      INSERT INTO part VALUES ('s1', 'm', 100, '{"type":"text","text":"hi"}');`);
    db.close();
    const source = new OpenCodeSource(path);

    expect((await listSourceSessions(source, 0, 10)).total).toBe(1);
    expect(await listSourceSessions(source, 0, 10, { owner: "agent-nova" })).toEqual({
      total: 0,
      sessions: [],
    });
  });

  it("prints the owner and a title that adds something, and names the filter", async () => {
    twins();
    const all = await listSessions({ source: "openbot", path: dbPath });
    expect(all.content[0]?.text.split("\n")).toEqual([
      "c-team\t1 messages\t2026-11-01T10:04:00.000Z\tno cwd\tRun the weekly check",
      "t-juno\t1 messages\t2026-11-01T10:03:00.000Z\tno cwd\towner=agent-juno (Juno)\tRun the weekly check",
      "t-nova-audit\t1 messages\t2026-11-01T10:02:00.000Z\tno cwd\towner=agent-nova (Nova) title=Audit\tRun the weekly check",
      "t-nova\t1 messages\t2026-11-01T10:01:00.000Z\tno cwd\towner=agent-nova (Nova)\tRun the weekly check",
    ]);

    const nova = await listSessions({ source: "openbot", path: dbPath, owner: "agent-nova" });
    expect(nova.details).toMatchObject({ total: 2, owner: "agent-nova" });
    expect(nova.content[0]?.text.split("\n")[0]).toBe(
      'Sources: openbot. Owner: "agent-nova". Sources that record no owner never match.',
    );
    await expect(listSessions({ source: "openbot", path: dbPath, owner: " " })).rejects.toThrow(
      "owner must not be blank",
    );
  });

  it("prints a long owner id whole, so it can come back as the filter", async () => {
    twins();
    const long = `agent-${"x".repeat(80)}`;
    const db = new DatabaseSync(dbPath);
    db.exec(`UPDATE projection_threads SET agent_id = '${long}' WHERE thread_id = 't-juno'`);
    db.close();

    const row = (await listSessions({ source: "openbot", path: dbPath, limit: 2 })).content[0]
      ?.text;
    expect(row).toContain(`\towner=${long} (${long.slice(0, 64)}…) title=Juno\t`);
    const back = await listSessions({ source: "openbot", path: dbPath, owner: long });
    expect(back.details.sessions.map(({ id }) => id)).toEqual(["t-juno"]);
  });
});
