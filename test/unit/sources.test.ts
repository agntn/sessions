import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allSources, create, has, sources, UnknownSourceError } from "../../src/index.ts";

let customPath: string | undefined;
afterEach(() => {
  if (customPath) rmSync(customPath, { recursive: true, force: true });
  customPath = undefined;
});

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

  it("passes a custom native data path to the selected harness", () => {
    customPath = mkdtempSync(join(tmpdir(), "sessions-source-"));
    expect(create("claude", { path: customPath }).available()).toBe(true);
  });

  it("rejects unknown harnesses", () => {
    expect(() => create("unknown")).toThrow(UnknownSourceError);
  });
});
