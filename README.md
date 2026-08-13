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

## License

MIT
