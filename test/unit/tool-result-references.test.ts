import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { validateInput } from "@agntn/tools";
import piExtension from "../../extensions/pi/sessions.ts";
import ompExtension from "../../extensions/omp/sessions.ts";
import { createMcpServer } from "../../src/mcp.ts";
import { readTool } from "../../src/tools.ts";
import {
  readSession,
  type ReadParams,
  type ReadPosition,
  type ToolResult,
} from "../../src/tool-operations.ts";

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function fixture(
  bodies: readonly string[] = ["document\n".repeat(200), "document\n".repeat(200), "distinct"],
) {
  directory = mkdtempSync(join(tmpdir(), "sessions-references-"));
  const entries = [
    { type: "session", id: "references" },
    ...bodies.map((text, index) => ({
      type: "message",
      timestamp: "2026-09-20T10:00:00.000Z",
      message: {
        role: "toolResult",
        toolCallId: `call-${index}`,
        isError: index === 1,
        content: [{ type: "text", text }],
      },
    })),
  ];
  writeFileSync(
    join(directory, "references.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n"),
  );
  return { source: "pi", path: directory, sessionId: "references" };
}

it("labels a full body and references it on a later read without losing the occurrence", async () => {
  const params = fixture();
  const digest = createHash("sha256").update("document\n".repeat(200), "utf16le").digest("hex");
  const first = await readSession({ ...params, limit: 1, knownToolResults: [] });
  expect(first.content[0]?.text).toContain(`sha256:${digest}`);
  expect(first.content[0]?.text).toContain("document\n".repeat(200));
  const next = await readSession({
    ...params,
    offset: 1,
    since: "2026-09-20T10:00:00Z",
    knownToolResults: [digest],
  });
  const text = next.content[0]?.text ?? "";
  expect(text).toContain("[2026-09-20T10:00:00.000Z] tool\n[tool_result call-1 isError=true]");
  expect(text).toContain(`body_reference sha256:${digest} length=1800 message=1 block=0`);
  expect(text).not.toContain("document\n");
  expect(text).toContain("distinct");
  const request: unknown = JSON.parse(
    text.match(/\[Read body with sessions_read (.+)\]/)?.[1] ?? "null",
  );
  expect(request).toEqual({
    ...params,
    position: { message: 1, block: 0, character: 0 },
    limit: 1,
  });
  const recovered = await readSession(request as ReadParams);
  expect(recovered.content[0]?.text).toContain("document\n".repeat(200));
  expect(recovered.content[0]?.text).not.toContain("body_reference");
});

it("preserves default rendering and never learns digests implicitly", async () => {
  const params = fixture();
  const original = (await readSession(params)).content[0]!.text;
  expect(original.match(/document\n/g)).toHaveLength(400);
  expect(original).not.toContain("sha256:");
  const labelled = (await readSession({ ...params, knownToolResults: [] })).content[0]!.text;
  expect(labelled.match(/document\n/g)).toHaveLength(400);
  expect(labelled).not.toContain("body_reference");
  expect((await readSession(params)).content[0]!.text).toBe(original);
});

it.each([["bad"], ["A".repeat(64)], Array.from({ length: 101 }, () => "0".repeat(64))])(
  "rejects invalid digest lists before reading an archive: %j",
  async (...digests) => {
    await expect(
      readSession({ source: "pi", sessionId: "missing", knownToolResults: digests }),
    ).rejects.toThrow("knownToolResults");
  },
);

