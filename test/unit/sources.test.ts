import { describe, it, expect } from "vitest";
import {
  create,
  sources,
  allSources,
  has,
  AeiSource,
  ClaudeSource,
  ClaudeMemSource,
  MastraSource,
  CodexSource,
  GeminiSource,
  OpenClawSource,
  OpenCodeSource,
} from "../../src/sources/index.ts";
import { UnknownSourceError } from "../../src/core/errors.ts";

describe("source providers", () => {
  it("lists all built-in sources", () => {
    expect(sources()).toEqual(
      expect.arrayContaining([
        "aei",
        "claude",
        "mastra",
        "opencode",
        "codex",
        "gemini",
        "openclaw",
      ]),
    );
  });

  it("creates source by name", () => {
    for (const name of sources()) {
      const source = create(name);
      expect(source.name).toBe(name);
      expect(typeof source.available).toBe("function");
      expect(typeof source.ingest).toBe("function");
      expect(typeof source.cursor).toBe("function");
    }
  });

  it("throws UnknownSourceError for missing source", () => {
    expect(() => create("nonexistent-xyz")).toThrow(UnknownSourceError);
  });

  it("creates all sources", () => {
    const all = allSources();
    expect(all.length).toBe(8);
    for (const s of all) {
      expect(s.name).toBeTruthy();
    }
  });

  it("checks source existence", () => {
    expect(has("aei")).toBe(true);
    expect(has("nonexistent")).toBe(false);
  });

  it("AeiSource accepts custom db path", () => {
    const source = new AeiSource("/tmp/custom.db");
    expect(source.name).toBe("aei");
    expect(source.available()).toBe(false);
  });

  it("ClaudeSource accepts custom projects dir", () => {
    const source = new ClaudeSource("/tmp/nonexistent-projects");
    expect(source.name).toBe("claude");
    expect(source.available()).toBe(false);
  });

  it("MastraSource accepts custom db path", () => {
    const source = new MastraSource("/tmp/nonexistent.db");
    expect(source.name).toBe("mastra");
    expect(source.available()).toBe(false);
  });

  it("CodexSource accepts custom db path", () => {
    const source = new CodexSource("/tmp/nonexistent.sqlite");
    expect(source.name).toBe("codex");
    expect(source.available()).toBe(false);
  });

  it("GeminiSource accepts custom dir", () => {
    const source = new GeminiSource("/tmp/nonexistent-gemini");
    expect(source.name).toBe("gemini");
    expect(source.available()).toBe(false);
  });

  it("OpenClawSource accepts custom dirs", () => {
    const source = new OpenClawSource(["/tmp/nonexistent-sessions"]);
    expect(source.name).toBe("openclaw");
    expect(source.available()).toBe(false);
  });

  it("OpenCodeSource accepts custom db path", () => {
    const source = new OpenCodeSource("/tmp/nonexistent-opencode.db");
    expect(source.name).toBe("opencode");
    expect(source.available()).toBe(false);
  });

  it("ClaudeMemSource accepts custom db path", () => {
    const source = new ClaudeMemSource("/tmp/nonexistent-claude-mem.db");
    expect(source.name).toBe("claude-mem");
    expect(source.available()).toBe(false);
  });

  it("has() returns false for empty string", () => {
    expect(has("")).toBe(false);
  });

  it("sources() returns consistent order", () => {
    const first = sources();
    const second = sources();
    expect(first).toEqual(second);
  });

  it("allSources() count matches sources() count", () => {
    expect(allSources().length).toBe(sources().length);
  });

  it("each source name in sources() can be created", () => {
    for (const name of sources()) {
      const source = create(name);
      expect(source.name).toBe(name);
    }
  });

  it("allSources() names match sources() list", () => {
    const names = allSources().map((s) => s.name);
    expect(names.sort()).toEqual([...sources()].sort());
  });

  it("create() returns a new instance each time", () => {
    const a = create("aei");
    const b = create("aei");
    expect(a).not.toBe(b);
  });

  it("claude-mem source is included in registry", () => {
    expect(has("claude-mem")).toBe(true);
    expect(sources()).toContain("claude-mem");
  });
});
