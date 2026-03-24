// Core API
export { create, sources, allSources, has } from "./sources/index.ts";
export { ingest } from "./core/ingest.ts";
export type { IngestOptions } from "./core/ingest.ts";

// Utils
export { parseFrontmatter } from "./core/frontmatter.ts";
export type { Frontmatter } from "./core/frontmatter.ts";

// Storage
export { SqliteStorage, createSqliteStorage } from "./storage/sqlite.ts";
export { defaultDbPath } from "./core/paths.ts";

// Errors
export {
  MemxaError,
  SourceUnavailableError,
  UnknownSourceError,
  StorageError,
} from "./core/errors.ts";

// Types
export type {
  Message,
  Block,
  Channel,
  Participant,
  Source,
  Session,
  Storage,
  StoredMessage,
  SearchRow,
  SourceStats,
  IngestResult,
} from "./core/types.ts";
