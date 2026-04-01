import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeSource } from "../../src/sources/claude.ts";
import type { Message } from "../../src/core/types.ts";

let tempDir: string;

function writeMemory(project: string, filename: string, content: string): void {
  const dir = join(tempDir, project, "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content);
}

async function collect(source: ClaudeSource, cursor = "0"): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const m of source.ingest(cursor)) messages.push(m);
  return messages;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "memxa-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ClaudeSource memory files", () => {
  it("ingests memory file with frontmatter", async () => {
    writeMemory(
      "-home-user-project",
      "overview.md",
      [
        "---",
        "name: project overview",
        "description: what this project does",
        "type: project",
        "---",
        "",
        "This is a TypeScript library for data processing.",
      ].join("\n"),
    );

    const source = new ClaudeSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].source).toBe("claude");
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].blocks[0].text).toBe("This is a TypeScript library for data processing.");
    expect(msgs[0].context?.memoryName).toBe("project overview");
    expect(msgs[0].context?.memoryType).toBe("project");
    expect(msgs[0].context?.project).toBe("/home/user/project");
    expect(msgs[0].channel?.type).toBe("memory");
  });

  it("ingests memory file without frontmatter", async () => {
    writeMemory("-home-user-notes", "raw.md", "Just raw markdown content here.");

    const source = new ClaudeSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("Just raw markdown content here.");
  });

  it("skips MEMORY.md index file", async () => {
    writeMemory("-home-user-proj", "MEMORY.md", "# Index\n- [overview](overview.md)");
    writeMemory(
      "-home-user-proj",
      "overview.md",
      "---\nname: overview\ntype: project\n---\n\nReal content.",
    );

    const source = new ClaudeSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("Real content.");
  });

  it("skips empty body", async () => {
    writeMemory("-home-user-empty", "blank.md", "---\nname: blank\ntype: project\n---\n");

    const source = new ClaudeSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(0);
  });

  it("collects from multiple projects", async () => {
    writeMemory("-home-user-alpha", "note.md", "Alpha project note");
    writeMemory("-home-user-beta", "note.md", "Beta project note");

    const source = new ClaudeSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(2);
    const projects = msgs.map((m) => m.context?.project);
    expect(projects).toContain("/home/user/alpha");
    expect(projects).toContain("/home/user/beta");
  });

  it("groups memories by project in sessionId", async () => {
    writeMemory("-home-user-proj", "a.md", "First memory");
    writeMemory("-home-user-proj", "b.md", "Second memory");

    const source = new ClaudeSource(tempDir);
    const msgs = await collect(source);

    expect(msgs).toHaveLength(2);
    expect(msgs[0].sessionId).toBe(msgs[1].sessionId);
    expect(msgs[0].sessionId).toBe("claude-memory:/home/user/proj");
  });

  it("filters by cursor using mtime", async () => {
    writeMemory("-home-user-proj", "old.md", "Old memory");
    writeMemory("-home-user-proj", "new.md", "New memory");

    const oldPath = join(tempDir, "-home-user-proj", "memory", "old.md");
    const newPath = join(tempDir, "-home-user-proj", "memory", "new.md");
    const oldTime = new Date("2026-01-01T00:00:00Z");
    const newTime = new Date("2026-03-01T00:00:00Z");
    utimesSync(oldPath, oldTime, oldTime);
    utimesSync(newPath, newTime, newTime);

    const source = new ClaudeSource(tempDir);
    const cursor = String(newTime.getTime());
    const msgs = await collect(source, cursor);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0].text).toBe("New memory");
  });

  it("re-ingests file at exact cursor boundary", async () => {
    writeMemory("-home-user-proj", "note.md", "Content");
    const filePath = join(tempDir, "-home-user-proj", "memory", "note.md");
    const mtime = new Date("2026-02-15T12:00:00Z");
    utimesSync(filePath, mtime, mtime);

    const source = new ClaudeSource(tempDir);
    const cursor = String(mtime.getTime());
    const msgs = await collect(source, cursor);

    expect(msgs).toHaveLength(1);
  });

  it("truncates body to 8000 chars", async () => {
    writeMemory("-home-user-proj", "long.md", "x".repeat(10000));

    const source = new ClaudeSource(tempDir);
    const msgs = await collect(source);

    expect(msgs[0].blocks[0].text).toHaveLength(8000);
  });
});
