# AGENTS.md

## Purpose

`@agntn/sessions` has one scope: discover, read, and normalize native AI coding harness sessions.

## Boundaries

- Keep one adapter per harness in `src/sources/`.
- Public readers expose `name`, `available()`, and `list()`.
- Normalize native conversations to `Session`, `Message`, and `Block`.
- Preserve parser behavior for every supported harness with fixture tests.
- Do not add persistence, synchronization cursors, watchers, search, analytics, channels as a standalone domain, or agent-memory ingestion.
- Applications own indexing, storage, rendering, and export.
- Keep the pi extension in `packages/pi/extensions/` as a bounded read-only consumer of the public API.

## Commands

```bash
pnpm fmt
pnpm lint
pnpm typecheck
pnpm test:run
pnpm build
```
