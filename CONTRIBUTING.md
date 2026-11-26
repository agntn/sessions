# Contributing

## Scope

`@agntn/sessions` discovers, reads and normalizes native session stores from AI coding harnesses. It turns them into `Session`, `Message` and `Block`. That is the whole job.

It does not own persistence, synchronization cursors, watchers, search or analytics. Channels are not a standalone domain here. Ingesting agent memory is out too.

Applications own indexing, storage, rendering and export. Memory stores and conversation databases are not harness session sources. This package keeps refusing to become a database. Good.

## Core contract

Keep `src/core/` independent of databases and UI frameworks. A `SessionReader` exposes only `name`, `available()` and `list()`.

Messages come back in chronological order. Sessions come back in a deterministic order. `test/unit/session.test.ts` holds both rules.

## Adapters

Keep one adapter per harness in `src/sources/`. Parsing belongs inside that adapter.

Does a harness adopt another harness's native format? The original harness owns the parser. The derivative adapter depends on it. The `omp` adapter, for example, builds on the `pi` parser.

`available()` checks whether the native source exists. `read()` reads the complete native archive, with no synchronization cursor. The one exception is an exact session filter the native store can answer itself.

A native summary projection may aggregate bounded metadata without building message payloads. Keep text, thinking, tool calls, tool results, roles, timestamps, session IDs and useful native metadata. Never truncate native data silently.

Open SQLite databases through `openDatabase()` from `src/core/db.ts`. It opens them read-only, since the harness owns the file and we only look. It also loads `node:sqlite` lazily, so a process that only lists sources never touches it. `test/unit/db.test.ts` goes red on a static import.

## Agent tools

Declare each tool once in `src/tools.ts`, using `defineTool` from `@agntn/tools`. Put executors in `src/tool-operations.ts`. MCP, Pi, OMP, the AI SDK and the CLI take that list through the adapters. No surface redeclares a schema or reimplements an operation.

Take `Type` from `@agntn/tools`, never a bare `typebox` import. OMP rewrites that specifier to its own facade. Keep `typebox` out of `package.json` too. Pi 0.99 warns on every load when a package lists it. `@agntn/tools` carries its own copy.

`test/unit/host-peers.test.ts` checks the manifest, `src/`, `extensions/` and the built `dist/`.

An MCP client reads `content`, never `details`. Tool text must carry whatever the next call needs.

Keep reads bounded without persistence, caching or indexes of their own. Stream summaries and requested message windows. Use a native projection when the source store can answer more narrowly.

OMP has models fill every optional field. Its validator drops `""` only where the schema sets `minLength`. It rejects values below a minimum before `execute`. So zeros and `sources: []` never reach the extension.

`extensions/omp/` wraps the list and read executors. It treats these inputs as unset:

- A blank or whitespace string, or `paths: []`.
- A source already in `sources`.
- A filler `lastHours` beside real `since` or `until` bounds.
- A zero `offset` or `position` beside the other one.

Leave `knownToolResults: []` alone. It is the documented way to start digest labels. A new optional field needs the same pass in `extensions/omp/`, or OMP can't call the tool at all. OMP does like filling in the blanks.

## Local MCP server

Inside a checkout, a bare `dist/cli.mjs mcp` serves `src/mcp.ts`. Restart the local server to pick up edits.

The npm package, copies under `node_modules` and `SESSIONS_DIST=1` keep the bundle. `test/unit/bin.test.ts` runs `mcp` in each layout. It connects a 2025 and a 2026 MCP client to both.

## Tests

Build native records in temporary directories. Remove every resource in `afterEach`. Assert normalized observable behavior, not private parser helpers.

Keep fixtures small. Test shared parser behavior only in the adapter that owns it. Every harness needs fixture tests in `test/unit/<name>-source.test.ts`. `test/unit/sources.test.ts` fails when a registered harness has none.

## Checks

CI runs these commands in order:

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm test:run
```

Run `pnpm fmt` to fix formatting.
