import { createClient } from "@libsql/client";
import type { ExtensionAPI as PiAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI as OmpAPI } from "@oh-my-pi/pi-coding-agent";
import * as TypeBox from "@oh-my-pi/omptype/typebox";
import piExtension from "../../packages/pi/extensions/sessions.ts";
import ompExtension from "../../packages/omp/extensions/sessions.ts";
import { OpenCodeSource } from "../../src/sources/opencode.ts";
import { listSourceSessions } from "../../src/tool-reader.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../../src/mcp.ts";
import { listSessions } from "../../src/tool-operations.ts";

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
      ["codex", "same"],
      ["pi", "updated"],
      ["pi", "same"],
    ]);
    expect(result.details.total).toBe(3);
    expect(result.content[0]?.text).toContain("codex\tsame\t1 messages");
    expect(result.content[0]?.text).toContain("since=2026-09-19T12:00:00.000Z");
  });

  it("paginates globally after filtering and carries fixed bounds into the next call", async () => {
    const first = await listSessions({ sources: ["pi", "codex", "pi"], lastHours: 24, limit: 1 });
    expect(first.details.total).toBe(3);
    expect(first.details.sessions[0]?.source).toBe("codex");
    expect(first.content[0]?.text).toContain("offset=1");
    const next = await listSessions({
      sources: ["codex", "pi"],
      since: first.details.since,
      until: first.details.until,
      offset: 1,
      limit: 2,
    });
    expect(next.details.sessions.map(({ id }) => id)).toEqual(["updated", "same"]);
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

  it("filters SQLite summaries before LIMIT without losing earlier messages", async () => {
    const path = join(directory, "opencode.db");
    const db = createClient({ url: `file:${path}` });
    try {
      await db.executeMultiple(`
        CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT);
        CREATE TABLE part (session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);
        INSERT INTO message VALUES ('m', '{"role":"user"}');
        INSERT INTO part VALUES
          ('recent', 'm', 100, '{"type":"text","text":"first"}'),
          ('recent', 'm', 200, '{"type":"text","text":"second"}'),
          ('older', 'm', 150, '{"type":"text","text":"older"}'),
          ('future', 'm', 300, '{"type":"text","text":"future"}');
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
      typebox: TypeBox,
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
    if (harness === "pi") piExtension(host as unknown as PiAPI);
    else ompExtension(host as unknown as OmpAPI);
    const result = await tools
      .get("sessions_list")
      ?.execute("fixture", { lastHours: 24, sources: ["pi", "codex"], limit: 1 });
    expect(result).toMatchObject({
      details: { total: 3, sessions: [{ source: "codex", id: "same" }] },
    });
    expect(JSON.stringify(result)).toContain("offset=1");
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
      expect(JSON.stringify(result.content)).toContain("codex\\tsame\\t1 messages");
      expect(JSON.stringify(result.content)).toContain("offset=1");
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
