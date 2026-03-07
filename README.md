# memxa

Universal AI conversation memory. Ingest sessions from any coding assistant into a single searchable store.

## Install

```bash
pnpm add memxa
```

## Usage

```ts
import { register, ingest, allSources, SqliteStorage } from 'memxa'
import { aei, claude, mastra } from 'memxa/sources'

// Register sources you want
register('aei', aei())
register('claude', claude())
register('mastra', mastra())

// Ingest into SQLite
const storage = new SqliteStorage('./memory.db')
storage.init()

const results = await ingest(allSources(), storage)
```

## CLI

```bash
memxa ingest --db ./memory.db
memxa stats --db ./memory.db
memxa search "topic" --db ./memory.db
memxa sources
```

## Sources

| Source | Tool | Path |
|--------|------|------|
| `aei` | AEI CLI | `~/.config/aei/.cache/memory.db` |
| `claude` | Claude Code | `~/.claude/projects/` |
| `mastra` | Mastra | `~/.mastra/memory/` |
| `opencode` | OpenCode | `~/.local/share/opencode/` |
| `codex` | Codex CLI | `~/.codex/` |
| `gemini` | Gemini CLI | `~/.gemini/` |
| `openclaw` | OpenClaw | `~/.config/aei/.cache/memory.db` |

## License

MIT
