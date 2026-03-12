# CORE MODULE GUIDE

## OVERVIEW

`src/core/` contains shared contracts and orchestration logic used by CLI and source/storage layers.

## WHERE TO LOOK

| Task                      | Location                               | Notes                                                        |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------ |
| Adjust ingest workflow    | `src/core/ingest.ts`                   | Source iteration, batching, dry-run behavior                 |
| Add/change shared types   | `src/core/types.ts`                    | Defines `Source`, `Storage`, `Message`, and result contracts |
| Add/change project errors | `src/core/errors.ts`                   | Keep semantic error classes explicit                         |
| Change env/path helpers   | `src/core/env.ts`, `src/core/paths.ts` | Keep side effects minimal                                    |

## CONVENTIONS

- Keep contracts declarative in `types.ts`; avoid runtime logic there.
- `ingest()` should remain source-agnostic and delegate provider specifics to adapters.
- Use small, explicit error classes instead of stringly-typed errors.
- Preserve dry-run semantics: preview only, no DB writes.

## ANTI-PATTERNS

- Do not couple ingest orchestration to a specific source format.
- Do not mutate cursor state during dry-run mode.
- Do not add storage-specific SQL details inside core logic.

## NOTES

- Any API change in `src/core/types.ts` likely requires updates in both `src/storage/` and `src/sources/`.
