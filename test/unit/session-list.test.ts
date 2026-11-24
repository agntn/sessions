import { createClient } from "@libsql/client";
import type { ExtensionAPI as PiAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI as OmpAPI } from "@oh-my-pi/pi-coding-agent";
import piExtension from "../../extensions/pi/sessions.ts";
import ompExtension from "../../extensions/omp/sessions.ts";
import { OpenCodeSource } from "../../src/sources/opencode.ts";
import { listSourceSessions } from "../../src/tool-reader.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../../src/mcp.ts";
import { sources } from "../../src/index.ts";
import { listSessions, readSession } from "../../src/tool-operations.ts";

let directory: string;

function transcript(source: "pi" | "codex", id: string, times: readonly string[]): void {
  const path = join(directory, source === "pi" ? ".pi/agent/sessions" : ".codex/sessions");
  mkdirSync(path, { recursive: true });
  const entries =
    source === "pi"
      ? [
          { type: "session", version: 3, id },
          ...times.map((timestamp) => ({
            type: "message",
            timestamp,
            message: { role: "user", content: [{ type: "text", text: id }] },
          })),
        ]
      : times.map((timestamp) => ({
          type: "event_msg",
          timestamp,
          payload: { type: "user_message", message: id },
        }));
  writeFileSync(
    join(path, `${id}.jsonl`),
    entries.map((entry) => JSON.stringify(entry)).join("\n"),
  );
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sessions-window-"));
  vi.stubEnv("HOME", directory);
  vi.stubEnv("GROK_HOME", directory);
  vi.stubEnv("VIBE_HOME", directory);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-20T12:00:00Z"));
  transcript("pi", "same", ["2026-09-19T12:00:00Z"]);
  transcript("codex", "same", ["2026-09-20T12:00:00Z"]);
  transcript("pi", "old", ["2026-09-19T11:59:59Z"]);
  transcript("codex", "future", ["2026-09-20T12:00:01Z"]);
  transcript("pi", "updated", ["2026-09-01T00:00:00Z", "2026-09-20T10:00:00Z"]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("session listing across harnesses", () => {
  it("discovers available harnesses and filters last activity rather than creation", async () => {
    const result = await listSessions({ lastHours: 24 });
    expect(result.details.sources).toEqual(["codex", "pi"]);
    expect(result.details.sessions.map(({ source, id }) => [source, id])).toEqual([
      ["codex", "future"],
      ["codex", "same"],
      ["pi", "updated"],
      ["pi", "same"],
    ]);
    expect(result.details.total).toBe(4);
    expect(result.content[0]?.text).toContain("codex\tsame\t1 messages");
    expect(result.content[0]?.text).toContain("since=2026-09-19T12:00:00.000Z");
  });

  it("keeps a session that writes while lastHours lists", async () => {
    const result = await listSessions({ source: "codex", lastHours: 1 });
    expect(result.details.sessions.map(({ id }) => id)).toEqual(["future", "same"]);
    expect(result.details.until).toBeUndefined();
    expect(result.content[0]?.text).not.toContain("until=");
  });

  it("paginates globally after filtering and carries fixed bounds into the next call", async () => {
    const first = await listSessions({ sources: ["pi", "codex", "pi"], lastHours: 24, limit: 1 });
    expect(first.details.total).toBe(4);
    expect(first.details.sessions[0]?.id).toBe("future");
    expect(first.content[0]?.text).toContain("offset=1");
    const next = await listSessions({
      sources: ["codex", "pi"],
      since: first.details.since,
      until: first.details.until,
      offset: 1,
      limit: 2,
    });
    expect(next.details.sessions.map(({ source, id }) => `${source}:${id}`)).toEqual([
      "codex:same",
      "pi:updated",
    ]);
  });

  it("accepts timezone offsets and keeps distinct sessions with the same id", async () => {
    const result = await listSessions({
      since: "2026-09-19T14:00:00+02:00",
      until: "2026-09-20T12:00:00Z",
    });
    expect(result.details.sessions.filter(({ id }) => id === "same")).toHaveLength(2);
    expect(result.details.since).toBe("2026-09-19T12:00:00.000Z");
  });

  it("returns an empty filtered override without calling it unreadable", async () => {
    const result = await listSessions({
      source: "pi",
      path: join(directory, ".pi/agent/sessions"),
      since: "2027-01-01T00:00:00Z",
    });
    expect(result.details.total).toBe(0);
  });

  it("orders equal timestamps by source and then session id", async () => {
    transcript("pi", "aaa", ["2026-09-20T12:00:00Z"]);
    transcript("pi", "zzz", ["2026-09-20T12:00:00Z"]);
    const result = await listSessions({ sources: ["pi", "codex"], lastHours: 1 });
    expect(result.details.sessions.map(({ source, id }) => `${source}:${id}`)).toEqual([
      "codex:future",
      "codex:same",
      "pi:aaa",
      "pi:zzz",
    ]);
  });

  it.each([
    { source: "pi", sources: ["codex"] },
    { sources: [] },
    { sources: [" "] },
    { path: "/tmp" },
    { lastHours: 0 },
    { lastHours: Infinity },
    { lastHours: 24, since: "2026-01-01T00:00:00Z" },
    { since: "2026-02-30T00:00:00Z" },
    { since: "2026-01-01" },
    { since: "2026-09-20T12:00:00Z", until: "2026-09-19T12:00:00Z" },
    { offset: -1 },
    { limit: 101 },
  ])("rejects invalid selection or time bounds: %j", async (params) => {
    await expect(listSessions(params)).rejects.toThrow();
  });

  it.each(["since", "until"])("names an empty %s beside lastHours", async (name) => {
    await expect(listSessions({ lastHours: 1, [name]: "" })).rejects.toThrow(
      `${name} must be an ISO timestamp`,
    );
  });

  it("accepts one name per harness and rejects one more", async () => {
    const names = Array.from({ length: sources().length }, (_, index) => `missing-${index}`);
    await expect(listSessions({ sources: names })).rejects.toThrow('Unknown source "missing-0"');
    await expect(listSessions({ sources: [...names, "extra"] })).rejects.toThrow(
      `Choose between 1 and ${sources().length} non-empty source names`,
    );
  });

  it("does not silently skip an explicitly selected missing or unknown source", async () => {
    await expect(listSessions({ sources: ["pi", "unknown"] })).rejects.toThrow();
    await expect(listSessions({ sources: ["pi", "claude"] })).rejects.toThrow("No readable claude");
  });

  it("names a failed source rather than returning an incomplete listing", async () => {
    const path = join(directory, ".local/share/opencode");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "opencode.db"), "not a database");
    await expect(listSessions({ sources: ["pi", "opencode"] })).rejects.toThrow(
      "Unable to list opencode sessions",
    );
  });

  it("asks for the directory when path is one session file", async () => {
    const path = join(directory, ".pi/agent/sessions/same.jsonl");
    const hint = `pi reads a directory of sessions, and ${JSON.stringify(path)} is not a directory.`;
    await expect(readSession({ source: "pi", sessionId: "same", path })).rejects.toThrow(hint);
    await expect(listSessions({ source: "pi", path })).rejects.toThrow(hint);
  });

  it("asks for the database file when path is a directory", async () => {
    await expect(listSessions({ source: "opencode", path: directory })).rejects.toThrow(
      `opencode reads a database file, and ${JSON.stringify(directory)} is not a file.`,
    );
  });

  it("filters SQLite summaries before LIMIT without losing earlier messages", async () => {
    const path = join(directory, "opencode.db");
    const db = createClient({ url: `file:${path}` });
    try {
      await db.executeMultiple(`
        CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
        CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT);
        CREATE TABLE part (session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);
        INSERT INTO message VALUES ('m', '{"role":"user"}');
        INSERT INTO part VALUES
          ('recent', 'm', 100, '{"type":"text","text":"first"}'),
          ('recent', 'm', 200, '{"type":"text","text":"second"}'),
          ('older', 'm', 150, '{"type":"text","text":"older"}'),
          ('future', 'm', 300, '{"type":"text","text":"future"}'),
          ('stepped', 'm', 100, '{"type":"text","text":"stepped"}'),
          ('stepped', 'm', 180, '{"type":"step-start"}');
      `);
    } finally {
      db.close();
    }
    const source = new OpenCodeSource(path);
    const first = await listSourceSessions(source, 0, 1, { since: 150, until: 200 });
    expect(first.total).toBe(2);
    expect(first.sessions[0]).toMatchObject({
      id: "recent",
      createdAt: 100,
      updatedAt: 200,
      messageCount: 2,
      snippet: "first",
    });
    const second = await listSourceSessions(source, 1, 1, { since: 150, until: 200 });
    expect(second.sessions[0]?.id).toBe("older");
    expect((await listSourceSessions(source, 0, 1, { since: 400 })).total).toBe(0);
  });

  it("reads whole OpenCode sessions that reach activeSince, never the ended ones", async () => {
    const path = join(directory, "opencode.db");
    const db = createClient({ url: `file:${path}` });
    try {
      await db.executeMultiple(`
        CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
        CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT);
        CREATE TABLE part (session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);
        INSERT INTO message VALUES ('m', '{"role":"user"}');
        INSERT INTO part VALUES
          ('early', 'm', 10, '{"type":"text","text":"e1"}'),
          ('early', 'm', 20, '{"type":"text","text":"e2"}'),
          ('live', 'm', 100, '{"type":"text","text":"l1"}'),
          ('ended', 'm', 110, '{"type":"text","text":"d1"}'),
          ('ended', 'm', 120, '{"type":"text","text":"d2"}'),
          ('ended', 'm', 130, '{"type":"text","text":"d3"}'),
          ('ended', 'm', 140, '{"type":"text","text":"d4"}'),
          ('live', 'm', 200, '{"type":"text","text":"l2"}');
      `);
    } finally {
      db.close();
    }
    const read = async (activeSince: number): Promise<string[]> => {
      const texts: string[] = [];
      for await (const message of new OpenCodeSource(path).read({ activeSince })) {
        texts.push(message.blocks[0]?.text ?? "");
      }
      return texts;
    };
    expect(await read(150)).toEqual(["l1", "l2"]);
    expect(await read(135)).toEqual(["l1", "d1", "d2", "d3", "d4", "l2"]);
    expect(await read(201)).toEqual([]);
  });

  it.each(["pi", "omp"])("passes filtered discovery through the %s extension", async (harness) => {
    const tools = new Map<
      string,
      {
        name: string;
        readonly execute: (
          id: string,
          params: Readonly<Record<string, unknown>>,
        ) => Promise<unknown>;
      }
    >();
    const host = {
      typebox: { Type: { Unsafe: (schema: unknown) => schema } },
      pi: { Text: class {} },
      setLabel() {},
      registerTool(definition: {
        readonly name: string;
        readonly execute: (
          id: string,
          params: Readonly<Record<string, unknown>>,
        ) => Promise<unknown>;
      }) {
        tools.set(definition.name, definition);
      },
    };
    if (harness === "pi") await piExtension(host as unknown as PiAPI);
    else await ompExtension(host as unknown as OmpAPI);
    const result = await tools
      .get("sessions_list")
      ?.execute(
        "fixture",
        { lastHours: 24, sources: ["pi", "codex"], limit: 1 },
        undefined,
        undefined,
        {},
      );
    expect(result).toMatchObject({
      details: { total: 4, sessions: [{ source: "codex", id: "future" }] },
    });
    expect(JSON.stringify(result)).toContain("offset=1");
  });

  it("reads what OMP passes on for the fields a model meant to skip as unset", async () => {
    const tools = new Map<
      string,
      (
        id: string,
        params: Readonly<Record<string, unknown>>,
        signal?: undefined,
        onUpdate?: undefined,
        ctx?: unknown,
      ) => Promise<unknown>
    >();
    await ompExtension({
      typebox: { Type: { Unsafe: (schema: unknown) => schema } },
      pi: { Text: class {} },
      setLabel() {},
      registerTool(definition: {
        readonly name: string;
        readonly execute: (
          id: string,
          params: Readonly<Record<string, unknown>>,
        ) => Promise<unknown>;
      }) {
        tools.set(definition.name, (...args) => definition.execute(...args));
      },
    } as unknown as OmpAPI);
    const list = tools.get("sessions_list");
    const read = tools.get("sessions_read");
    if (!list || !read) throw new Error("OMP tools not registered");
    /** OMP drops `path: ""` itself, since the schema sets minLength. Spaces still get through. */
    const blank = { path: " ", paths: [], offset: 0, limit: 20 };

    await expect(
      list("omp", { ...blank, source: "pi", sources: ["pi"], lastHours: 24 }),
    ).resolves.toMatchObject({ details: { source: "pi", sources: ["pi"], total: 2 } });
    await expect(
      list("omp", { ...blank, source: "pi", sources: ["pi", "codex"], lastHours: 24 }),
    ).resolves.toMatchObject({ details: { sources: ["pi", "codex"], total: 4 } });
    await expect(
      list("omp", {
        ...blank,
        source: "pi",
        sources: ["pi", "codex"],
        path: join(directory, ".pi/agent/sessions"),
        lastHours: 24,
      }),
    ).resolves.toMatchObject({ details: { source: "pi", sources: ["pi"], total: 2 } });
    await expect(
      list("omp", {
        ...blank,
        source: "codex",
        sources: ["codex"],
        since: "2026-09-20T00:00:00Z",
        until: "2026-09-20T12:00:00Z",
        lastHours: 0.1,
      }),
    ).resolves.toMatchObject({ details: { total: 1, sessions: [{ id: "same" }] } });
    await expect(
      list("omp", {
        ...blank,
        source: "pi",
        sources: ["pi", "codex"],
        since: "2026-09-20T12:00:00Z",
        lastHours: 24,
      }),
    ).resolves.toMatchObject({ details: { total: 2, since: "2026-09-20T12:00:00.000Z" } });
    await expect(
      list("omp", {
        ...blank,
        source: "pi",
        sources: ["pi"],
        since: " ",
        until: "2026-09-19T12:00:00Z",
        lastHours: 24,
      }),
    ).resolves.toMatchObject({
      details: {
        total: 2,
        until: "2026-09-19T12:00:00.000Z",
        sessions: [{ id: "same" }, { id: "old" }],
      },
    });
    await expect(
      list("omp", { ...blank, source: "pi", sources: ["pi"], cwd: " ", lastHours: 24 }),
    ).resolves.toMatchObject({ details: { total: 2 } });
    await expect(
      list("omp", { ...blank, source: "claude", sources: ["pi"], lastHours: 24 }),
    ).rejects.toThrow("Use source or sources, not both");

    const readBlank = { ...blank, source: "pi", sessionId: "updated", knownToolResults: [] };
    const origin = { message: 0, block: 0, character: 0 };
    const first = await read("omp", { ...readBlank, since: " ", position: origin });
    expect(first).toMatchObject({ details: { returnedMessages: 2 } });
    expect(JSON.stringify(first)).toContain("[Tool bodies:");
    await expect(read("omp", { ...readBlank, offset: 1, position: origin })).resolves.toMatchObject(
      { details: { returnedMessages: 1 } },
    );
  });

  it("rejects empty time bounds through MCP with the field name", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: "window-test", version: "1" });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({
        name: "sessions_list",
        arguments: { lastHours: 1, since: "", until: "", limit: 1 },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("Invalid arguments at /since");
      const read = await client.callTool({
        name: "sessions_read",
        arguments: { source: "pi", sessionId: "same", until: "" },
      });
      expect(read.isError).toBe(true);
      expect(JSON.stringify(read.content)).toContain("Invalid arguments at /until");
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("serves a real filtered fixture through MCP without a source-discovery call", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: "window-test", version: "1" });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({
        name: "sessions_list",
        arguments: { lastHours: 24, limit: 1 },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain("codex\\tfuture\\t1 messages");
      expect(JSON.stringify(result.content)).toContain("offset=1");
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
