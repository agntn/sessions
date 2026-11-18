import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../../src/tool-operations.ts";
import * as TypeBox from "@oh-my-pi/omptype/typebox";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import sessionsExtension from "../../extensions/omp/sessions";

const sessionsMock = vi.hoisted(() => ({
  allSources: vi.fn(),
}));

vi.mock("../../src/index.ts", () => ({
  allSources: sessionsMock.allSources,
}));

interface RegisteredTool {
  readonly name: string;
  readonly approval?: string;
  readonly parameters: unknown;
  readonly execute: (
    toolCallId: string,
    params: Readonly<Record<string, unknown>>,
  ) => Promise<ToolResult<unknown>>;
}

function registerExtension() {
  const tools = new Map<string, RegisteredTool>();
  const objectSchema = vi.fn(TypeBox.Type.Object.bind(TypeBox.Type));
  let label: string | undefined;
  const api = {
    typebox: { ...TypeBox, Type: { ...TypeBox.Type, Object: objectSchema } },
    setLabel(value: string) {
      label = value;
    },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  };

  // SAFETY: the test host implements every capability the extension uses during registration.
  sessionsExtension(api as unknown as ExtensionAPI);
  return { label, objectSchema, tools };
}

function requireTool(tools: Readonly<Map<string, RegisteredTool>>, name: string): RegisteredTool {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool;
}

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("OMP extension", () => {
  it("registers the three session readers with the host TypeBox facade", () => {
    const { label, objectSchema, tools } = registerExtension();

    expect(label).toBe("Sessions");
    expect([...tools.keys()]).toEqual(["sessions_sources", "sessions_list", "sessions_read"]);
    expect(objectSchema).toHaveBeenCalled();
    for (const tool of tools.values()) expect(tool.approval).toBe("read");

    const listSchema = requireTool(tools, "sessions_list").parameters as TypeBox.TSchema;
    const names = Array.from({ length: 12 }, (_, index) => `source-${index}`);
    expect(listSchema.safeParse({ source: "codex", limit: 100 }).success).toBe(true);
    expect(listSchema.safeParse({ source: "codex", limit: 101 }).success).toBe(false);
    expect(listSchema.safeParse({ sources: names }).success).toBe(true);
    expect(listSchema.safeParse({ sources: [...names, "extra"] }).success).toBe(false);
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
    const tool = requireTool(registerExtension().tools, "sessions_read");
    const params = {
      source: "pi",
      path,
      sessionId: "interval",
      since: "2026-01-02T00:00:00Z",
      until: "2026-01-02T00:00:00Z",
    };
    expect((tool.parameters as TypeBox.TSchema).safeParse(params)).toMatchObject({
      success: true,
      data: params,
    });
    const result = await tool.execute("test", params);
    expect(result.content[0]?.text).toContain("day2");
    expect(result.details).toMatchObject({ returnedMessages: 1 });
    expect(JSON.stringify(result)).not.toContain("day1");
  });

  it("delegates execution to the shared session operations", async () => {
    sessionsMock.allSources.mockReturnValue([
      { name: "codex", available: () => true },
      { name: "claude", available: () => false },
    ]);
    const tool = requireTool(registerExtension().tools, "sessions_sources");

    await expect(tool.execute("test", {})).resolves.toMatchObject({
      details: {
        sources: [
          { name: "codex", available: true },
          { name: "claude", available: false },
        ],
      },
    });
  });

  it("loads the executors through literal specifiers the host can rewrite", () => {
    const source = readFileSync(
      new URL("../../extensions/omp/sessions.ts", import.meta.url),
      "utf8",
    );
    const specifiers = [...source.matchAll(/\bimport\(\s*([^)]*?)\s*\)/g)].map((match) => match[1]);
    const { exports } = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { exports: Record<string, unknown> };

    expect(specifiers).toEqual([
      '"../../src/tool-operations.ts"',
      '"@agntn/sessions/tool-operations"',
    ]);
    expect(exports).toHaveProperty("./tool-operations");
  });
});
