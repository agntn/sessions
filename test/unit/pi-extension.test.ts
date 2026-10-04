import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import sessionsExtension from "../../packages/pi/extensions/sessions";
import type * as SessionsTools from "../../src/tool-operations.ts";

const sessionsMock = vi.hoisted(() => ({
  allSources: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../../src/index.ts", () => ({
  allSources: sessionsMock.allSources,
}));

vi.mock("../../src/sources/index.ts", () => ({
  createSource: (name: string, options: unknown) => {
    const reader = sessionsMock.create(name, options) as {
      available(): boolean;
      list(): Promise<readonly (typeof session)[]>;
    };
    return {
      name,
      available: () => reader.available(),
      async *read() {
        for (const item of await reader.list()) {
          for (const message of item.messages)
            yield { ...message, source: name, sessionId: item.id };
        }
      },
    };
  },
}));

interface CapturedRuntime {
  readonly toolNames: () => string[];
  readonly getTool: (name: string) => unknown;
}

interface NamedTool {
  readonly name: string;
}

type ExecutableTool = {
  execute: (
    toolCallId: string,
    params: Readonly<Record<string, unknown>>,
    signal: unknown,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<AgentToolResult<unknown>>;
};

function loadExtension(): CapturedRuntime {
  const tools = new Map<string, unknown>();
  const runtime: CapturedRuntime = {
    toolNames: () => [...tools.keys()],
    getTool: (name) => tools.get(name),
  };
  const pi = {
    registerTool(definition: NamedTool) {
      tools.set(definition.name, definition);
    },
  };
  sessionsExtension(pi as ExtensionAPI);
  return runtime;
}

function tool(runtime: Readonly<CapturedRuntime>, name: string): ExecutableTool {
  const definition = runtime.getTool(name);
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
      date: "1970-01-01",
      blocks: [{ type: "text" as const, text: "first" }],
    },
    {
      source: "codex",
      sessionId: "session-1",
      role: "assistant" as const,
      timestamp: 2_000,
      date: "1970-01-01",
      blocks: [{ type: "text" as const, text: "second" }],
    },
  ],
};

