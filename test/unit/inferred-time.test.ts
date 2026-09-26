import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSource, readSourceSession } from "../../src/index.ts";
import { readSession } from "../../src/tool-operations.ts";

const directories: string[] = [];
const instant = "2026-09-20T12:00:00.000Z";
const epoch = Date.parse(instant);
const bounds = { since: instant, until: instant };
const rows = [
  { timestamp: "invalid", text: "invalid-time" },
  { text: "missing-time" },
  { timestamp: instant, text: "matching-time" },
  { timestamp: "2020-01-01T00:00:00Z", text: "old-time" },
  { timestamp: instant, text: "second-match" },
];

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(source: string, sessionTimestamp?: string, codexResponse = false) {
  const path = mkdtempSync(join(tmpdir(), "sessions-inferred-"));
  directories.push(path);
  const file = join(path, source === "gemini" ? "project/chats/proof.json" : "proof.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  const messages = rows.map(({ text, ...time }) => {
    if (source === "gemini") return { type: "user", content: text, ...time };
    if (source === "codex") {
      return codexResponse
        ? {
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text }],
            },
            ...time,
          }
        : { type: "event_msg", payload: { type: "user_message", message: text }, ...time };
    }
    return {
      type: source === "claude" ? "user" : "message",
      message: { role: "user", content: [{ type: "text", text }] },
      ...time,
    };
  });
  const records = [{ type: "session", id: "proof", timestamp: sessionTimestamp }, ...messages];
  writeFileSync(
    file,
    source === "gemini"
      ? JSON.stringify({ messages })
      : records.map((row) => JSON.stringify(row)).join("\n"),
  );
  return {
    file,
    params: { source, path, paths: source === "openclaw" ? [path] : undefined, sessionId: "proof" },
  };
}

