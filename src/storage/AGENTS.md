# STORAGE MODULE GUIDE

## OVERVIEW

`src/storage/` defines the database schema and local persistence implementation used by memxa.

## WHERE TO LOOK

| Task                                | Location                    | Notes                                           |
| ----------------------------------- | --------------------------- | ----------------------------------------------- |
| Change schema columns/relations     | `src/storage/schema.ts`     | Keep table names and foreign keys stable        |
| Change runtime persistence behavior | `src/storage/sqlite.ts`     | Implements full `Storage` contract              |
| Add migration SQL                   | `drizzle/*.sql`             | Update `drizzle/meta/_journal.json` accordingly |
| Validate storage behavior           | `test/unit/storage.test.ts` | Broad CRUD/search/cursor/migration coverage     |

## CONVENTIONS

- Storage implementation is local SQLite over `@libsql/client` with Drizzle libsql driver.
- `init()` runs runtime migrations via `drizzle-orm/libsql/migrator`.
- All public storage operations are async and return `Promise` values.
- Batch writes should stay atomic and deterministic.
- Search query handling must escape SQL LIKE wildcards and preserve filters.

## ANTI-PATTERNS

- Do not assume cloud/remote DB runtime in this module.
- Do not skip migration folder resolution or silently ignore missing migrations.
- Do not introduce non-escaped LIKE matching for user-provided terms.
- Do not break foreign key cascade assumptions relied upon in tests.

## NOTES

- Maintain API compatibility with `Storage` in `src/core/types.ts`.
- Keep helper functions local and composable; avoid spreading SQL fragments across modules.