describe("Pi extension", () => {
  it("registers the bounded discovery and reading tools", () => {
    const runtime = loadExtension();
    expect(runtime.toolNames().sort()).toEqual([
      "sessions_list",
      "sessions_read",
      "sessions_sources",
    ]);
    const list = runtime.getTool("sessions_list") as {
      parameters: { properties?: { sources?: { maxItems?: number } } };
    };
    expect(list.parameters.properties?.sources?.maxItems).toBe(10);
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
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });

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
      sources: ["codex"],
      offset: 0,
      total: 2,
      sessions: [
        {
          id: "session-1",
          source: "codex",
          createdAt: 1_000,
          updatedAt: 2_000,
          messageCount: 2,
          snippet: "first",
        },
      ],
    });
  });

  it("skips harness-injected openers when picking the snippet", async () => {
    const injected = [
      "# AGENTS.md instructions for /home/user\n<INSTRUCTIONS>rules</INSTRUCTIONS>",
      "<environment_context><cwd>/home/user</cwd></environment_context>",
      "<user_instructions>## rules</user_instructions>",
      "<system-reminder>reattached rules</system-reminder>",
      "<user_info>OS Version: linux</user_info>",
      "<local-command-stdout>Set model to opus</local-command-stdout>",
      "Caveat: The messages below were generated by the user while running local commands.",
    ];
    sessionsMock.list.mockResolvedValue([
      {
        ...session,
        messages: [
          ...injected.map((text) => ({
            ...session.messages[0],
            blocks: [{ type: "text" as const, text }],
          })),
          {
            ...session.messages[0],
            timestamp: 2_000,
            blocks: [{ type: "text" as const, text: "fix the flaky retry test" }],
          },
        ],
      },
    ]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });

    const result = await tool(loadExtension(), "sessions_list").execute(
      "test",
      { source: "codex" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    expect((result.details as SessionsTools.ListDetails).sessions[0]?.snippet).toBe(
      "fix the flaky retry test",
    );
  });

  it("falls back to assistant text when a harness kept no user text", async () => {
    sessionsMock.list.mockResolvedValue([{ ...session, messages: [session.messages[1]] }]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });

    const result = await tool(loadExtension(), "sessions_list").execute(
      "test",
      { source: "gemini" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    expect((result.details as SessionsTools.ListDetails).sessions[0]?.snippet).toBe("second");
  });

  it("collapses the snippet to one bounded listing cell", async () => {
    sessionsMock.list.mockResolvedValue([
      {
        ...session,
        messages: [
          {
            ...session.messages[0],
            blocks: [
              { type: "text" as const, text: `  spread\tover\nlines \u001B[1m${"x".repeat(200)}` },
            ],
          },
        ],
      },
    ]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });

    const result = await tool(loadExtension(), "sessions_list").execute(
      "test",
      { source: "codex" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    const snippet = (result.details as SessionsTools.ListDetails).sessions[0]?.snippet;
    expect(snippet).toHaveLength(80);
    expect(snippet?.startsWith("spread over lines [1mxxx")).toBe(true);
  });

  it("leaves the snippet column out of a row without any text", async () => {
    sessionsMock.list.mockResolvedValue([
      {
        ...session,
        messages: [
          {
            ...session.messages[0],
            blocks: [{ type: "tool_call" as const, toolName: "bash", toolCallId: "1" }],
          },
        ],
      },
    ]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });

    const result = await tool(loadExtension(), "sessions_list").execute(
      "test",
      { source: "codex" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");

    expect(text).toBe("session-1\t1 messages\t1970-01-01T00:00:01.000Z");
  });

  it("exposes message time bounds and returns filtered text and details", async () => {
    sessionsMock.list.mockResolvedValue([session]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });
    const runtime = loadExtension();
    expect(runtime.getTool("sessions_read")).toMatchObject({
      parameters: {
        properties: {
          since: { type: "string" },
          until: { type: "string" },
        },
      },
    });
    const result = await tool(runtime, "sessions_read").execute(
      "test",
      {
        source: "codex",
        sessionId: "session-1",
        since: "1970-01-01T00:00:02Z",
        until: "1970-01-01T00:00:02Z",
      },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    expect(
      result.content.map((item) => (item.type === "text" ? item.text : "")).join(""),
    ).toContain("second");
    expect(JSON.stringify(result.content)).not.toContain("first");
    expect(result.details).toMatchObject({
      returnedMessages: 1,
      since: "1970-01-01T00:00:02.000Z",
    });
  });

  it("reads an exact bounded message window", async () => {
    sessionsMock.list.mockResolvedValue([session]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });

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
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });
    const list = tool(loadExtension(), "sessions_list");
    const render = async (params: Readonly<Record<string, unknown>>) =>
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
    sessionsMock.list.mockResolvedValue([
      {
        ...session,
        messages: session.messages.map((message) => ({
          ...message,
          timestamp: 9_000_000_000_000_000,
        })),
      },
    ]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });

    const result = await tool(loadExtension(), "sessions_list").execute(
      "test",
      { source: "aei" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");

    expect(text).toBe("session-1\t2 messages\tunknown\tfirst");
  });

  it("tells the model where the message window sits and how to continue", async () => {
    sessionsMock.list.mockResolvedValue([session]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });
    const read = tool(loadExtension(), "sessions_read");
    const render = async (params: Readonly<Record<string, unknown>>) =>
      (await read.execute("test", params, undefined, undefined, {} as ExtensionContext)).content
        .map((item) => (item.type === "text" ? item.text : ""))
        .join("");

    expect(await render({ source: "codex", sessionId: "session-1", limit: 1 })).toContain(
      '[Showing messages 1-1 of 2. Use position={"message":1,"block":0,"character":0} to continue.]',
    );
    expect(await render({ source: "codex", sessionId: "session-1" })).not.toContain("[Showing");
  });

  it("takes the header time from the timestamp and falls back to the day", async () => {
    const broken = { ...session.messages[1], timestamp: 9_000_000_000_000_000 };
    sessionsMock.list.mockResolvedValue([{ ...session, messages: [session.messages[0], broken] }]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });

    const result = await tool(loadExtension(), "sessions_read").execute(
      "test",
      { source: "codex", sessionId: "session-1" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");

    expect(text).toContain("[1970-01-01T00:00:01.000Z] user");
    expect(text).toContain("[1970-01-01] assistant");
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
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });

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
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });

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
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });

    const result = await tool(loadExtension(), "sessions_read").execute(
      "test",
      { source: "codex", sessionId: "session-1" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");

    expect(text.length).toBeLessThanOrEqual(20_000);
    expect(text).toContain("[output truncated]");
    expect(text).toContain('[Use position={"message":0,"block":0,"character":');
    expect(result.details).toMatchObject({
      returnedMessages: 1,
      outputTruncated: true,
      nextPosition: { message: 0, block: 0 },
    });
  });

  it("resumes inside a block with a caller output budget", async () => {
    const hugeText = Array.from(
      { length: 5_000 },
      (_, index) => `${index.toString().padStart(4, "0")}|`,
    ).join("");
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
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });
    const read = tool(loadExtension(), "sessions_read");

    const first = await read.execute(
      "test",
      { source: "codex", sessionId: "session-1", maxChars: 1_000 },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    const firstText = first.content.map((item) => (item.type === "text" ? item.text : "")).join("");
    const nextPosition = (first.details as Record<string, unknown>)["nextPosition"] as
      | { message: number; block: number; character: number }
      | undefined;

    expect(firstText.length).toBeLessThanOrEqual(1_000);
    expect(nextPosition).toMatchObject({ message: 0, block: 0 });
    expect(nextPosition?.character).toBeGreaterThan(0);
    const header = "[1970-01-01T00:00:01.000Z] user\n";
    const firstBody = firstText.slice(header.length, firstText.indexOf("\n\n[output truncated]"));
    expect(firstBody).toBe(hugeText.slice(0, nextPosition?.character));

    const second = await read.execute(
      "test",
      { source: "codex", sessionId: "session-1", maxChars: 1_000, position: nextPosition },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    const secondText = second.content
      .map((item) => (item.type === "text" ? item.text : ""))
      .join("");

    expect(secondText).not.toBe(firstText);
    expect(secondText.slice(header.length)).toContain(
      hugeText.slice(nextPosition?.character, (nextPosition?.character ?? 0) + 80),
    );
  });

  it("keeps continuation positions outside surrogate pairs", async () => {
    const hugeText = "😀".repeat(5_000);
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
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });

    const result = await tool(loadExtension(), "sessions_read").execute(
      "test",
      { source: "codex", sessionId: "session-1", maxChars: 1_001 },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    const position = (result.details as SessionsTools.ReadDetails).nextPosition;

    expect(position?.character).toBeGreaterThan(0);
    expect((position?.character ?? 1) % 2).toBe(0);
  });

  it("advances past a corrupt oversized date fallback", async () => {
    sessionsMock.list.mockResolvedValue([
      {
        ...session,
        messages: [
          {
            ...session.messages[0],
            timestamp: 9_000_000_000_000_000,
            date: "d".repeat(1_100),
            blocks: [{ type: "text" as const, text: `payload${"p".repeat(2_000)}` }],
          },
        ],
      },
    ]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });

    const result = await tool(loadExtension(), "sessions_read").execute(
      "test",
      { source: "aei", sessionId: "session-1", maxChars: 1_000 },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    const position = (result.details as SessionsTools.ReadDetails).nextPosition;

    expect(position).toMatchObject({ message: 0, block: 0 });
    expect(position?.character).toBeGreaterThan(0);
    const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");
    expect(text).toContain("payload");
  });

  it("rejects conflicting and invalid output windows", async () => {
    sessionsMock.list.mockResolvedValue([session]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });
    const read = tool(loadExtension(), "sessions_read");

    await expect(
      read.execute(
        "test",
        {
          source: "codex",
          sessionId: "session-1",
          offset: 0,
          position: { message: 0, block: 0, character: 0 },
        },
        undefined,
        undefined,
        {} as ExtensionContext,
      ),
    ).rejects.toThrow("Use either offset or position");
    await expect(
      read.execute(
        "test",
        { source: "codex", sessionId: "session-1", maxChars: 999 },
        undefined,
        undefined,
        {} as ExtensionContext,
      ),
    ).rejects.toThrow("maxChars must be an integer between 1000 and 100000");
  });

  it("rejects an unknown exact session id", async () => {
    sessionsMock.list.mockResolvedValue([]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });

    await expect(
      tool(loadExtension(), "sessions_read").execute(
        "test",
        { source: "codex", sessionId: "missing" },
        undefined,
        undefined,
        {} as ExtensionContext,
      ),
    ).rejects.toThrow('Session not found: codex:"missing"');
  });
});
