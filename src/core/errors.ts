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

/** Native data a source reads from its path: a directory of session files or one database file. */
export type SourceData = "directory" | "database file";

/** Thrown when a path override is a file where the source reads a directory, or the other way round. */
export class SourcePathError extends SessionsError {
  readonly source: string;
  readonly path: string;
  readonly expected: SourceData;

  constructor(source: string, path: string, expected: SourceData) {
    super(
      expected === "directory"
        ? `${source} reads a directory of sessions, and ${path} is not a directory. Point path at the sessions directory, not at one session file.`
        : `${source} reads a database file, and ${path} is not a file. Point path at the database itself.`,
    );
    this.name = "SourcePathError";
    this.source = source;
    this.path = path;
    this.expected = expected;
  }
}
