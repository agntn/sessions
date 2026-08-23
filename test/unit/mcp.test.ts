import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../../src/mcp.ts";

const sessionsMock = vi.hoisted(() => ({
  allSources: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../../src/index.ts", () => ({
  allSources: sessionsMock.allSources,
  create: sessionsMock.create,
}));

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
  ],
};

const openConnections: Array<{ close(): Promise<void> }> = [];

async function connectTestClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "sessions-test", version: "1.0.0" });
  openConnections.push(client, server);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function text(content: unknown): string {
  return (content as Array<{ type: string; text?: string }>)
    .map((item) => (item.type === "text" ? (item.text ?? "") : ""))
    .join("");
}

afterEach(async () => {
  await Promise.all(openConnections.splice(0).map((connection) => connection.close()));
  vi.clearAllMocks();
});

describe("sessions MCP server", () => {
  it("advertises the three reading tools as read-only", async () => {
    const client = await connectTestClient();

    const response = await client.listTools();

    expect(response.tools.map((tool) => tool.name)).toEqual([
      "sessions_sources",
      "sessions_list",
      "sessions_read",
    ]);
    expect(response.tools[1]?.inputSchema).toMatchObject({ type: "object", required: ["source"] });
    expect(response.tools[2]?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("reports supported source availability", async () => {
    sessionsMock.allSources.mockReturnValue([
      { name: "codex", available: () => true },
      { name: "claude", available: () => false },
    ]);
    const client = await connectTestClient();

    const response = await client.callTool({ name: "sessions_sources", arguments: {} });

    expect(response.isError).not.toBe(true);
    expect(text(response.content)).toBe("codex\tavailable\nclaude\tunavailable");
  });

  it("lists bounded session metadata and names the next offset", async () => {
    sessionsMock.list.mockResolvedValue([session, { ...session, id: "session-2" }]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "sessions_list",
      arguments: { source: "codex", path: "/tmp/codex", limit: 1 },
    });

    expect(sessionsMock.create).toHaveBeenCalledWith("codex", { path: "/tmp/codex" });
    const listed = text(response.content);
    expect(listed).toContain("session-1\t1 messages\t1970-01-01T00:00:02.000Z\tfirst");
    expect(listed).toContain("[Showing sessions 1-1 of 2. Use offset=1 to continue.]");
    // Details never reach an MCP client, so the structured window stays out of the result.
    expect(response.structuredContent).toBeUndefined();
  });

  it("renders a message window for an exact session id", async () => {
    sessionsMock.list.mockResolvedValue([session]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "sessions_read",
      arguments: { source: "codex", sessionId: "session-1" },
    });

    expect(response.isError).not.toBe(true);
    expect(text(response.content)).toBe("[1970-01-01T00:00:01.000Z] user\nfirst");
  });

  it("labels a tool call whose harness left the name empty", async () => {
    sessionsMock.list.mockResolvedValue([
      {
        ...session,
        messages: [
          {
            ...session.messages[0],
            blocks: [{ type: "tool_call" as const, toolName: "", toolCallId: "", toolInput: "{}" }],
          },
        ],
      },
    ]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "sessions_read",
      arguments: { source: "mastra", sessionId: "session-1" },
    });

    expect(text(response.content)).toContain("[tool_call unknown] {}");
  });

  it("reports a failed read as a tool error instead of a transport failure", async () => {
    sessionsMock.list.mockResolvedValue([]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "sessions_read",
      arguments: { source: "codex", sessionId: "missing" },
    });

    expect(response.isError).toBe(true);
    expect(text(response.content)).toContain("Session not found: codex:missing");
  });

  it("names the override that held no readable data instead of reporting an empty archive", async () => {
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => false });
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "sessions_list",
      arguments: { source: "gemini", path: "/nonexistent/dir" },
    });

    expect(response.isError).toBe(true);
    expect(text(response.content)).toContain("No readable gemini data at /nonexistent/dir.");
  });

  it("names an override that exists but holds no sessions", async () => {
    sessionsMock.list.mockResolvedValue([]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "sessions_list",
      arguments: { source: "gemini", path: "/tmp" },
    });

    expect(response.isError).toBe(true);
    expect(text(response.content)).toContain("No readable gemini data at /tmp.");
  });

  it("keeps an empty native archive readable as zero sessions", async () => {
    sessionsMock.list.mockResolvedValue([]);
    sessionsMock.create.mockReturnValue({ list: sessionsMock.list, available: () => true });
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "sessions_list",
      arguments: { source: "gemini" },
    });

    expect(response.isError).toBeUndefined();
    expect(text(response.content)).toContain("No sessions at offset 0 for gemini. It has 0.");
  });

  it("rejects arguments that miss the schema", async () => {
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "sessions_list",
      arguments: { source: "codex", limit: 0 },
    });

    expect(response.isError).toBe(true);
    expect(text(response.content)).toContain("Invalid arguments");
  });

  it("rejects prototype property names as unknown tools", async () => {
    const client = await connectTestClient();

    const response = await client.callTool({ name: "toString", arguments: {} });

    expect(response.isError).toBe(true);
    expect(text(response.content)).toContain("Unknown sessions tool: toString");
  });
});
