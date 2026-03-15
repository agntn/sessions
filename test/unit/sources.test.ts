import { describe, it, expect } from "vitest";
import {
  create,
  sources,
  allSources,
  has,
  AeiSource,
  ClaudeSource,
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
    expect(all.length).toBe(7);
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
});
