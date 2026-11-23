import { createMcpServer as createToolServer } from "@agntn/tools/mcp";
import type { Server } from "@modelcontextprotocol/server";
import { serverInfo } from "./server-info.ts";
import { sessionsTools } from "./tools.ts";

/**
 * An unconnected MCP server with the session tools. The executors load on the first `tools/call`.
 *
 * @returns {Server} The server, ready to connect.
 */
export function createMcpServer(): Server {
  return createToolServer(serverInfo, sessionsTools);
}
