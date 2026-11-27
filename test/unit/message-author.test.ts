import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { readSession } from "../../src/tool-operations.ts";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sessions-author-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/* Writes one native JSONL transcript and returns its directory. */
function transcript(path: string, entries: readonly unknown[]): string {
  mkdirSync(join(directory, path, ".."), { recursive: true });
  writeFileSync(join(directory, path), entries.map((entry) => JSON.stringify(entry)).join("\n"));
  return directory;
}

/* The header line of every message in a rendered read. */
function headers(text: string): string[] {
  return text.split("\n").filter((line) => /^\[\d{4}-/.test(line));
}

describe("sessions_read message authors", () => {
  it("names each speaker in a Discord channel", async () => {
    const message = (time: string, role: string, text: string) => ({
      type: "message",
      timestamp: `2026-03-10T10:00:0${time}Z`,
      message: { role, content: [{ type: "text", text }] },
    });
    const path = transcript("channel.jsonl", [
      message("1", "user", "[Discord Guild #general channel id:67890 guild] alice: ship it?"),
      message("2", "assistant", "Running CI."),
      message("3", "user", "[Discord Guild #general channel id:67890 guild] bob: after CI"),
      message("4", "assistant", "Green."),
    ]);

    const result = await readSession({ source: "openclaw", path, sessionId: "channel" });

    expect(headers(result.content[0].text)).toEqual([
      "[2026-03-10T10:00:01.000Z] user alice",
      "[2026-03-10T10:00:02.000Z] assistant",
      "[2026-03-10T10:00:03.000Z] user bob",
      "[2026-03-10T10:00:04.000Z] assistant",
    ]);
  });

  it("keeps an ordinary Claude transcript header as it was", async () => {
    const path = transcript("project/plain.jsonl", [
      { type: "user", timestamp: "2026-01-01T00:00:00.000Z", message: { content: "hi" } },
      {
        type: "assistant",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      },
    ]);

    const result = await readSession({ source: "claude", path, sessionId: "plain" });

    expect(headers(result.content[0].text)).toEqual([
      "[2026-01-01T00:00:00.000Z] user",
      "[2026-01-01T00:00:01.000Z] assistant",
    ]);
  });
});
