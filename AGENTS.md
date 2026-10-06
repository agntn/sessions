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
- OMP has models fill every optional field. Its validator drops `""` only where the schema sets `minLength` and rejects a value below a minimum before `execute`, so zeros and `sources: []` never reach the extension. `packages/omp/extensions/` turns what does get through (a blank or whitespace string, `paths: []`, a `source` already in `sources`, a filler `lastHours` beside real bounds, a zero `offset` or `position` beside the other) into unset fields. `knownToolResults: []` stays, because it's the documented way to start digest labels. A new optional field gets the same pass there, or OMP can't call the tool at all.
- An MCP client reads `content` and never `details`, so tool text has to carry whatever the next call needs.
- Agent reads stay bounded without persistence, caching, or indexes owned by this package. Stream summaries and requested message windows; use a native projection when the source store can answer more narrowly.
- Inside a checkout, `dist/cli.mjs` loads the `mcp` command from `src/commands/mcp.ts`, so a local server takes edits on restart. The npm package, copies under `node_modules`, a checkout installed without devDependencies and `SESSIONS_DIST=1` keep the bundle. `test/unit/bin.test.ts` runs `mcp` in each layout.
- `typebox` stays out of `dependencies`, since Pi 0.99 warns on every load of a package that lists it there: it is an optional `"*"` peer with the exact pin in `devDependencies`. Pi hands its extension its own copy, the OMP extension never imports it, and `build.config.ts` inlines one into `dist` for the CLI and the MCP server. `test/unit/host-peers.test.ts` guards the manifest and the bundle.
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
