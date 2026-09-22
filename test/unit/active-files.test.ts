import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Source } from "../../src/core/types.ts";
import { ClaudeSource } from "../../src/sources/claude.ts";
import { CodexSource } from "../../src/sources/codex.ts";
import { PiSource } from "../../src/sources/pi.ts";
import { listSourceSessions } from "../../src/tool-reader.ts";

const since = Date.parse("2026-09-20T00:00:00Z");
const before = since - 3_600_000;
const after = since + 3_600_000;

interface Harness {
  readonly name: string;
  readonly source: (root: string) => Source;
  /** Relative transcript path for one file of `id`; `copy` tells two files of one session apart. */
  readonly path: (id: string, copy: number) => string;
  readonly lines: (id: string, timestamp: string) => readonly unknown[];
}

const harnesses: readonly Harness[] = [
  {
    name: "claude",
    source: (root) => new ClaudeSource(root),
    path: (id, copy) => join(`project-${copy}`, `${id}.jsonl`),
    lines: (id, timestamp) => [{ type: "user", timestamp, message: { role: "user", content: id } }],
  },
  {
    name: "codex",
    source: (root) => new CodexSource(root),
    path: (id, copy) => join(`2026/09/1${copy}`, `rollout-2026-09-1${copy}T10-00-00-${id}.jsonl`),
    lines: (id, timestamp) => [
      {
        type: "event_msg",
        timestamp,
        payload: { type: "user_message", message: id },
      },
    ],
  },
  {
    name: "pi",
    source: (root) => new PiSource(root),
    path: (_id, copy) => join("--project--", `2026-09-1${copy}_run-${copy}.jsonl`),
    lines: (id, timestamp) => [
      { type: "session", version: 3, id },
      {
        type: "message",
        timestamp,
        message: { role: "user", content: [{ type: "text", text: id }] },
      },
    ],
  },
];

let root: string;

function transcript(
  harness: Readonly<Harness>,
  id: string,
  copy: number,
  timestamp: number,
  written: number,
): void {
  const path = join(root, harness.path(id, copy));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    harness
      .lines(id, new Date(timestamp).toISOString())
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );
  utimesSync(path, new Date(written), new Date(written));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sessions-active-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.each(harnesses)("$name listing bounded by since", (harness) => {
  it("leaves a session last written before the bound unparsed", async () => {
    transcript(harness, "stale", 1, after, before);
    const source = harness.source(root);

    expect((await listSourceSessions(source, 0, 10)).total).toBe(1);
    expect(await listSourceSessions(source, 0, 10, { since })).toEqual({ total: 0, sessions: [] });
  });

  it("keeps every transcript of a session one recent file reaches", async () => {
    transcript(harness, "spread", 1, before, before);
    transcript(harness, "spread", 2, after, after);
    const source = harness.source(root);

    expect(await listSourceSessions(source, 0, 10, { since })).toEqual({
      total: 1,
      sessions: [
        {
          id: "spread",
          source: harness.name,
          createdAt: before,
          updatedAt: after,
          messageCount: 2,
          snippet: "spread",
        },
      ],
    });
  });
});
