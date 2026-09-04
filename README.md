# @agntn/sessions

Read and normalize AI coding sessions across harnesses through one TypeScript API.

## Scope

This package does one thing: it discovers native session data produced by supported AI coding harnesses and exposes each conversation as a normalized `Session`.

It deliberately does not provide a database, synchronization cursors, file watching, full-text search, analytics, or long-term agent memory. Applications can compose those concerns on top of the session reader API.

## Supported harnesses

- AEI
- Claude Code
- Codex
- Gemini CLI
- Mastra
- OMP
- OpenClaw
- OpenCode
- Pi

## Install

Requires Node.js 24 or later.

```bash
pnpm add @agntn/sessions
```

## Usage

```ts
import { create } from "@agntn/sessions";

const claude = create("claude", { path: "/custom/claude/projects" });
if (claude.available()) {
  for (const session of await claude.list()) {
    console.log(session.id, session.updatedAt, session.messages.length);
  }
}
```

Use `sources()` to list supported harness names and `allSources()` to create every reader.

```ts
import { allSources } from "@agntn/sessions";

for (const reader of allSources()) {
  if (!reader.available()) continue;

  for (const session of await reader.list()) {
    // Index, render, export, or persist the normalized session in your application.
  }
}
```

Each adapter accepts the native session format as its source of truth. Messages preserve text, thinking, tool calls, tool results, timestamps, roles, and stable source metadata when the harness exposes them.

`list()` materializes the complete native archive and preserves full message payloads in memory. For very large archives or tool outputs, consumers should account for that memory cost before indexing, rendering, exporting, or persisting the returned sessions.

## Agent tools

The package exposes the same three read-only tools over MCP and through native [Pi](https://pi.dev) and [OMP](https://omp.sh) extensions:

- `sessions_sources` lists supported harnesses and local availability.
- `sessions_list` returns bounded session metadata for one harness, newest first: id, message count, last activity, and a snippet of the session's first text (user turns take priority).
- `sessions_read` returns messages for an exact session ID within a character budget chosen by the caller.

Both reading tools accept optional native `path` or `paths` overrides. They do not persist, index, or search session data. Session listings retain only one bounded summary per conversation, and exact reads retain only the requested message window. Adapters can push those projections into a native store; OpenCode aggregates listings in SQLite and filters exact session reads before decoding parts.

### MCP server

```bash
sessions mcp
```

Speaks MCP over stdio. Point a client at it:

```json
{
  "mcpServers": {
    "sessions": { "command": "npx", "args": ["-y", "@agntn/sessions", "mcp"] }
  }
}
```

`sessions_read` defaults to 20,000 response characters and accepts `maxChars` up to 100,000. When more text remains, its answer carries an exact `position` that can continue inside a message block instead of repeating the cut text. `offset` remains the simple way to start at a message boundary.

An MCP client sees the text a tool returns and nothing else, so continuation instructions stay in the text as well as Pi details. A failed read comes back as a tool error, not a transport failure: an unknown source, a path override that holds no native data, or an unknown session ID.

File adapters still scan their native archive for each call, so response time follows archive size even though retained memory stays bounded to session summaries or the requested window. Database adapters can answer more narrowly when their native schema supports it.

`createMcpServer()` is exported from `@agntn/sessions/mcp` for hosts that bring their own transport.

### Pi and OMP extensions

```bash
pi install npm:@agntn/sessions
omp install @agntn/sessions
```

All three surfaces call the executors in `src/tool-operations.ts`, so they answer identically. The extensions add structured details for their hosts; MCP drops them and keeps the text.

## License

MIT
