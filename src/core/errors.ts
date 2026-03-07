/** Base error for all memxa errors. */
export class MemxaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MemxaError'
  }
}

/** Thrown when a source is registered but not available on this machine. */
export class SourceUnavailableError extends MemxaError {
  readonly source: string

  constructor(source: string) {
    super(`Source "${source}" is not available`)
    this.name = 'SourceUnavailableError'
    this.source = source
  }
}

/** Thrown when a requested source is not registered. */
export class UnknownSourceError extends MemxaError {
  readonly source: string

  constructor(source: string) {
    super(`Unknown source "${source}"`)
    this.name = 'UnknownSourceError'
    this.source = source
  }
}

/** Thrown on storage-level failures. */
export class StorageError extends MemxaError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'StorageError'
  }
}
