import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      "omp",
      "openclaw",
      "opencode",
      "pi",
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

  it("rejects unknown harnesses", () => {
    expect(() => create("unknown")).toThrow(UnknownSourceError);
  });
});
