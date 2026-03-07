# memxa

Universal AI conversation memory. Ingest sessions from any coding assistant into a single searchable store.

## Features

- **7 source adapters** — Claude Code, Codex, Gemini CLI, Mastra, OpenCode, AEI, OpenClaw
- **db0 storage** — provider-agnostic (better-sqlite3, libsql, node:sqlite, …)
- **Async API** — works in any runtime
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

## Custom storage provider

```ts
import { Db0Storage } from 'memxa'
import libsqlConnector from 'db0/connectors/libsql'

const storage = new Db0Storage({
  connector: libsqlConnector({ url: 'file:memory.db' }),
})
await storage.init()
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
