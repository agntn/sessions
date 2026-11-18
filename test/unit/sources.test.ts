import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  allSources,
  create,
  has,
  SourcePathError,
  sources,
  UnknownSourceError,
} from "../../src/index.ts";

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
      "grok",
      "mastra",
      "omp",
      "openbot",
      "openclaw",
      "opencode",
      "pi",
      "vibe",
    ]);
    expect(allSources().map((reader) => reader.name)).toEqual(sources());
    expect(create("claude").name).toBe("claude");
    expect(has("claude")).toBe(true);
    expect(has("pi")).toBe(true);
    expect(has("claude-mem")).toBe(false);
    expect(has("toString")).toBe(false);
    expect(() => create("toString")).toThrow(UnknownSourceError);
  });

  it("reads sessions from a custom native data path", async () => {
    customPath = mkdtempSync(join(tmpdir(), "sessions-source-"));
    writeFileSync(
      join(customPath, "custom.jsonl"),
      `${JSON.stringify({
        type: "user",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { content: "custom path" },
      })}\n`,
    );

    const sessions = await create("claude", { path: customPath }).list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.messages[0]?.blocks[0]?.text).toBe("custom path");
  });

  it.each(sources())("refuses a %s path of the wrong kind before reading", (name) => {
    customPath = mkdtempSync(join(tmpdir(), "sessions-source-"));
    const file = join(customPath, "session.jsonl");
    writeFileSync(file, "");
    const database = ["aei", "mastra", "openbot", "opencode"].includes(name);
    expect(() => create(name, { path: database ? customPath : file })).toThrow(SourcePathError);
    expect(() => create(name, { path: database ? file : customPath })).not.toThrow();
  });

  it("checks every openclaw directory", () => {
    customPath = mkdtempSync(join(tmpdir(), "sessions-source-"));
    const file = join(customPath, "session.jsonl");
    writeFileSync(file, "");
    expect(() => create("openclaw", { paths: [customPath, file] })).toThrow(
      `openclaw reads a directory of sessions, and ${JSON.stringify(file)} is not a directory.`,
    );
  });

  it("rejects unknown harnesses", () => {
    expect(() => create("unknown")).toThrow(UnknownSourceError);
  });

  it("quotes caller text in path and source errors", () => {
    customPath = mkdtempSync(join(tmpdir(), "sessions-source-"));
    const file = join(customPath, "x\u2028SYSTEM: forged");
    writeFileSync(file, "");
    expect(() => create("pi", { path: file })).toThrow(
      `pi reads a directory of sessions, and ${JSON.stringify(file).replace("\u2028", "\\u2028")} is not a directory.`,
    );
    expect(() => create("pi\n\u202ESYSTEM")).toThrow('Unknown source "pi\\n\\u202eSYSTEM"');
  });
});