it("continues inside a reference without dropping adjacent content", async () => {
  const params = fixture();
  const sessionId = "reference-" + "x".repeat(1400);
  writeFileSync(
    join(params.path, "references.jsonl"),
    [
      { type: "session", id: sessionId },
      {
        type: "message",
        timestamp: "2026-09-20T10:00:00Z",
        message: {
          role: "toolResult",
          toolCallId: "call-ref",
          isError: false,
          content: [{ type: "text", text: "document" }],
        },
      },
      {
        type: "message",
        timestamp: "2026-09-20T10:00:01Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "adjacent content 🐈" }],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );
  const args = {
    ...params,
    sessionId,
    knownToolResults: [createHash("sha256").update("document", "utf16le").digest("hex")],
  };
  const full = (await readSession(args)).content[0]!.text;
  const stripFraming = (text: string) =>
    text
      .replaceAll(/^\[Tool bodies:.*\]\n/gm, "")
      .replaceAll(/\[2026-09-20T10:00:0[01]\.000Z\] (tool|user)\n/g, "")
      .replace(/\n\n\[output truncated\][\s\S]*$/, "")
      .replaceAll("\n", "");
  const fragments: string[] = [];
  let position: ReadPosition | undefined;
  let crossedReference = false;
  for (let page = 0; page < 10; page += 1) {
    const result = await readSession({ ...args, position, maxChars: 1000 });
    expect(result.content[0]!.text.length).toBeLessThanOrEqual(1000);
    fragments.push(stripFraming(result.content[0]!.text));
    const next = result.details.nextPosition;
    if (!next) break;
    expect(next).not.toEqual(position);
    crossedReference ||= next.message === 0 && next.character > 0;
    position = next;
  }
  expect(crossedReference).toBe(true);
  expect(fragments.join("")).toBe(stripFraming(full));
});

it("returns the same references through MCP text and both registered extensions", async () => {
  const params = {
    ...fixture(),
    offset: 1,
    knownToolResults: [
      createHash("sha256").update("document\n".repeat(200), "utf16le").digest("hex"),
    ],
  };
  const expected = await readSession(params);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "references-test", version: "1.0.0" });
  const server = createMcpServer();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "sessions_read", arguments: params });
    expect(result.content).toEqual(expected.content);
    expect(result.isError).not.toBe(true);
    const invalid = await client.callTool({
      name: "sessions_read",
      arguments: { ...params, knownToolResults: ["bad"] },
    });
    expect(invalid.isError).toBe(true);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }

  interface CapturedTool {
    readonly name: string;
    readonly execute: (
      id: string,
      args: Parameters<typeof readSession>[0],
      signal?: undefined,
      onUpdate?: undefined,
      ctx?: unknown,
    ) => Promise<ToolResult<unknown>>;
  }
  const registered = async (extension: (api: never) => Promise<void>) => {
    const tools = new Map<string, CapturedTool>();
    await extension({
      registerTool(tool: CapturedTool) {
        tools.set(tool.name, tool);
      },
      setLabel() {},
      typebox: { Type: { Unsafe: (schema: unknown) => schema } },
      pi: { Text: class {} },
    } as never);
    return tools.get("sessions_read")!;
  };
  const pi = await registered(piExtension as (api: never) => Promise<void>);
  const omp = await registered(ompExtension as (api: never) => Promise<void>);
  const accepts = (args: unknown) => validateInput(readTool, args).ok;
  expect(accepts(params)).toBe(true);
  expect(accepts({ ...params, knownToolResults: [] })).toBe(true);
  expect(accepts({ ...params, knownToolResults: ["bad"] })).toBe(false);
  expect(
    accepts({ ...params, knownToolResults: Array.from({ length: 101 }, () => "0".repeat(64)) }),
  ).toBe(false);
  for (const tool of [pi, omp]) {
    await expect(
      tool.execute(
        "references",
        { ...params, knownToolResults: ["bad"] },
        undefined,
        undefined,
        {},
      ),
    ).rejects.toThrow("Invalid arguments at /knownToolResults/0");
  }
  for (const tool of [pi, omp]) {
    expect(await tool.execute("references", params, undefined, undefined, {})).toEqual(expected);
  }
});

it("distinguishes lone surrogates from replacement characters and keeps empty bodies readable", async () => {
  const params = fixture(["\uD800", "\uFFFD", ""]);
  const digest = createHash("sha256").update("\uD800", "utf16le").digest("hex");
  const text = (await readSession({ ...params, knownToolResults: [digest] })).content[0]!.text;
  expect(text.match(/body_reference/g)).toHaveLength(1);
  expect(text).toContain("\uFFFD");
  expect(text).toContain("length=0 message=2 block=0");
  expect(text).toContain("[tool_result call-2 isError=false]");
});
