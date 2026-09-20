import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../../src/mcp.ts";
import { readSession } from "../../src/tool-operations.ts";

let directory: string | undefined;
const connections: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe.each(["pi", "omp"])("%s tool result status", (source) => {
  it("carries native outcomes through the executor and MCP text", async () => {
    directory = mkdtempSync(join(tmpdir(), "sessions-status-"));
    const entries = [
      { type: "session", id: "status" },
      ...[{ isError: true }, { isError: false }, {}, { isError: true }].map((status, index) => ({
        type: "message",
        timestamp: "2026-09-20T10:00:00.000Z",
        message: {
          role: "toolResult",
          toolCallId: `call-${index}`,
          ...status,
          content: index === 3 ? [] : [{ type: "text", text: "same payload" }],
        },
      })),
    ];
    writeFileSync(
      join(directory, "status.jsonl"),
      entries.map((entry) => JSON.stringify(entry)).join("\n"),
    );
    const params = { source, path: directory, sessionId: "status" };
    const expected = [
      "[2026-09-20T10:00:00.000Z] tool\n[tool_result call-0 isError=true] same payload",
      "[2026-09-20T10:00:00.000Z] tool\n[tool_result call-1 isError=false] same payload",
      "[2026-09-20T10:00:00.000Z] tool\n[tool_result call-2] same payload",
      "[2026-09-20T10:00:00.000Z] tool\n[tool_result call-3 isError=true]",
    ].join("\n\n");

    const result = await readSession(params);
    expect(result.content).toEqual([{ type: "text", text: expected }]);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: "status-test", version: "1.0.0" });
    connections.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const response = await client.callTool({ name: "sessions_read", arguments: params });
    expect(response.isError).not.toBe(true);
    expect(response.content).toEqual([{ type: "text", text: expected }]);
  });
});
