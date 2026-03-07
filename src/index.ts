// Core API
export { register, createSource, sources, allSources, has } from './core/registry.ts'
export { ingest } from './core/ingest.ts'
export type { IngestOptions } from './core/ingest.ts'

// Storage
export { Db0Storage, createSqliteStorage } from './storage/db.ts'
export type { Db0StorageOptions } from './storage/db.ts'

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
