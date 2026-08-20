import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { describe, expect, it, vi } from "vitest";
import sessionsExtension from "../../packages/pi/extensions/sessions";

const sessionsMock = vi.hoisted(() => ({
  allSources: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../../src/index.ts", () => ({
  allSources: sessionsMock.allSources,
  create: sessionsMock.create,
}));

type CapturedRuntime = { tools: Map<string, ToolDefinition> };
type ExecutableTool = {
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<AgentToolResult<unknown>>;
};

function loadExtension(): CapturedRuntime {
  const runtime: CapturedRuntime = { tools: new Map() };
  const pi = {
    registerTool<TParams extends TSchema, TDetails, TState>(
      definition: ToolDefinition<TParams, TDetails, TState>,
    ) {
      runtime.tools.set(definition.name, definition as unknown as ToolDefinition);
    },
  } satisfies Partial<ExtensionAPI>;
  sessionsExtension(pi as ExtensionAPI);
  return runtime;
}

function tool(runtime: CapturedRuntime, name: string): ExecutableTool {
  const definition = runtime.tools.get(name);
  expect(definition).toBeDefined();
  return definition as ExecutableTool;
}

const session = {
  id: "session-1",
  source: "codex",
  createdAt: 1_000,
  updatedAt: 2_000,
  messages: [
    {
      source: "codex",
      sessionId: "session-1",
      role: "user" as const,
      timestamp: 1_000,
      date: "1970-01-01T00:00:01.000Z",
      blocks: [{ type: "text" as const, text: "first" }],
    },
    {
      source: "codex",
      sessionId: "session-1",
      role: "assistant" as const,
      timestamp: 2_000,
      date: "1970-01-01T00:00:02.000Z",
      blocks: [{ type: "text" as const, text: "second" }],
    },
  ],
};

