import * as TypeBox from "@oh-my-pi/omptype/typebox";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import sessionsExtension from "../../packages/omp/extensions/sessions";

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
  ) => Promise<unknown>;
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

describe("OMP extension", () => {
  it("registers the three session readers with the host TypeBox facade", () => {
    const { label, objectSchema, tools } = registerExtension();

    expect(label).toBe("Sessions");
    expect([...tools.keys()]).toEqual(["sessions_sources", "sessions_list", "sessions_read"]);
    expect(objectSchema).toHaveBeenCalled();
    for (const tool of tools.values()) expect(tool.approval).toBe("read");

    const listSchema = requireTool(tools, "sessions_list").parameters as TypeBox.TSchema;
    expect(listSchema.safeParse({ source: "codex", limit: 100 }).success).toBe(true);
    expect(listSchema.safeParse({ source: "codex", limit: 101 }).success).toBe(false);
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
});
