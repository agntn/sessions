import { describe, expect, it } from "vitest";
import { allSources, create, has, sources, UnknownSourceError } from "../../src/index.ts";

describe("public harness registry", () => {
  it("exposes every supported harness through session readers", () => {
    expect(sources()).toEqual([
      "aei",
      "claude",
      "codex",
      "gemini",
      "mastra",
      "openclaw",
      "opencode",
    ]);
    expect(allSources().map((reader) => reader.name)).toEqual(sources());
    expect(create("claude").name).toBe("claude");
    expect(has("claude")).toBe(true);
    expect(has("claude-mem")).toBe(false);
    expect(has("toString")).toBe(false);
    expect(() => create("toString")).toThrow(UnknownSourceError);
  });

  it("rejects unknown harnesses", () => {
    expect(() => create("unknown")).toThrow(UnknownSourceError);
  });
});
