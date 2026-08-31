# AGENTS.md

## Purpose

`@agntn/sessions` has one scope: discover, read, and normalize native AI coding harness sessions.

## Boundaries

- Keep one adapter per harness in `src/sources/`.
- Public readers expose `name`, `available()`, and `list()`.
- Normalize native conversations to `Session`, `Message`, and `Block`.
- Preserve parser behavior for every supported harness with fixture tests.
- Open libSQL databases through `openDatabase()`. A static `@libsql/client` import lands in every process that only lists sources.
- Do not add persistence, synchronization cursors, watchers, search, analytics, channels as a standalone domain, or agent-memory ingestion.
- Applications own indexing, storage, rendering, and export.
- Keep the agent surfaces bounded and read-only: `src/tool-operations.ts` holds the executors, `src/mcp.ts` exports `createMcpServer()`, `src/commands/mcp.ts` runs it over stdio, and `packages/pi/extensions/` registers the pi tools.
- No agent surface reimplements an operation. Schemas are declared per surface because pi registers tools synchronously, the executors are not.
- An MCP client reads `content` and never `details`, so tool text has to carry whatever the next call needs.
- Both reading tools inherit `list()`'s cost: they read the whole native archive per call, and a multi-gigabyte harness store (opencode at 6.8 GB, 1.05M parts) outlasts a client's request timeout. Document that cost; do not paper over it with caching or indexing here.
- MCP is built on the low-level `Server`, deprecated in the SDK, because `McpServer.registerTool` takes Standard Schema only and `typebox` 1.x is not one.
- Linting and formatting consume the shared `@agntn/ox` policy; repository-local config owns only ignore patterns.

## Commands

```bash
pnpm fmt
pnpm lint
pnpm typecheck
pnpm test:run
pnpm build
```
