/** Base error for session reader failures. */
export class SessionsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionsError";
  }
}

/** Thrown when a source exists but is unavailable on this machine. */
export class SourceUnavailableError extends SessionsError {
  readonly source: string;

  constructor(source: string) {
    super(`Source "${source}" is not available`);
    this.name = "SourceUnavailableError";
    this.source = source;
  }
}

/** Thrown when a requested harness source is unsupported. */
export class UnknownSourceError extends SessionsError {
  readonly source: string;

  constructor(source: string) {
    super(`Unknown source "${source}"`);
    this.name = "UnknownSourceError";
    this.source = source;
  }
}
