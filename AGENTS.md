# memxa

Universal AI conversation memory store.

## Architecture

- `src/core/` — registry, ingest engine, types, errors
- `src/storage/` — SQLite storage via drizzle-orm and better-sqlite3
- `src/sources/` — adapters for AI tools (aei, claude, mastra, opencode, codex, gemini, openclaw)
- `src/cli.ts` — CLI interface via citty

## Conventions

- Source adapters export factory functions, no side-effect registration
- Storage is async at the interface boundary — all methods return Promises
- Storage uses `SqliteStorage(path)` internally, `createSqliteStorage(path)` for convenience
- All exports are explicit through package.json `exports` field
- Tests in `test/unit/`
