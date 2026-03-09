# memxa

Universal AI conversation memory store.

## Architecture

- `src/core/` — ingest engine, types, errors
- `src/storage/` — local SQLite storage via libsql client and shared drizzle-orm schema
- `src/sources/` — adapters for AI tools (aei, claude, mastra, opencode, codex, gemini, openclaw)
- `src/cli.ts` — CLI interface via citty

## Conventions

- Source adapters export classes implementing `Source` interface
- `create(name)` instantiates a built-in source by name (websxa pattern)
- Storage is async at the interface boundary — all methods return Promises
- Storage uses `SqliteStorage(path)` internally, `createSqliteStorage(path)` for convenience
- Local storage via `SqliteStorage(path)` and `createSqliteStorage(path)`
- All exports are explicit through package.json `exports` field
- Tests in `test/unit/`
