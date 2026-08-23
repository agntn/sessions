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
- OpenClaw
- OpenCode

## Install

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

The package exposes the same three read-only tools over MCP and through its [pi](https://pi.dev) extension:

- `sessions_sources` lists supported harnesses and local availability.
- `sessions_list` returns bounded session metadata for one harness, newest first: id, message count, last activity, and a snippet of the session's first text (user turns take priority).
- `sessions_read` returns a bounded message window for an exact session ID.

Both reading tools accept optional native `path` or `paths` overrides. They do not persist, index, or search session data, and each call re-reads the harness archive, so a large archive costs the same read on every call.

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

An MCP client sees the text a tool returns and nothing else, so the text carries the whole answer: the window it covers and the offset that continues it. A failed read comes back as a tool error, not a transport failure: an unknown source, a path override that holds no native data, or an unknown session ID.

Every call reads the whole native archive, so the response time follows the archive size, not the requested window: a few hundred sessions answer in about a second, several thousand in tens of seconds, and a multi-gigabyte harness store can outlast an MCP client's request timeout.

`createMcpServer()` is exported from `@agntn/sessions/mcp` for hosts that bring their own transport.

### Pi extension

```bash
pi install npm:@agntn/sessions
```

Both surfaces call the executors in `src/tool-operations.ts`, so they answer identically. The extension adds the details pi renders; MCP drops them and keeps the text.

## License

MIT
