# @agntn/sessions

[![npm version](https://npmx.dev/api/registry/badge/version/@agntn/sessions)](https://npmx.dev/package/@agntn/sessions)
[![npm downloads](https://npmx.dev/api/registry/badge/downloads/@agntn/sessions)](https://npmx.dev/package/@agntn/sessions)
[![license](https://npmx.dev/api/registry/badge/license/@agntn/sessions)](https://npmx.dev/package/@agntn/sessions)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/agntn/sessions)

📚 Read conversations from nine AI coding harnesses through one TypeScript API. Your agent can read them too.

## Why?

The conversation you need is in another harness. Of course it is. `@agntn/sessions` reads native session stores and turns them into the same `Session`, `Message`, and `Block` shapes. Build your viewer, export, or index without collecting parsers as a side hobby.

## 📦 Start here

You'll need Node.js 24 or later.

```bash
pnpm add @agntn/sessions
```

Want the library? Start below. Want your agent to read old conversations? Skip to [agent tools](#-agent-tools).

## 🧠 Read your first archive

Save this as `sessions.mjs` and run `node sessions.mjs`:

```js
import { create } from "@agntn/sessions";

const reader = create("claude");
if (reader.available()) {
  for (const session of await reader.list()) {
    console.log(session.id, session.updatedAt, session.messages.length);
  }
} else {
  console.log("No Claude Code session data found.");
}
```

Readers use native data locations by default. Moved yours? Pass `create("claude", { path: "/custom/claude/projects" })`. Sessions come back newest first, with messages in chronological order. Text, thinking, tool calls, tool results, roles, timestamps, and source metadata are normalized where the harness exposes them.

**Mind the archive size.** Library `list()` loads the complete archive, including message payloads, into memory. It is not the paged agent tool. A small loop can still have a large appetite.

Need more than one harness? `allSources()` creates every reader. Check each reader's `available()` before calling `list()`. The [public exports](./src/index.ts), [session contract](./src/core/session.ts), and [message types](./src/core/types.ts) have the details.

## 🗂️ Which harnesses?

| Harness     | Source name |
| ----------- | ----------- |
| AEI         | `aei`       |
| Claude Code | `claude`    |
| Codex       | `codex`     |
| Gemini CLI  | `gemini`    |
| Mastra      | `mastra`    |
| OMP         | `omp`       |
| OpenClaw    | `openclaw`  |
| OpenCode    | `opencode`  |
| Pi          | `pi`        |

Ask the registry rather than guessing names:

```bash
node --input-type=module -e 'import { sources } from "@agntn/sessions"; console.log(sources().join(", "));'
```

Output:

```text
aei, claude, codex, gemini, mastra, omp, openclaw, opencode, pi
```

OpenClaw also accepts `paths` for multiple native locations. See the [source registry](./src/sources/index.ts) for supported overrides and links to each parser.

## 🤖 Agent tools

Same three read-only tools in MCP, [Pi](https://pi.dev), and [OMP](https://omp.sh):

| Tool               | What you get                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `sessions_sources` | Supported harnesses and local data availability                                          |
| `sessions_list`    | A page of session IDs, message counts, last activity, and opening snippets, newest first |
| `sessions_read`    | A bounded message window from one exact session ID                                       |

Want the past day across every available harness? Call `sessions_list` once:

```json
{ "lastHours": 24 }
```

Pick a few with `"sources": ["codex", "pi"]`, or keep using `"source": "claude"` for one. The time filter uses each session's last activity, not its creation date. Snippets prefer the user's first text. Read the interesting conversation, not the whole haystack.

### MCP

Add this to your client's MCP configuration:

```json
{
  "mcpServers": {
    "sessions": {
      "command": "npx",
      "args": ["-y", "@agntn/sessions", "mcp"]
    }
  }
}
```

The server speaks stdio. With a local package install, `pnpm exec sessions mcp` starts it directly. Bring your own transport with `createMcpServer()` from `@agntn/sessions/mcp`.

### Pi and OMP

```bash
pi install npm:@agntn/sessions
omp install @agntn/sessions
```

The extensions and MCP use the [same executors](./src/tool-operations.ts). Extensions also attach structured details. MCP carries the answer and continuation instructions in text.

### Keep reading, without starting over

Use `source` with `path`, or `paths` where supported, to override one harness's location. Listings across harnesses use native locations and label each row with its source. Explicitly selected unavailable sources return an error. With no selection, only available sources are read.

Page session listings with `offset` and `limit` (up to 100). For a fixed period, pass `since` and/or `until` as ISO timestamps with a timezone. Both bounds are inclusive. Don't combine them with `lastHours`. Its response gives fixed bounds to reuse on later pages, so the time window doesn't move between calls. The archive itself isn't a snapshot.

For messages, `sessions_read` defaults to 20,000 response characters and accepts `maxChars` up to 100,000. Copy its returned `position` to continue, even inside a block. Use `offset` instead to start at a message boundary, never both.

These tools retain bounded summaries or the requested message window, not the complete archive. A listing still scans every transcript on each call. A read opens only the transcripts that can hold the session: Claude Code, Codex, Gemini CLI, and OpenClaw name them after it, while Pi and OMP settle each one from its header. OpenCode answers both from SQLite. AEI and Mastra still read their whole database. Bounded output does not mean instant reads.

Unknown sources, unreadable overrides, and missing session IDs return tool errors over MCP. See the [tool schemas](./src/mcp.ts) for all limits. Session text can contain private data. Only connect clients you trust with it.

## 🚫 Just the reader

No database of its own, synchronization cursors, watchers, full-text search, analytics, or long-term agent memory. Your application owns storage, indexing, rendering, and export. Reading a conversation also doesn't resume it in the original harness.

## 🛠️ Development

From a checkout:

```bash
pnpm install --frozen-lockfile
pnpm build
node dist/cli.mjs --help
```

Run the library examples from the repository root after building.

```bash
pnpm fmt        # Format and apply lint fixes
pnpm lint       # Check lint and formatting
pnpm typecheck  # Check the library and extensions
pnpm test:run   # Run the fixture and integration tests
```

Adding a harness? Start with the [adapter contract](./src/sources/AGENTS.md) and [parser tests](./test/unit). Keep native format quirks in the adapter, not in your caller.

## 💛 Thanks

Built with support from [Claude for Open Source](https://claude.com/contact-sales/claude-for-oss) and [Codex for Open Source](https://developers.openai.com/community/codex-for-oss). More room to build things like this. Much appreciated.

## 📄 License

[MIT](./LICENSE)
