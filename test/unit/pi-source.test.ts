import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../../src/core/types.ts";
import { PiSource } from "../../src/sources/pi.ts";

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("PiSource", () => {
  it("reads Pi records without inheriting OMP identity", async () => {
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
});
