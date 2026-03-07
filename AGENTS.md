# memxa

Universal AI conversation memory store.

## Architecture

- `src/core/` — registry, ingest engine, types, errors
- `src/storage/` — SQLite storage with FTS, embeddings cache, knowledge tables
- `src/sources/` — adapters for AI tools (aei, claude, mastra, opencode, codex, gemini, openclaw)
- `src/embeddings.ts` — local embedding via HuggingFace transformers (optional)
- `src/cli.ts` — CLI interface via citty

## Conventions

- Source adapters export factory functions, no side-effect registration
- Storage accepts path in constructor, no hardcoded paths
- All exports are explicit through package.json `exports` field
- Tests in `test/unit/`