describe("inferred message times", () => {
  it.each(["pi", "omp", "claude", "gemini", "codex", "openclaw"])(
    "%s excludes file times without losing content or native positions",
    async (source) => {
      const { file, params } = fixture(source);
      for (const mtime of [instant, "2030-01-01T00:00:00.000Z"]) {
        utimesSync(file, new Date(mtime), new Date(mtime));
        const first = await readSession({ ...params, ...bounds, limit: 1 });
        expect(first.details.returnedMessages).toBe(1);
        expect(first.details.totalMessages).toBe(5);
        const text = first.content[0]?.text;
        expect(text).toContain("matching-time");
        expect(text).not.toContain("invalid-time");
        expect(text).not.toContain("missing-time");
        expect(first.details.nextPosition).toEqual({ message: 4, block: 0, character: 0 });
        const last = await readSession({
          ...params,
          ...bounds,
          position: first.details.nextPosition,
        });
        expect(last.content[0]?.text).toContain("second-match");
        expect(last.details.nextPosition).toBeUndefined();
        const all = await readSession(params);
        expect(all.details.returnedMessages).toBe(5);
        expect(all.content[0]?.text).toContain(`[${mtime}; inferred from file] user\ninvalid-time`);
        expect(all.content[0]?.text).toContain(`[${mtime}; inferred from file] user\nmissing-time`);
        const native = await readSourceSession(
          createSource(source, { path: params.path, paths: params.paths }),
          "proof",
          0,
          10,
        );
        expect(native.messages.map((message) => message.blocks[0]?.text)).toEqual(
          rows.map((row) => row.text),
        );
        expect(native.messages[0]).toHaveProperty("timestampSource", "file");
        expect(native.messages[2]).toHaveProperty("timestampSource", "message");
        const emptyRange = await readSourceSession(
          createSource(source, { path: params.path, paths: params.paths }),
          "proof",
          0,
          10,
          {},
        );
        expect(emptyRange.messages).toEqual(native.messages);
        for (const range of [{ since: epoch }, { until: epoch }, { since: epoch, until: epoch }]) {
          const filtered = await readSourceSession(
            createSource(source, { path: params.path, paths: params.paths }),
            "proof",
            0,
            10,
            range,
          );
          expect(filtered.indices).toEqual(range.since === undefined ? [2, 3, 4] : [2, 4]);
        }
      }
    },
  );

  it("counts messages the bounds skip for an inferred time", async () => {
    const { file, params } = fixture("pi");
    utimesSync(file, new Date(instant), new Date(instant));
    const first = await readSession({ ...params, ...bounds, limit: 1 });
    expect(first.details.inferredExcluded).toBe(2);
    expect(first.content[0]?.text).toContain(
      "[Skipped 2 messages between positions 0 and 3 whose time is inferred, which time bounds always exclude.]",
    );
    const last = await readSession({ ...params, ...bounds, position: first.details.nextPosition });
    expect(last.details.inferredExcluded).toBe(0);
    expect(last.content[0]?.text).not.toContain("Skipped");
    const all = await readSession(params);
    expect(all.details).not.toHaveProperty("inferredExcluded");
    const source = createSource("pi", { path: params.path });
    expect(
      (await readSourceSession(source, "proof", 0, 10, { since: epoch })).inferredExcluded,
    ).toBe(2);
    expect((await readSourceSession(source, "proof", 0, 10)).inferredExcluded).toBe(0);
  });

  it("tells a session with only inferred times from a quiet one", async () => {
    const quiet = fixture("pi");
    const inferred = fixture("openclaw", instant);
    writeFileSync(
      inferred.file,
      [
        { type: "session", id: "proof", timestamp: instant },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "a" }] } },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    const window = { since: "2030-01-01T00:00:00.000Z", until: "2030-01-02T00:00:00.000Z" };
    const none = await readSession({ ...quiet.params, ...window, offset: 4 });
    const skipped = await readSession({ ...inferred.params, ...bounds });
    expect(none.details.returnedMessages).toBe(0);
    expect(skipped.details.returnedMessages).toBe(0);
    expect(none.details.inferredExcluded).toBe(0);
    expect(skipped.details.inferredExcluded).toBe(1);
    expect(skipped.content[0]?.text).toContain(
      "[Skipped 1 message at position 0 whose time is inferred, which time bounds always exclude.]",
    );
    expect(none.content[0]?.text).not.toContain("Skipped");
  });

  it("tracks Codex response timestamps independently of user events", async () => {
    const { file, params } = fixture("codex", undefined, true);
    utimesSync(file, new Date(instant), new Date(instant));
    const filtered = await readSession({ ...params, ...bounds });
    expect(filtered.details.returnedMessages).toBe(2);
    expect(filtered.content[0]?.text).not.toContain("invalid-time");
    const all = await readSession(params);
    expect(all.details.returnedMessages).toBe(5);
    expect(all.content[0]?.text).toContain(
      `[${instant}; inferred from file] assistant\nmissing-time`,
    );
  });

  it("distinguishes OpenClaw session time from a message time", async () => {
    const { file, params } = fixture("openclaw", instant);
    utimesSync(file, new Date(instant), new Date(instant));
    const all = await readSession(params);
    expect(all.content[0]?.text).toContain(
      `[${instant}; inferred from session] user\nmissing-time`,
    );
    const filtered = await readSession({ ...params, ...bounds });
    expect(filtered.details.returnedMessages).toBe(2);
  });

  it.each([instant, "invalid", undefined])(
    "excludes legacy Codex inferred times: %s",
    async (timestamp) => {
      const path = mkdtempSync(join(tmpdir(), "sessions-legacy-time-"));
      directories.push(path);
      const file = join(path, "proof.json");
      writeFileSync(
        file,
        JSON.stringify({
          session: { id: "proof", timestamp },
          items: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "legacy-content" }],
            },
          ],
        }),
      );
      utimesSync(file, new Date(instant), new Date(instant));
      const params = { source: "codex", path, sessionId: "proof" };
      expect((await readSession({ ...params, ...bounds })).details.returnedMessages).toBe(0);
      const all = await readSession(params);
      expect(all.details.returnedMessages).toBe(1);
      expect(all.content[0]?.text).toContain(
        `[${instant}; inferred from ${timestamp === instant ? "session" : "file"}] user\nlegacy-content`,
      );
    },
  );
});
