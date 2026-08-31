/** Base error for session reader failures. */
export class SessionsError extends Error {
  constructor(message: string, options?: Readonly<ErrorOptions>) {
    super(message, options);
    this.name = "SessionsError";
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
