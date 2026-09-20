import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { create, createSource, listSourceSessions, readSourceSession } from "../../src/index.ts";
import { listSessions, readSession } from "../../src/tool-operations.ts";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): string {
  const path = mkdtempSync(join(tmpdir(), "sessions-library-"));
  directories.push(path);
  for (const id of ["wanted", "unrelated"]) {
    writeFileSync(
      join(path, `${id}.jsonl`),
      [
        { type: "session", id },
        ...[1, 2, 4, 3, 5].map((day) => ({
          type: "message",
          timestamp: `2026-01-0${day}T00:00:00Z`,
          message: {
            role: "user",
            content: [{ type: "text", text: id === "wanted" ? `day${day}` : "x".repeat(200_000) }],
          },
        })),
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
  }
  return path;
}

const since = Date.parse("2026-01-02T00:00:00Z");
const until = Date.parse("2026-01-03T00:00:00Z");

describe("bounded library exports", () => {
  it("returns the same paged summaries as the tools without message payloads", async () => {
    const path = fixture();
    const source = createSource("pi", { path });
    const page = await listSourceSessions(source, 1, 1, { since });
    const tool = await listSessions({
      source: "pi",
      path,
      offset: 1,
      limit: 1,
      since: new Date(since).toISOString(),
    });
    expect(page.sessions).toEqual(tool.details.sessions);
    expect(page.total).toBe(2);
    expect(page.sessions).toHaveLength(1);
    expect(JSON.stringify(page).length).toBeLessThan(1000);
    expect(await listSourceSessions(source, 2, 1)).toEqual({ total: 2, sessions: [] });
    expect(await listSourceSessions(source, 0, 1, { until })).toEqual({ total: 0, sessions: [] });
  });

  it("preserves original message positions and continues across filtered gaps", async () => {
    const path = fixture();
    const source = createSource("pi", { path });
    const first = await readSourceSession(source, "wanted", 0, 1, { since, until });
    const tool = await readSession({
      source: "pi",
      path,
      sessionId: "wanted",
      limit: 1,
      since: new Date(since).toISOString(),
      until: new Date(until).toISOString(),
    });
    expect(first.total).toBe(5);
    expect(first.indices).toEqual([1]);
    expect(first.messages[0]?.blocks[0]?.text).toBe("day2");
    expect(first.nextMessage).toBe(3);
    expect(first.nextMessage).toBe(tool.details.nextPosition?.message);
    const second = await readSourceSession(source, "wanted", first.nextMessage!, 1, {
      since,
      until,
    });
    expect(second.indices).toEqual([3]);
    expect(second.messages[0]?.blocks[0]?.text).toBe("day3");
    expect(second.nextMessage).toBeUndefined();
    expect(await readSourceSession(source, "wanted", 4, 1, { since, until })).toEqual({
      total: 5,
      messages: [],
      indices: [],
      nextMessage: undefined,
    });
    expect((await readSourceSession(source, "missing", 0, 1)).total).toBe(0);
    expect((await readSourceSession(source, " wanted ", 0, 1)).total).toBe(0);
    expect(
      (await create("pi", { path }).list()).find((session) => session.id === "wanted")?.messages,
    ).toHaveLength(5);
  });

  it("rejects unbounded paging and invalid dates before reading", async () => {
    const source = createSource("pi", { path: fixture() });
    for (const [offset, limit] of [
      [-1, 1],
      [0, 0],
      [0, Infinity],
      [NaN, 1],
      [0.5, 1],
      [0, 1.5],
    ]) {
      await expect(listSourceSessions(source, offset!, limit!)).rejects.toThrow(RangeError);
      await expect(readSourceSession(source, "wanted", offset!, limit!)).rejects.toThrow(
        RangeError,
      );
    }
    for (const range of [{ since: NaN }, { until: Infinity }, { since: until, until: since }]) {
      await expect(listSourceSessions(source, 0, 1, range)).rejects.toThrow(RangeError);
      await expect(readSourceSession(source, "wanted", 0, 1, range)).rejects.toThrow(RangeError);
    }
  });
});