describe("Pi extension", () => {
  it("registers the bounded discovery and reading tools", () => {
    expect([...loadExtension().tools.keys()].sort()).toEqual([
      "sessions_list",
      "sessions_read",
      "sessions_sources",
    ]);
  });

  it("reports supported source availability", async () => {
    sessionsMock.allSources.mockReturnValue([
      { name: "codex", available: () => true },
      { name: "claude", available: () => false },
    ]);

    const result = await tool(loadExtension(), "sessions_sources").execute(
      "test",
      {},
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    expect(result.details).toEqual({
      sources: [
        { name: "codex", available: true },
        { name: "claude", available: false },
      ],
    });
  });

  it("lists bounded session metadata without message bodies", async () => {
    sessionsMock.list.mockResolvedValue([session, { ...session, id: "session-2" }]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list });

    const result = await tool(loadExtension(), "sessions_list").execute(
      "test",
      { source: " codex ", path: " /tmp/codex ", limit: 1 },
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    expect(sessionsMock.create).toHaveBeenCalledWith("codex", { path: "/tmp/codex" });
    expect(result.details).toEqual({
      source: "codex",
      offset: 0,
      total: 2,
      sessions: [
        {
          id: "session-1",
          source: "codex",
          createdAt: 1_000,
          updatedAt: 2_000,
          messageCount: 2,
        },
      ],
    });
  });

  it("reads an exact bounded message window", async () => {
    sessionsMock.list.mockResolvedValue([session]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list });

    const result = await tool(loadExtension(), "sessions_read").execute(
      "test",
      { source: "codex", sessionId: "session-1", offset: 1, limit: 1 },
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    expect(result.details).toEqual({
      source: "codex",
      sessionId: "session-1",
      offset: 1,
      limit: 1,
      totalMessages: 2,
      returnedMessages: 1,
      outputTruncated: false,
    });
  });

  it("pages older sessions instead of dead-ending at the maximum limit", async () => {
    sessionsMock.list.mockResolvedValue([session, { ...session, id: "session-2" }]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list });
    const list = tool(loadExtension(), "sessions_list");
    const render = async (params: Record<string, unknown>) =>
      (await list.execute("test", params, undefined, undefined, {} as ExtensionContext)).content
        .map((item) => (item.type === "text" ? item.text : ""))
        .join("");

    expect(await render({ source: "codex", limit: 1 })).toContain(
      "[Showing sessions 1-1 of 2. Use offset=1 to continue.]",
    );

    const second = await render({ source: "codex", offset: 1, limit: 1 });
    expect(second).toContain("session-2");
    expect(second).toContain("[Showing sessions 2-2 of 2.]");
  });

  it("keeps listing sessions when a harness timestamp is outside the Date range", async () => {
    sessionsMock.list.mockResolvedValue([{ ...session, updatedAt: 9_000_000_000_000_000 }]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list });

    const result = await tool(loadExtension(), "sessions_list").execute(
      "test",
      { source: "aei" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");

    expect(text).toBe("session-1\t2 messages\tunknown");
  });

  it("tells the model where the message window sits and how to continue", async () => {
    sessionsMock.list.mockResolvedValue([session]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list });
    const read = tool(loadExtension(), "sessions_read");
    const render = async (params: Record<string, unknown>) =>
      (await read.execute("test", params, undefined, undefined, {} as ExtensionContext)).content
        .map((item) => (item.type === "text" ? item.text : ""))
        .join("");

    expect(await render({ source: "codex", sessionId: "session-1", limit: 1 })).toContain(
      "[Showing messages 1-1 of 2. Use offset=1 to continue.]",
    );
    expect(await render({ source: "codex", sessionId: "session-1" })).not.toContain("[Showing");
  });

  it("keeps thinking labelled and pairs tool calls with their results", async () => {
    sessionsMock.list.mockResolvedValue([
      {
        ...session,
        messages: [
          {
            ...session.messages[0],
            blocks: [
              { type: "thinking" as const, text: "weighing options" },
              {
                type: "tool_call" as const,
                toolName: "bash",
                toolCallId: "call-1",
                toolInput: "ls",
              },
              { type: "tool_result" as const, toolCallId: "call-1", text: "ok" },
            ],
          },
        ],
      },
    ]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list });

    const result = await tool(loadExtension(), "sessions_read").execute(
      "test",
      { source: "claude", sessionId: "session-1" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");

    expect(text).toContain("[thinking] weighing options");
    expect(text).toContain("[tool_call bash call-1] ls");
    expect(text).toContain("[tool_result call-1] ok");
  });

  it("preserves the message header newline when a message has no blocks", async () => {
    sessionsMock.list.mockResolvedValue([
      { ...session, messages: [{ ...session.messages[0], blocks: [] }] },
    ]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list });

    const result = await tool(loadExtension(), "sessions_read").execute(
      "test",
      { source: "codex", sessionId: "session-1" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");

    expect(text).toBe("[1970-01-01T00:00:01.000Z] user\n");
  });

  it("bounds rendered output even when one message contains a huge block", async () => {
    const hugeText = "x".repeat(200_000);
    sessionsMock.list.mockResolvedValue([
      {
        ...session,
        messages: [
          {
            ...session.messages[0],
            blocks: [{ type: "text" as const, text: hugeText }],
          },
        ],
      },
    ]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list });

    const result = await tool(loadExtension(), "sessions_read").execute(
      "test",
      { source: "codex", sessionId: "session-1" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");

    expect(text.length).toBeLessThanOrEqual(100_000);
    expect(text).toContain("[output truncated]");
    expect(text).toContain("[The message at offset 0 exceeds the output budget and was cut.]");
    expect(result.details).toMatchObject({ returnedMessages: 1, outputTruncated: true });
  });

  it("points the model at the first unrendered message when output is truncated", async () => {
    const hugeText = "x".repeat(60_000);
    const huge = { ...session.messages[0], blocks: [{ type: "text" as const, text: hugeText }] };
    sessionsMock.list.mockResolvedValue([{ ...session, messages: [huge, huge, huge] }]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list });

    const result = await tool(loadExtension(), "sessions_read").execute(
      "test",
      { source: "codex", sessionId: "session-1" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");

    expect(text.length).toBeLessThanOrEqual(100_000);
    expect(text).toContain("[Showing messages 1-1 of 3. Use offset=1 to continue.]");
  });

  it("rejects an unknown exact session id", async () => {
    sessionsMock.list.mockResolvedValue([]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list });

    await expect(
      tool(loadExtension(), "sessions_read").execute(
        "test",
        { source: "codex", sessionId: "missing" },
        undefined,
        undefined,
        {} as ExtensionContext,
      ),
    ).rejects.toThrow("Session not found: codex:missing");
  });
});
