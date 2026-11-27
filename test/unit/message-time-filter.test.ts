import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { readSession, type ReadParams, type ReadPosition } from "../../src/tool-operations.ts";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): ReadParams {
  const path = mkdtempSync(join(tmpdir(), "sessions-time-"));
  directories.push(path);
  const records = [
    { type: "session", id: "time-test", timestamp: "2026-01-01T00:00:00Z" },
    ...[1, 2, 4, 3, 5].map((day) => ({
      type: "message",
      timestamp: `2026-01-0${day}T00:00:00Z`,
      message: { role: "user", content: [{ type: "text", text: `day${day}` }] },
    })),
  ];
  writeFileSync(
    join(path, "session.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
  return { source: "pi", path, sessionId: "time-test" };
}

const bounds = { since: "2026-01-02T00:00:00Z", until: "2026-01-03T00:00:00Z" };

describe("message time filters", () => {
  it("keeps inclusive matches and native positions even when timestamps are unordered", async () => {
    const params = fixture();
    const first = await readSession({ ...params, ...bounds, limit: 1 });
    expect(first.content[0]?.text).toContain("day2");
    expect(first.content[0]?.text).not.toContain("day1");
    expect(first.details.nextPosition).toEqual({ message: 3, block: 0, character: 0 });
    expect(first.details.totalMessages).toBe(5);
    const second = await readSession({
      ...params,
      ...bounds,
      position: first.details.nextPosition,
    });
    expect(second.content[0]?.text).toContain("day3");
    expect(second.content[0]?.text).not.toContain("day4");
    expect(second.details.nextPosition).toBeUndefined();
    expect(second.details.returnedMessages).toBe(1);
  });

  it("supports one-sided bounds, empty results and original offsets", async () => {
    const params = fixture();
    const lower = await readSession({ ...params, since: "2026-01-05T00:00:00Z" });
    expect(lower.details.returnedMessages).toBe(1);
    expect(lower.content[0]?.text).toContain("day5");
    const upper = await readSession({ ...params, until: "2026-01-01T00:00:00Z" });
    expect(upper.details.returnedMessages).toBe(1);
    const empty = await readSession({ ...params, ...bounds, offset: 4 });
    expect(empty.details.returnedMessages).toBe(0);
    expect(empty.details.nextPosition).toBeUndefined();
    expect(empty.content[0]?.text).toContain("No messages");
    expect((await readSession(params)).details.returnedMessages).toBe(5);
  });

  it("does not apply a partial cursor to a different matching message", async () => {
    const params = fixture();
    await expect(
      readSession({ ...params, ...bounds, position: { message: 0, block: 0, character: 1 } }),
    ).rejects.toThrow("continuation message");
  });

  it("rejects malformed or reversed time bounds", async () => {
    const params = fixture();
    await expect(readSession({ ...params, since: "2026-02-30T00:00:00Z" })).rejects.toThrow(
      "since",
    );
    await expect(
      readSession({ ...params, since: bounds.until, until: bounds.since }),
    ).rejects.toThrow("since must not be after until");
  });

  it("reassembles an oversized matching block without skipped or repeated text", async () => {
    const params = fixture();
    const payload = "😀abcdefgh|".repeat(400);
    writeFileSync(
      join(params.path ?? "", "session.jsonl"),
      [
        { type: "session", id: "time-test" },
        ...[1, 2, 4].map((day) => ({
          type: "message",
          timestamp: `2026-01-0${day}T00:00:00Z`,
          message: {
            role: "user",
            content: [{ type: "text", text: day === 2 ? payload : "excluded" }],
          },
        })),
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    let position: ReadPosition | undefined;
    let assembled = "";
    for (let page = 0; page < 20; page += 1) {
      const result = await readSession({ ...params, ...bounds, maxChars: 1000, position });
      const text = result.content[0]?.text ?? "";
      expect(text.length).toBeLessThanOrEqual(1000);
      expect(text).not.toContain("excluded");
      const header = "[2026-01-02T00:00:00.000Z] user\n";
      assembled += text
        .slice(text.indexOf(header) + header.length)
        .split("\n\n[output truncated]")[0];
      position = result.details.nextPosition;
      if (!position) break;
      expect(position.message).toBe(1);
    }
    expect(position).toBeUndefined();
    expect(assembled).toBe(payload);
  });
});
