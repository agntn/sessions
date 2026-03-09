# memxa

[![npm version](https://img.shields.io/npm/v/memxa?style=flat&colorA=130f40&colorB=474787)](https://npmjs.com/package/memxa)
[![npm downloads](https://img.shields.io/npm/dm/memxa?style=flat&colorA=130f40&colorB=474787)](https://npm.chart.dev/memxa)
[![license](https://img.shields.io/github/license/oritwoen/memxa?style=flat&colorA=130f40&colorB=474787)](https://github.com/oritwoen/memxa/blob/main/LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/oritwoen/memxa)

Universal AI conversation memory store. Ingest sessions from coding assistants into a single searchable database with relational participants and channels.

## Features

- **7 source adapters** - Claude Code, Codex, Gemini CLI, Mastra, OpenCode, AEI, OpenClaw
- **Relational memory schema** - sessions, messages, channels, participants, and authors
- **Local SQLite backend** - `@libsql/client` with Drizzle ORM and drizzle-kit migrations
- **Async API** - Node-friendly programmatic API and CLI
- **CLI** - `memxa ingest`, `memxa search`, `memxa stats`, `memxa sources`
- **Incremental** - cursor-based, re-runs only ingest new messages

## Install

```bash
npm install memxa
```

## Quick start

```ts
import { createSqliteStorage, allSources, ingest } from "memxa";

const storage = await createSqliteStorage("./memory.db");
const results = await ingest(allSources(), storage, { verbose: true });
const hits = await storage.search("refactor auth module");
```

## CLI

```bash
# Ingest from all sources (uses default OS data path)
memxa ingest

# Only specific sources
memxa ingest --db ./memory.db --only claude,codex

# Dry run
memxa ingest --db ./memory.db --dry-run

# Search conversations
memxa search "error handling"

# Show stats
memxa stats

# List available sources
memxa sources
```

## Storage

```ts
import { SqliteStorage } from "memxa";

const storage = new SqliteStorage("./memory.db");
await storage.init();
```

Migrations are managed with `drizzle-kit`, and the runtime opens a local SQLite database through `@libsql/client`.

## Sources

| Source     | Reads from                                         |
| ---------- | -------------------------------------------------- |
| `aei`      | `~/.config/aei/.cache/memory.db`                   |
| `claude`   | `~/.claude/projects/`                              |
| `codex`    | `~/.codex/sessions/`                               |
| `gemini`   | `~/.gemini/tmp/`                                   |
| `mastra`   | `~/.local/share/mastracode/mastra.db`              |
| `opencode` | `~/.local/share/opencode/opencode.db`              |
| `openclaw` | `~/.config/aei/external/openclaw-sessions/*.jsonl` |

All paths are defaults, each adapter accepts custom paths.

## License

MIT
