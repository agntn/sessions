import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  DEFAULT_MESSAGE_LIMIT,
  DEFAULT_SESSION_LIMIT,
  listSessions,
  listSessionSources,
  MAX_MESSAGE_LIMIT,
  MAX_SESSION_LIMIT,
  readSession,
  type ListParams,
  type ReadParams,
  type ToolResult,
} from "./tool-operations.ts";
import { version } from "./version.ts";

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: TSchema;
  execute(args: Record<string, unknown>): ToolResult<unknown> | Promise<ToolResult<unknown>>;
}

const sourceArguments = {
  source: Type.String({
    description: "Harness source name, for example codex or claude",
    minLength: 1,
    maxLength: 64,
  }),
  path: Type.Optional(
    Type.String({ description: "Override the source's native data path", minLength: 1 }),
  ),
  paths: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description: "Override multiple native data paths for sources that support them",
    }),
  ),
};

const tools: ToolDefinition[] = [
  {
    name: "sessions_sources",
    title: "Session Sources",
    description:
      "List every supported AI coding harness and whether its native session data is readable on this machine. Use this before the other tools instead of guessing a source name.",
    inputSchema: Type.Object({}),
    execute: () => listSessionSources(),
  },
  {
    name: "sessions_list",
    title: "List Sessions",
    description:
      "Discover normalized sessions for one harness, newest first. Each row carries the session id, message count, last activity, and a snippet of the session's first text, preferring what the user typed. Triage on the snippet before paying for sessions_read. Page older sessions with offset.",
    inputSchema: Type.Object({
      ...sourceArguments,
      offset: Type.Optional(
        Type.Integer({ description: "Zero-based session offset. Defaults to 0.", minimum: 0 }),
      ),
      limit: Type.Optional(
        Type.Integer({
          description: `Maximum session summaries to return. Defaults to ${DEFAULT_SESSION_LIMIT}.`,
          minimum: 1,
          maximum: MAX_SESSION_LIMIT,
        }),
      ),
    }),
    execute: (args) => listSessions(args as unknown as ListParams),
  },
  {
    name: "sessions_read",
    title: "Read Session",
    description:
      "Read a bounded message window from one normalized session addressed by the exact id returned by sessions_list. Every call re-reads the harness archive, so read one wide window instead of many small ones.",
    inputSchema: Type.Object({
      ...sourceArguments,
      sessionId: Type.String({
        description: "Exact native session identifier from sessions_list",
        minLength: 1,
      }),
      offset: Type.Optional(
        Type.Integer({ description: "Zero-based message offset. Defaults to 0.", minimum: 0 }),
      ),
      limit: Type.Optional(
        Type.Integer({
          description: `Maximum messages to return. Defaults to ${DEFAULT_MESSAGE_LIMIT}.`,
          minimum: 1,
          maximum: MAX_MESSAGE_LIMIT,
        }),
      ),
    }),
    execute: (args) => readSession(args as unknown as ReadParams),
  },
];

/** Formats the first TypeBox validation failure for an MCP client. */
function validationError(schema: TSchema, value: unknown): string {
  const first = Value.Errors(schema, value)[0];
  if (!first) return "Invalid arguments";
  return `Invalid arguments at ${first.instancePath || "/"}: ${first.message}`;
}

/**
 * Converts a shared tool result to the MCP text-result contract.
 *
 * `details` is dropped and `structuredContent` is never set: clients that see
 * structured output prefer it over `content` and would hide the readable answer.
 */
function toCallToolResult(result: ToolResult<unknown>): CallToolResult {
  return { content: result.content };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Creates an unconnected MCP server exposing the session discovery and reading tools.
 *
 * Built on the low-level `Server` even though the SDK marks it `@deprecated`,
 * because `McpServer.registerTool` accepts Standard Schema (Zod) only. TypeBox 1.x
 * does not implement Standard Schema, and this package's tool schemas are TypeBox,
 * shared in shape with the Pi extension. The high-level API would force a second
 * definition of every parameter.
 */
export function createMcpServer(): Server {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const server = new Server({ name: "sessions", version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool): Tool => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema as Tool["inputSchema"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolsByName.get(request.params.name);
    if (!tool) return errorResult(`Unknown sessions tool: ${request.params.name}`);

    const args = request.params.arguments ?? {};
    if (!Value.Check(tool.inputSchema, args)) {
      return errorResult(validationError(tool.inputSchema, args));
    }

    try {
      return toCallToolResult(await tool.execute(args));
    } catch (error) {
      return errorResult(
        `${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  return server;
}
