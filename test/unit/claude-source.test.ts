import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { ClaudeSource } from "../../src/sources/claude.ts";

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("ClaudeSource", () => {
  it("reads a native JSONL session without truncating message text", async () => {
    directory = mkdtempSync(join(tmpdir(), "sessions-claude-"));
    const project = join(directory, "project");
    mkdirSync(project);
    const text = "x".repeat(9000);
    writeFileSync(
      join(project, "session.jsonl"),
      `${JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z", message: { content: text } })}\n`,
    );

    const messages = [];
    for await (const message of new ClaudeSource(directory).read()) messages.push(message);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.sessionId).toBe("session");
    expect(messages[0]?.blocks[0]?.text).toBe(text);
  });
});
