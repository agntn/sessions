# SOURCES MODULE GUIDE

## OVERVIEW

`src/sources/` contains provider-specific ingestion adapters that normalize external session formats into `Message` records.

## WHERE TO LOOK

| Task                                     | Location                    | Notes                                      |
| ---------------------------------------- | --------------------------- | ------------------------------------------ |
| Register a new provider                  | `src/sources/index.ts`      | Add class import and `providers` map entry |
| Implement adapter logic                  | `src/sources/<provider>.ts` | Must implement `Source` interface methods  |
| Update source list/availability behavior | `src/sources/index.ts`      | `create`, `sources`, `allSources`, `has`   |
| Validate source parser behavior          | `test/unit/sources.test.ts` | Covers factory and adapter setup patterns  |

## CONVENTIONS

- One file per provider, class name pattern `<Provider>Source`.
- Adapters must expose `name`, `available()`, `async *ingest(cursor)`, `cursor(messages)`.
- Emit only normalized `Message` structures with bounded text payloads (truncate long text).
- Prefer robust timestamp handling (`Number.isFinite` checks, safe fallbacks).
- Use context fields only for stable metadata useful for search or attribution.

## ANTI-PATTERNS

- Do not bypass `src/sources/index.ts`; unregistered adapters are unreachable from CLI/library factory.
- Do not emit invalid roles outside `user`, `assistant`, `tool`.
- Do not leak provider-specific raw payloads directly into message text blocks.
- Do not mix cursor clocks (file mtime vs message timestamp) without explicit normalization.

## NOTES

- Keep provider parsing isolated; shared normalization belongs in `src/core/types.ts` contracts.
- For file-based providers, sort deterministic input order before yielding messages.
