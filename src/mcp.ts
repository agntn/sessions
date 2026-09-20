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
  DEFAULT_OUTPUT_CHARS,
  DEFAULT_SESSION_LIMIT,
  listSessions,
  listSessionSources,
  MAX_MESSAGE_LIMIT,
  MAX_OUTPUT_CHARS,
  MAX_SESSION_LIMIT,
  MIN_OUTPUT_CHARS,
  readSession,
  type ListParams,
  type ReadParams,
  type ToolResult,
} from "./tool-operations.ts";
import { version } from "./version.ts";

interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: TSchema;
  readonly execute: (
    args: Readonly<Record<string, unknown>>,
  ) => ToolResult<unknown> | Promise<ToolResult<unknown>>;
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

const readPosition = Type.Object(
  {
    message: Type.Integer({ description: "Zero-based message index.", minimum: 0 }),
    block: Type.Integer({ description: "Zero-based block index within that message.", minimum: 0 }),
    character: Type.Integer({
      description: "Character offset within the rendered block.",
      minimum: 0,
    }),
  },
  {
    additionalProperties: false,
    description: "Exact continuation position returned by the previous call.",
  },
);

const tools: ToolDefinition[] = [
  {
    name: "sessions_sources",
    title: "Session Sources",
    description:
      "List every supported AI coding harness and whether its native session data is readable on this machine. Use this to inspect availability; sessions_list can discover all available harnesses itself.",
    inputSchema: Type.Object({}),
    execute: () => listSessionSources(),
  },
  {
    name: "sessions_list",
    title: "List Sessions",
    description:
      "Discover sessions across selected or all available harnesses, newest first. Filter last activity with lastHours or since/until. Rows across harnesses include source names. Each row carries the session id, message count, last activity, and a snippet of the session's first text, preferring what the user typed. Triage on the snippet before paying for sessions_read. Page older sessions with offset.",
    inputSchema: Type.Object({
      ...sourceArguments,
      source: Type.Optional(
        Type.String({
          description: "One harness. Omit source and sources for all available harnesses.",
          minLength: 1,
        }),
      ),
      sources: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description: "Selected harness names. Cannot be combined with source or path overrides.",
          minItems: 1,
          maxItems: 9,
        }),
      ),
      since: Type.Optional(
        Type.String({
          description: "Inclusive last activity lower bound, ISO timestamp with timezone.",
        }),
      ),
      until: Type.Optional(
        Type.String({
          description: "Inclusive last activity upper bound, ISO timestamp with timezone.",
        }),
      ),
      lastHours: Type.Optional(
        Type.Number({
          description:
            "Last activity within this many hours before now, for example 24. Cannot be combined with since/until.",
          exclusiveMinimum: 0,
        }),
      ),
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
      "Read a bounded message window from one normalized session addressed by the exact id returned by sessions_list. Sources without a native exact session filter still scan their archive for each call.",
    inputSchema: Type.Object({
      ...sourceArguments,
      sessionId: Type.String({
        description: "Exact native session identifier from sessions_list",
        minLength: 1,
      }),
      offset: Type.Optional(
        Type.Integer({ description: "Zero-based message offset. Defaults to 0.", minimum: 0 }),
      ),
      position: Type.Optional(readPosition),
      since: Type.Optional(
        Type.String({
          description:
            "Inclusive message timestamp lower bound, ISO timestamp with timezone. Reuse when continuing.",
        }),
      ),
      until: Type.Optional(
        Type.String({
          description:
            "Inclusive message timestamp upper bound, ISO timestamp with timezone. Reuse when continuing.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          description: `Maximum matching messages to retain. Defaults to ${DEFAULT_MESSAGE_LIMIT}.`,
          minimum: 1,
          maximum: MAX_MESSAGE_LIMIT,
        }),
      ),
      maxChars: Type.Optional(
        Type.Integer({
          description: `Maximum response characters, including the continuation notice. Defaults to ${DEFAULT_OUTPUT_CHARS}.`,
          minimum: MIN_OUTPUT_CHARS,
          maximum: MAX_OUTPUT_CHARS,
        }),
      ),
    }),
    execute: (args) => readSession(args as unknown as ReadParams),
  },
];

/**
 * Formats the first TypeBox validation failure for an MCP client.
 *
 * @param schema - Schema that rejected the value.
 * @param value - Rejected input.
 * @returns {string} A readable description of the first failure.
 */
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
 *
 * @param result - Shared executor result.
 * @returns {CallToolResult} MCP-compatible text content.
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
 *
 * @returns {Server} The configured, unconnected MCP server.
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
