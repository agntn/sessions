# memxa Agent Playbook

Use this file as the default operating guide for coding agents in this repository.
Verify from code before claiming. Prefer concrete commands and paths over assumptions.

## Quick Commands

```bash
pnpm install
pnpm run dev:prepare
pnpm run build
pnpm run lint
pnpm run fmt
pnpm run typecheck
pnpm run test:run
pnpm run db:check
pnpm run db:generate
pnpm run db:migrate
```

Single-test examples (Vitest):

```bash
pnpm vitest run test/unit/storage.test.ts
pnpm vitest run test/unit/ingest.test.ts -t "dry run does not write to storage"
pnpm vitest run test/unit/storage.test.ts:52
```

## Codebase Map

```text
src/cli.ts            citty CLI commands: ingest, stats, sources, search
src/core/             contracts + ingest orchestration + shared errors/helpers
src/sources/          provider adapters (aei, claude, codex, gemini, mastra, opencode, openclaw)
src/storage/          schema + SQLite storage implementation
drizzle/              SQL migrations + drizzle metadata journal
test/unit/            Vitest unit tests (ingest, storage, sources, adapter-specific)
```

Where to make changes:

- CLI behavior: `src/cli.ts`
- Ingest flow and dry-run semantics: `src/core/ingest.ts`
- Source adapter contract/registration: `src/sources/*.ts`, `src/sources/index.ts`
- Persistence/query logic: `src/storage/sqlite.ts`, `src/storage/schema.ts`
- Migration changes: `drizzle/*.sql` and `drizzle/meta/_journal.json`

Local module guides:

- `src/core/AGENTS.md`
- `src/sources/AGENTS.md`
- `src/storage/AGENTS.md`

## Code Conventions

- Language/runtime: TypeScript ESM (`"type": "module"`, explicit `.ts` imports).
- Formatting: `.editorconfig` requires 2 spaces, LF, final newline; lint/format with `oxlint` + `oxfmt`.
- Type strictness: `tsconfig.json` sets `strict: true` and `noUnusedLocals: true`.
- Async boundaries: `Storage` and ingestion APIs are async; preserve `Promise`-based interfaces in `src/core/types.ts`.
- Source adapters: class-based `Source` implementations with `name`, `available()`, `async *ingest(cursor)`, `cursor(messages)`.
- Parsing style: prefer defensive fallbacks (`Number.isFinite`, malformed JSON guards) and bounded block text (typically `slice(0, 8000)`).
- Storage/query style: keep search term escaping for SQL LIKE and keep migrations folder resolution fail-loud in storage init.

Hard bans:

- No `as any`.
- No `@ts-ignore` or `@ts-expect-error`.
- No empty `catch {}` blocks.

## Execution Workflow

1. Explore first: read nearby files, tests, and existing patterns before editing.
2. Plan narrow diffs: touch only files needed for the change.
3. Edit with local consistency: naming, import style, and error handling should match surrounding code.
4. Verify after edits (minimum):
   - `pnpm run typecheck`
   - `pnpm run lint`
   - `pnpm run test:run`
   - `pnpm run build` when changing public API/CLI/build outputs
5. If schema/storage logic changes, also run `pnpm run db:check`.
6. For schema evolution, prefer `db:generate` + `db:migrate`; avoid `drizzle-kit push` unless explicitly requested for a one-off local workflow.

## Memory Workflow

- Before answering past-context questions, search memory first instead of relying on recall.
- Reuse prior decisions only when they still match current repo code; code wins on conflicts.
- Log durable learnings to the appropriate memory bucket (for example `~/.config/aei/memory/learnings/`).
- When writing daily notes, use the event date (when it happened), not the write date.

## Safety and Git Hygiene

- Do not run destructive git operations (`reset --hard`, `checkout --`, force-push) unless explicitly requested.
- Do not revert unrelated local changes in a dirty tree.
- Do not commit or push unless explicitly requested.
- Never leak secrets or local credential material in logs, diffs, or summaries.
- Treat migrations and data-path behavior as safety-critical: local-first SQLite is the default, not remote DBs.

## Communication Style

- Be concise, direct, and human.
- Explain why for non-obvious decisions.
- State uncertainty explicitly and include how to verify it.
- Avoid template filler; prefer concrete file paths and commands.
