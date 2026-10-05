import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../../src/core/types.ts";
import { OmpSource } from "../../src/sources/omp.ts";
import { PiSource } from "../../src/sources/pi.ts";

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("PiSource", () => {
  it("owns the session format used by OMP", () => {
    expect(new OmpSource("/tmp")).toBeInstanceOf(PiSource);
  });

  it("reads native Pi records with Pi identity", async () => {
    directory = mkdtempSync(join(tmpdir(), "sessions-pi-"));
    const entries = [
      {
        type: "session",
        version: 3,
        id: "session-pi",
        timestamp: "2026-09-04T10:00:00.000Z",
        cwd: "/tmp/project",
      },
      {
        type: "message",
        id: "m1",
        timestamp: "2026-09-04T10:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      },
    ];
    writeFileSync(
      join(directory, "2026-09-04T10-00-00-000Z_session-pi.jsonl"),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    const messages: Message[] = [];
    for await (const message of new PiSource(directory).read()) messages.push(message);

    expect(messages).toEqual([
      expect.objectContaining({
        source: "pi",
        sessionId: "session-pi",
        role: "assistant",
        channel: { platform: "cli", name: "pi" },
        author: { platform: "cli", name: "pi", isBot: true },
        blocks: [{ type: "text", text: "hello" }],
      }),
    ]);
  });

  it("keeps a record whose text holds U+2028 and U+2029", async () => {
    directory = mkdtempSync(join(tmpdir(), "sessions-pi-"));
    const entries = [
      { type: "session", id: "session-pi", timestamp: "2026-09-04T10:00:00.000Z" },
      ...["one two three", "after"].map((text) => ({
        type: "message",
        timestamp: "2026-09-04T10:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text }] },
      })),
    ];
    writeFileSync(
      join(directory, "2026-09-04T10-00-00-000Z_session-pi.jsonl"),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    const texts: (string | undefined)[] = [];
    for await (const message of new PiSource(directory).read({ sessionId: "session-pi" })) {
      texts.push(message.blocks[0]?.text);
    }

    expect(texts).toEqual(["one two three", "after"]);
  });

  it.each([
    {
      status: { isError: true },
      content: [{ type: "text", text: "same payload" }],
      expected: { text: "same payload", isError: true },
    },
    {
      status: { isError: false },
      content: [{ type: "text", text: "same payload" }],
      expected: { text: "same payload", isError: false },
    },
    {
      status: {},
      content: [{ type: "text", text: "same payload" }],
      expected: { text: "same payload" },
    },
    {
      status: { isError: "false" },
      content: [{ type: "text", text: "same payload" }],
      expected: { text: "same payload" },
    },
    { status: { isError: true }, content: [], expected: { text: "", isError: true } },
    { status: { isError: false }, content: [], expected: { text: "", isError: false } },
    { status: { isError: true }, content: undefined, expected: { text: "", isError: true } },
  ])("preserves native tool status: $status, $content", async ({ status, content, expected }) => {
    directory = mkdtempSync(join(tmpdir(), "sessions-pi-"));
    writeFileSync(
      join(directory, "session.jsonl"),
      JSON.stringify({
        type: "message",
        timestamp: "2026-09-20T10:00:00.000Z",
        message: { role: "toolResult", toolCallId: "call-1", content, ...status },
      }),
    );

    const messages: Message[] = [];
    for await (const message of new PiSource(directory).read()) messages.push(message);

    expect(messages.map((message) => message.blocks)).toEqual([
      [{ type: "tool_result", toolCallId: "call-1", ...expected }],
    ]);
  });

  it("settles a session filter from the header rather than the file name", async () => {
    directory = mkdtempSync(join(tmpdir(), "sessions-pi-"));
    const transcript = (id: string | undefined, text: string): string =>
      [
        ...(id ? [{ type: "session", version: 3, id, timestamp: "2026-09-04T10:00:00.000Z" }] : []),
        {
          type: "message",
          id: "m1",
          timestamp: "2026-09-04T10:00:01.000Z",
          message: { role: "user", content: [{ type: "text", text }] },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n");
    const parent = join(directory, "2026-09-04T10-00-00-000Z_parent");
    mkdirSync(join(parent, "run-0"), { recursive: true });
    writeFileSync(`${parent}.jsonl`, transcript("parent", "parent turn"));
    writeFileSync(join(parent, "run-0", "session.jsonl"), transcript("child", "child turn"));
    writeFileSync(
      join(directory, "2026-09-04T10-00-02-000Z_headerless.jsonl"),
      transcript(undefined, "no header"),
    );
    const source = new PiSource(directory);

    const collect = async (sessionId?: string): Promise<string[]> => {
      const texts: string[] = [];
      for await (const message of source.read({ sessionId })) {
        texts.push(`${message.sessionId}: ${message.blocks[0]?.text}`);
      }
      return texts;
    };

    expect(await collect("child")).toEqual(["child: child turn"]);
    expect(await collect("headerless")).toEqual(["headerless: no header"]);
    expect(await collect("session")).toEqual([]);
    expect((await collect()).sort()).toEqual([
      "child: child turn",
      "headerless: no header",
      "parent: parent turn",
    ]);
  });

  it("opens a project transcript by file name and still reads a nested run", async () => {
    directory = mkdtempSync(join(tmpdir(), "sessions-pi-"));
    const project = join(directory, "project");
    mkdirSync(join(project, "2026-09-04T10-00-00-000Z_wanted", "run-0"), { recursive: true });
    const line = (text: string): string =>
      JSON.stringify({
        type: "message",
        id: "m1",
        timestamp: "2026-09-04T10:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text }] },
      });
    const header = (id: string): string =>
      JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-04T10:00:00.000Z" });
    writeFileSync(
      join(project, "2026-09-04T10-00-00-000Z_wanted.jsonl"),
      `${header("wanted")}\n${line("wanted turn")}\n`,
    );
    writeFileSync(
      join(project, "2026-09-04T10-00-00-000Z_other.jsonl"),
      `${header("other")}\n${line("sibling secret")}\n`,
    );
    writeFileSync(
      join(project, "2026-09-04T10-00-00-000Z_wanted", "run-0", "session.jsonl"),
      `${header("child")}\n${line("nested run")}\n`,
    );
    const source = new PiSource(directory);
    const texts = async (sessionId?: string): Promise<string[]> => {
      const found: string[] = [];
      for await (const message of source.read({ sessionId })) {
        found.push(message.blocks[0]?.text ?? "");
      }
      return found;
    };

    expect(await texts("wanted")).toEqual(["wanted turn"]);
    expect(await texts("child")).toEqual(["nested run"]);
    expect((await texts()).sort()).toEqual(["nested run", "sibling secret", "wanted turn"]);
  });

  it.each<[string, (dir: string) => string]>([
    ["trailing slash", (dir) => `${dir}/`],
    ["leading dot", (dir) => `./${relative(process.cwd(), dir)}`],
    ["parent segment", (dir) => `${dir}/../${basename(dir)}`],
  ])("opens one project session when the root has a %s", async (_shape, sessionsRoot) => {
    directory = mkdtempSync(join(tmpdir(), "sessions-pi-"));
    const project = join(directory, "project");
    mkdirSync(join(project, "2026-09-04T10-00-00-000Z_wanted", "run-0"), { recursive: true });
    const transcript = (id: string, text: string): string =>
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id,
          timestamp: "2026-09-04T10:00:00.000Z",
        }),
        JSON.stringify({
          type: "message",
          id: "m1",
          timestamp: "2026-09-04T10:00:01.000Z",
          message: { role: "user", content: [{ type: "text", text }] },
        }),
      ].join("\n");
    writeFileSync(
      join(project, "2026-09-04T10-00-00-000Z_wanted.jsonl"),
      transcript("wanted", "wanted turn"),
    );
    symlinkSync(
      join(project, "missing.jsonl"),
      join(project, "2026-09-04T10-00-00-000Z_other.jsonl"),
    );
    writeFileSync(
      join(project, "2026-09-04T10-00-00-000Z_wanted", "run-0", "session.jsonl"),
      transcript("child", "nested run"),
    );
    const source = new PiSource(sessionsRoot(directory));
    const texts = async (sessionId: string): Promise<string[]> => {
      const found: string[] = [];
      for await (const message of source.read({ sessionId })) {
        found.push(message.blocks[0]?.text ?? "");
      }
      return found;
    };

    expect(await texts("wanted")).toEqual(["wanted turn"]);
    expect(await texts("child")).toEqual(["nested run"]);
  });
});
