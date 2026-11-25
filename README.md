# @agntn/sessions

[![npm version](https://npmx.dev/api/registry/badge/version/@agntn/sessions)](https://npmx.dev/package/@agntn/sessions)
[![npm downloads](https://npmx.dev/api/registry/badge/downloads/@agntn/sessions)](https://npmx.dev/package/@agntn/sessions)
[![license](https://npmx.dev/api/registry/badge/license/@agntn/sessions)](https://npmx.dev/package/@agntn/sessions)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/agntn/sessions)

📚 Read conversations from eleven AI coding harnesses through one TypeScript API. Your agent can read them too.

## Why?

The conversation you need is in another harness. Of course it is. `@agntn/sessions` reads each native store where it already sits and returns the same `Session`, `Message` and `Block` shapes. Build your viewer, export, or index without collecting parsers as a side hobby.

## ✨ Features

- 🧩 **Eleven harnesses, one shape.** Stop juggling eleven session formats.
- 🤖 **Agents included.** Three read-only tools, written once and wired into four hosts.
- 📖 **Bounded reads.** Continue where you left off, even in the middle of a block.
- 📁 **Directory filter.** Match a working directory and everything below it with `cwd`.
- 🚦 **Honest errors.** Tool results keep the harness's own `isError`. No flag means unknown, not success.
- 🛑 **Visible stops.** A Pi, OMP or Vibe turn that ended early says so: `[stop error] Connection error.`
- 🧾 **No paying twice.** `knownToolResults` swaps output you already read for digest references.

## 📦 Install

```bash
pnpm add @agntn/sessions
```

You'll need Node.js 26 or later.

## 🚀 First call

Want to see what happened in the last day? Run this:

```bash
npx @agntn/sessions list --last-hours 24
```

```text
Sources: claude. Last activity: since=2026-11-24T16:41:41.269Z (inclusive). Reuse these bounds instead of lastHours when paging.
claude	7f3c2a10-5b8e-4d21-9c6a-0e4f1b2d3a91	4 messages	2026-11-25T16:02:40.935Z	/work/shop	Why is CI red again?
```

After a local install, `pnpm exec sessions` gives you the bare `sessions` command below. Or run `pnpm add -g @agntn/sessions` once and keep it around.

```bash
sessions read claude 7f3c2a10-5b8e-4d21-9c6a-0e4f1b2d3a91
```

```text
[2026-11-25T15:59:40.935Z] user
Why is CI red again?

[2026-11-25T16:00:40.935Z] assistant
[tool_call Bash toolu_1] {"command":"pnpm test"}

[2026-11-25T16:01:40.935Z] user
[tool_result toolu_1 isError=true] FAIL test/cart.test.ts > applies the discount
expected 90 to be 81

[2026-11-25T16:02:40.935Z] assistant
The discount gets applied twice. Fixing `applyDiscount`.
```

No key and no config. It reads what's already on disk. And yes, CI had a point.

## 🧠 Library

```js
import { create } from "@agntn/sessions";

const reader = create("claude");
if (reader.available()) {
  for (const session of await reader.list()) {
    console.log(session.id, session.updatedAt, session.messages.length);
  }
}
```

And you're off. Moved your archive? Pass `create("claude", { path: "/custom/claude/projects" })`. Mind the archive size, though. `list()` hauls every message into memory. For big ones, `listSourceSessions` and `readSourceSession` read a page at a time.

More in the [public exports](./src/index.ts), [window types](./src/tool-reader.ts), [session contract](./src/core/session.ts) and [message types](./src/core/types.ts).

## 🗂️ Which harnesses?

| Harness      | Source name |
| ------------ | ----------- |
| Claude Code  | `claude`    |
| Codex        | `codex`     |
| Gemini CLI   | `gemini`    |
| Grok         | `grok`      |
| Mastra       | `mastra`    |
| Mistral Vibe | `vibe`      |
| OMP          | `omp`       |
| OpenBot      | `openbot`   |
| OpenClaw     | `openclaw`  |
| OpenCode     | `opencode`  |
| Pi           | `pi`        |

OpenBot keeps no tool calls. Each message's `context` names the `providerSessionId` instead, so hand it to the `codex` or `claude` reader. Vibe subagent runs show up as sessions of their own. Overrides and parsers live in the [source registry](./src/sources/index.ts).

## 🤖 Agent tools

Three read-only tools, the same in MCP, [Pi](https://pi.dev), [OMP](https://omp.sh) and the CLI:

| Tool               | What you get                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `sessions_sources` | Supported harnesses and local data availability                                             |
| `sessions_list`    | Session IDs, message counts, last activity, working directories, and snippets, newest first |
| `sessions_read`    | A bounded message window from one exact session ID                                          |

One call with `{ "lastHours": 24 }` covers every available harness. Read the interesting conversation, not the whole haystack. Same prompt in four repos? Four identical snippets. A fine collection of mystery twins. Filter with `{ "cwd": "/work/project" }`. Sessions without a recorded directory never match.

### MCP

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

The server speaks stdio and works with 2025 and 2026 MCP clients. For your own transport, take `createMcpServer()` from `@agntn/sessions/mcp`.

### Pi and OMP

```bash
pi install npm:@agntn/sessions
omp install @agntn/sessions
```

Both load the [same tool definitions](./src/tools.ts) as MCP and the CLI.

### CLI

```bash
sessions list --source pi --last-hours 24 --limit 5
sessions read pi SESSION_ID --max-chars 4000
sessions list --sources '["pi","codex"]' --json
```

Your terminal prints exactly what the model gets from the tool. Agent says a session doesn't exist? Check it yourself with the same call. Prefer structured details? Pass `--json`.

### Long sessions

Copy the returned `position` to continue, and set `maxChars` to fit your budget. `since` and `until` cut a time window. Pass `knownToolResults` to swap tool output you already read for digest references. Every limit is in the [tool schemas](./src/tools.ts).

Session text can contain private data. Only connect clients you trust with it.

## 🚫 Just the reader

No database of its own, no sync cursors, watchers, search, analytics or long-term agent memory. Your application owns storage, indexing, rendering and export. Reading a conversation also doesn't resume it in the original harness.

## 🛠️ Development

```bash
pnpm install --frozen-lockfile
pnpm build
node dist/cli.mjs --help
```

```bash
pnpm fmt        # Format and apply lint fixes
pnpm lint       # Check lint and formatting
pnpm typecheck  # Check the library and extensions
pnpm test:run   # Run the fixture and integration tests
```

Adding a harness? Start with the [adapter contract](./CONTRIBUTING.md#adapters) and [parser tests](./test/unit). Keep native format quirks in the adapter, not in your caller.

## 💛 Thanks

Built with support from [Claude for Open Source](https://claude.com/contact-sales/claude-for-oss) and [Codex for Open Source](https://developers.openai.com/community/codex-for-oss). More room to build things like this. Much appreciated.

## 📄 License

[MIT](./LICENSE)
