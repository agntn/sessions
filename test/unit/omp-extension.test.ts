import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wireSchema } from "@agntn/tools";
import type { ExtensionAPI, Theme, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import sessionsExtension from "../../extensions/omp/sessions";
import { sessionsTools } from "../../src/tools.ts";

const sessionsMock = vi.hoisted(() => ({
  allSources: vi.fn(),
}));

vi.mock("../../src/index.ts", () => ({
  allSources: sessionsMock.allSources,
}));

/** Compiled OMP gives an extension only the package root, so loading the TUI barrel has to fail. */
vi.mock("@oh-my-pi/pi-coding-agent/tui", () => {
  throw new Error("The OMP host does not inject the TUI barrel");
});

/** Stands in for the host `Text`, keeping the drawn line for the assertion. */
class CapturedText {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }
}

/** Writes its styling calls into the output, so a test sees what went where. */
const theme = {
  fg: (color: string, text: string) => `${color}(${text})`,
  styledSymbol: (symbol: string, color: string) => `${color}:${symbol}`,
  spinnerFrames: ["frame-0"],
  format: { bracketLeft: "[", bracketRight: "]" },
  sep: { dot: " | " },
} as unknown as Theme;

/** What `hostContext` in `@agntn/tools` reads off OMP's `ctx`, for a host without a UI. */
const context = { hasUI: false, ui: undefined };

async function registerExtension() {
  const tools = new Map<string, ToolDefinition>();
  let label: string | undefined;
  const api = {
    typebox: { Type: { Unsafe: (schema: unknown) => schema } },
    pi: { Text: CapturedText },
    setLabel(value: string) {
      label = value;
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
  };

  // SAFETY: the test host implements every capability the extension uses during registration.
  await sessionsExtension(api as unknown as ExtensionAPI);
  return { label, tools };
}

function requireTool(tools: Readonly<Map<string, ToolDefinition>>, name: string): ToolDefinition {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool;
}

async function run(name: string, params: unknown) {
  const tool = requireTool((await registerExtension()).tools, name);
  return tool.execute("test", params as never, undefined, undefined, context as never);
}

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("OMP extension", () => {
  it("registers the three session readers with the shared schemas", async () => {
    const { label, tools } = await registerExtension();

    expect(label).toBe("Sessions");
    expect([...tools.keys()]).toEqual(["sessions_sources", "sessions_list", "sessions_read"]);
    for (const definition of sessionsTools) {
      const tool = requireTool(tools, definition.name);
      expect(tool.approval).toBe("read");
      expect(tool.label).toBe(definition.title);
      expect(tool.parameters).toEqual(wireSchema(definition));
    }
  });

  it("refuses a list limit over the bound before reading anything", async () => {
    await expect(run("sessions_list", { source: "codex", limit: 101 })).rejects.toThrow(
      "Invalid arguments at /limit: must be <= 100",
    );
    await expect(
      run("sessions_list", { sources: Array.from({ length: 13 }, (_, index) => `s${index}`) }),
    ).rejects.toThrow("Invalid arguments at /sources: must not have more than 12 items");
  });

  it("reads a time interval through the registered tool", async () => {
    const path = mkdtempSync(join(tmpdir(), "omp-time-"));
    directories.push(path);
    writeFileSync(
      join(path, "session.jsonl"),
      [
        { type: "session", id: "interval" },
        ...[1, 2].map((day) => ({
          type: "message",
          timestamp: `2026-01-0${day}T00:00:00Z`,
          message: { role: "user", content: [{ type: "text", text: `day${day}` }] },
        })),
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    const result = await run("sessions_read", {
      source: "pi",
      path,
      sessionId: "interval",
      since: "2026-01-02T00:00:00Z",
      until: "2026-01-02T00:00:00Z",
    });
    expect((result.content[0] as { text: string }).text).toContain("day2");
    expect(result.details).toMatchObject({ returnedMessages: 1 });
    expect(JSON.stringify(result)).not.toContain("day1");
  });

  it("delegates execution to the shared session operations", async () => {
    sessionsMock.allSources.mockReturnValue([
      { name: "codex", available: () => true },
      { name: "claude", available: () => false },
    ]);

    await expect(run("sessions_sources", {})).resolves.toMatchObject({
      details: {
        sources: [
          { name: "codex", available: true },
          { name: "claude", available: false },
        ],
      },
    });
  });

  it("names the harness and the session on the call line", async () => {
    const { tools } = await registerExtension();
    const line = (name: string, args: Readonly<Record<string, unknown>>) => {
      const { renderCall } = requireTool(tools, name);
      if (!renderCall) throw new Error(`${name} draws no call line`);
      const drawn = renderCall(args as never, { expanded: false, isPartial: false }, theme);
      return (drawn as unknown as CapturedText).text;
    };

    expect(line("sessions_list", { sources: ["pi", "codex"] })).toBe(
      "success:status.done accent(List Sessions): muted(pi, codex)",
    );
    expect(line("sessions_read", { source: "pi", sessionId: "a\u001B[31m\nb" })).toBe(
      "success:status.done accent(Read Session): muted(pi:a b)",
    );
  });

  /** The adapter's own result line is a status and a badge, which hides the answer for good. */
  it("shows the answer in the result row, a long one cut until it's expanded", async () => {
    const tool = requireTool((await registerExtension()).tools, "sessions_list");
    const result = {
      content: [
        { type: "text", text: Array.from({ length: 12 }, (_, i) => `row ${i}`).join("\n") },
      ],
    };
    const { renderResult } = tool;
    if (!renderResult) throw new Error("sessions_list draws no result row");
    const draw = (expanded: boolean) =>
      (
        renderResult(
          result as never,
          { expanded, isPartial: false },
          theme,
          {},
        ) as unknown as CapturedText
      ).text;

    expect(draw(false).split("\n")).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `row ${i}`),
      "... 2 more lines, expand to see them",
    ]);
    expect(draw(true).split("\n")).toHaveLength(12);
  });

  it("strips terminal escapes a transcript carries before the row draws them", async () => {
    const { renderResult } = requireTool((await registerExtension()).tools, "sessions_read");
    if (!renderResult) throw new Error("sessions_read draws no result row");
    const result = { content: [{ type: "text", text: "\u001B[2J\u001B]0;owned\u0007ls\nok" }] };
    const drawn = renderResult(result as never, { expanded: true, isPartial: false }, theme, {});

    expect((drawn as unknown as CapturedText).text).toBe("ls\nok");
  });

  it("loads the definitions through literal specifiers the host can rewrite", () => {
    const source = readFileSync(
      new URL("../../extensions/omp/sessions.ts", import.meta.url),
      "utf8",
    );
    const specifiers = [...source.matchAll(/\bimport\(\s*([^)]*?)\s*\)/g)].map((match) => match[1]);
    const { exports } = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { exports: Record<string, unknown> };

    expect(specifiers).toEqual(['"../../src/tools.ts"', '"@agntn/sessions/tools"']);
    expect(exports).toHaveProperty("./tools");
  });
});
