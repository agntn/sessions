import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../../src/core/types.ts";
import { createMcpServer } from "../../src/mcp.ts";
import { PiSource } from "../../src/sources/pi.ts";
import { readSession } from "../../src/tool-operations.ts";

let directory: string | undefined;
const connections: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

const toolCall = { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } };
const turns = [
  { stopReason: "error", errorMessage: "Connection error.", content: [] },
  { stopReason: "aborted", errorMessage: "Interrupted by user", content: [toolCall] },
  { stopReason: "length", content: [{ type: "text", text: "cut sh" }] },
  { stopReason: "toolUse", content: [toolCall] },
  { stopReason: "stop", content: [{ type: "text", text: "done" }] },
  { content: [{ type: "text", text: "no status" }] },
  { stopReason: "stop", content: [] },
];

/* One Pi transcript holding every assistant turn above, in order. */
function writeTranscript(): string {
  const root = mkdtempSync(join(tmpdir(), "sessions-stop-"));
  directory = root;
  const entries = [
    { type: "session", id: "stops" },
    ...turns.map((message, index) => ({
      type: "message",
      timestamp: `2026-10-01T00:00:0${index}.000Z`,
      message: { role: "assistant", ...message },
    })),
  ];
  writeFileSync(
    join(root, "stops.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n"),
  );
  return root;
}

describe("Pi stop reasons", () => {
  it("keeps turns that ended early, with the native reason and error text", async () => {
    const messages: Message[] = [];
    for await (const message of new PiSource(writeTranscript()).read()) messages.push(message);

    expect(messages.map((message) => message.blocks)).toEqual([
      [{ type: "stop", stopReason: "error", text: "Connection error." }],
      [
        {
          type: "tool_call",
          toolName: "read",
          toolCallId: "call-1",
          toolInput: '{"path":"a.txt"}',
        },
        { type: "stop", stopReason: "aborted", text: "Interrupted by user" },
      ],
      [
        { type: "text", text: "cut sh" },
        { type: "stop", stopReason: "length" },
      ],
      [
        {
          type: "tool_call",
          toolName: "read",
          toolCallId: "call-1",
          toolInput: '{"path":"a.txt"}',
        },
      ],
      [{ type: "text", text: "done" }],
      [{ type: "text", text: "no status" }],
    ]);
  });

  it("prints the stop in sessions_read", async () => {
    const params = { source: "pi", path: writeTranscript(), sessionId: "stops", limit: 3 };
    const expected = [
      "[2026-10-01T00:00:00.000Z] assistant\n[stop error] Connection error.",
      '[2026-10-01T00:00:01.000Z] assistant\n[tool_call read call-1] {"path":"a.txt"}\n[stop aborted] Interrupted by user',
      "[2026-10-01T00:00:02.000Z] assistant\ncut sh\n[stop length]",
    ].join("\n\n");

    const result = await readSession(params);
    const text = result.content[0]?.text ?? "";
    expect(text.startsWith(expected)).toBe(true);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: "stop-test", version: "1.0.0" });
    connections.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const response = await client.callTool({ name: "sessions_read", arguments: params });
    expect(response.content).toEqual(result.content);
  });
});
