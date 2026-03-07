# memxa

Universal AI conversation memory store.

## Architecture

- `src/core/` — registry, ingest engine, types, errors
- `src/storage/` — db0-based storage (provider-agnostic, async API)
- `src/sources/` — adapters for AI tools (aei, claude, mastra, opencode, codex, gemini, openclaw)
- `src/cli.ts` — CLI interface via citty

## Conventions

- Source adapters export factory functions, no side-effect registration
- Storage is async (db0) — all methods return Promises
- Storage accepts db0 connector in constructor, `createSqliteStorage(path)` for convenience
- All exports are explicit through package.json `exports` field
- Tests in `test/unit/`
