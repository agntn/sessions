# @agntn/sessions

[![npm version](https://npmx.dev/api/registry/badge/version/@agntn/sessions)](https://npmx.dev/package/@agntn/sessions)
[![npm downloads](https://npmx.dev/api/registry/badge/downloads/@agntn/sessions)](https://npmx.dev/package/@agntn/sessions)
[![license](https://npmx.dev/api/registry/badge/license/@agntn/sessions)](https://npmx.dev/package/@agntn/sessions)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/agntn/sessions)

📚 Read conversations from ten AI coding harnesses through one TypeScript API. Your agent can read them too.

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

Readers use native data locations by default. Moved yours? Pass `create("claude", { path: "/custom/claude/projects" })`. Grok reads `$GROK_HOME/sessions` when that variable is set, and `~/.grok/sessions` otherwise. Sessions come back newest first, with messages in chronological order. Text, thinking, tool calls, tool results, roles, timestamps, and source metadata are normalized where the harness exposes them.

**Mind the archive size.** Library `list()` loads the complete archive, including message payloads, into memory. For large archives, read a page instead:

```js
import { createSource, listSourceSessions, readSourceSession } from "@agntn/sessions";

const source = createSource("claude");
if (source.available()) {
  const page = await listSourceSessions(source, 0, 20);
  for (const session of page.sessions) {
    const window = await readSourceSession(source, session.id, 0, 100);
    console.log(session.id, window.messages);
  }
}
```

`createSource()` accepts the same location overrides as `create()`. Continue a message read with `window.nextMessage` as the offset when it's defined.

Both functions take a zero-based `offset`, a positive integer `limit`, and optional `{ since, until }` bounds in epoch milliseconds. Summary bounds filter last activity; message bounds filter individual timestamps, excluding known file or session fallbacks. Both endpoints are inclusive. Summary `total` counts matching sessions. Message `total` counts the entire selected session, while `indices` and `nextMessage` retain its original positions, even across filtered gaps. Reuse the same bounds when continuing.

Messages arrive in native read order, with complete blocks and no character truncation. The limit counts messages, not bytes: one large message can still be large. An empty time window keeps the session's total; a missing exact ID returns zero. These functions share the agent tools' projections and [scan limitations](#keep-reading-without-starting-over), not an index or snapshot. See the [window types](./src/tool-reader.ts) for the result shapes.

Need more than one harness? `allSources()` creates every reader. Check each reader's `available()` before calling `list()`. The [public exports](./src/index.ts), [session contract](./src/core/session.ts), and [message types](./src/core/types.ts) have the details.

## 🗂️ Which harnesses?

| Harness     | Source name |
| ----------- | ----------- |
| AEI         | `aei`       |
| Claude Code | `claude`    |
| Codex       | `codex`     |
| Gemini CLI  | `gemini`    |
| Grok        | `grok`      |
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
aei, claude, codex, gemini, grok, mastra, omp, openclaw, opencode, pi
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

Page session listings with `offset` and `limit` (up to 100). For a fixed period, pass `since` and/or `until` as ISO timestamps with a timezone. Both bounds are inclusive. Don't combine them with `lastHours`. Its response gives fixed bounds to reuse on later pages, so the time window doesn't move between calls. The archive itself isn't a snapshot. With `since`, Claude, Codex, Pi and OMP skip a session whose files were all last written before it, so a transcript with a backdated modification time drops out of that listing.

Pi and OMP tool results retain the native `isError` boolean, including results with no text. `sessions_read` prints it beside the tool call ID. An absent flag means unknown, not success.

For messages, `sessions_read` defaults to 20,000 response characters and accepts `maxChars` up to 100,000. Copy its returned `position` to continue, even inside a block. Use `offset` instead to start at a message boundary, never both.

To avoid rereading known tool bodies, pass `knownToolResults: []`. This labels each tool-result body with its digest and original length, without omitting anything. After reading a complete body, put its 64-character lowercase digest in `knownToolResults` on a new read. Up to 100 digests are accepted. Matching bodies become explicit references with their original message/block position and a complete ordinary `sessions_read` request to recover the text. Timestamps, call IDs, and error flags remain visible.

Digests use SHA-256 over the normalized text encoded as UTF-16LE. Lengths count UTF-16 code units, like `position.character`. Keep the same list while following a continuation, including an empty list: character positions address that rendered view. Start a new read at a message boundary when changing the list. A digest label doesn't mean the whole body fit on the page. The caller owns the list, and nothing is remembered between calls. Equal text isn't independent evidence or trusted provenance. Omit the option for the original full transcript. Library message records stay unchanged.

To read only messages from a period, pass `since` and/or `until` to `sessions_read` too. These bounds apply to message timestamps, not session activity, and include both endpoints. For example:

```json
{
  "source": "pi",
  "sessionId": "SESSION_ID",
  "since": "2026-01-02T00:00:00Z",
  "until": "2026-01-03T00:00:00Z"
}
```

Reuse the same bounds with each returned `position`. `limit` caps matching messages (100 by default, up to 500); `offset` and continuation positions still refer to the original session, never a renumbered subset. Messages with invalid or inferred timestamps are excluded only when filtering. Without bounds, their content stays readable and fallback times are labeled `inferred from file` or `inferred from session`. A period with no matches returns an empty window, not a missing-session error.

File adapters expose `Message.timestampSource` as `message`, `session`, or `file`. Legacy Codex JSON uses session time plus item order, not individual message times. Grok doesn't stamp each line. Creation and last activity come from `summary.json`, or from the file when that summary is missing. Other sources can leave provenance absent; filters then check the timestamp itself. Session activity listings still use fallback times.

These tools retain bounded summaries or the requested message window, not the complete archive. A listing still scans every transcript on each call. A read opens only the transcripts that can hold the session. Claude Code, Codex, Gemini CLI, and OpenClaw name the file after it. Grok names the session directory. Pi and OMP open a project file whose name holds the id, including the shortened id OMP writes, and still check nested runs from the header. OpenCode answers both from SQLite. AEI and Mastra still read their whole database. Bounded output does not mean instant reads.

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
