# memxa

Universal AI conversation memory. Ingest sessions from any coding assistant into a single searchable store.

## Features

- **7 source adapters** — Claude Code, Codex, Gemini CLI, Mastra, OpenCode, AEI, OpenClaw
- **Drizzle-backed SQLite storage** — `better-sqlite3` runtime with `drizzle-orm`
- **Async API** — Node-friendly programmatic API and CLI
- **CLI** — `memxa ingest`, `memxa search`, `memxa stats`, `memxa sources`
- **Incremental** — cursor-based, re-runs only ingest new messages

## Install

```bash
npm install memxa
```

## Quick start

```ts
import { createSqliteStorage, register, allSources, ingest } from 'memxa'
import { builtinSources } from 'memxa/sources'

// Register adapters
for (const [name, factory] of Object.entries(builtinSources)) {
  register(name, factory())
}

// Create storage
const storage = await createSqliteStorage('./memory.db')

// Ingest from all available sources
const results = await ingest(allSources(), storage, { verbose: true })

// Search
const hits = await storage.search('refactor auth module')
```

## CLI

```bash
# Ingest from all sources
memxa ingest --db ./memory.db

# Only specific sources
memxa ingest --db ./memory.db --only claude,codex

# Dry run
memxa ingest --db ./memory.db --dry-run

# Search conversations
memxa search "error handling" --db ./memory.db

# Show stats
memxa stats --db ./memory.db

# List available sources
memxa sources
```

## Storage

```ts
import { SqliteStorage } from 'memxa'

const storage = new SqliteStorage('./memory.db')
await storage.init()

Migrations are managed with `drizzle-kit`, and the runtime opens a local SQLite database through `better-sqlite3`.
```

## Sources

| Source | Reads from |
|--------|-----------|
| `aei` | `~/.config/aei/.cache/memory.db` |
| `claude` | `~/.claude/projects/` |
| `codex` | `~/.codex/state_5.sqlite` |
| `gemini` | `~/.gemini/tmp/` |
| `mastra` | `~/.local/share/mastracode/mastra.db` |
| `opencode` | `~/.local/share/opencode/opencode.db` |
| `openclaw` | Discord export sessions |

All paths are defaults — each adapter accepts custom paths.

## License

MIT
