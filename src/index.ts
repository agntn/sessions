// Core API
export { register, createSource, sources, allSources, has } from './core/registry.ts'
export { ingest } from './core/ingest.ts'
export type { IngestOptions } from './core/ingest.ts'

// Storage
export { SqliteStorage, createSqliteStorage } from './storage/sqlite.ts'

// Errors
export {
  MemxaError,
  SourceUnavailableError,
  UnknownSourceError,
  StorageError,
} from './core/errors.ts'

// Types
export type {
  Message,
  Block,
  BlockType,
  Source,
  Storage,
  SourceFactory,
  IngestResult,
} from './core/types.ts'
