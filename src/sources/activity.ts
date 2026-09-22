/** A transcript file with the last time its harness wrote to it. */
export interface WrittenFile {
  readonly mtime: number;
}

/**
 * Keeps the transcripts of every session that may have been active at or after `activeSince`.
 *
 * A harness stamps a message no later than the write that stores it, so a session whose every
 * transcript was last written before the bound ended before it. A session spread over several
 * files stays whole: one recent file keeps all of them, in their original order.
 *
 * @param files - Transcripts in read order.
 * @param sessionOf - The session a transcript belongs to.
 * @param activeSince - Epoch milliseconds a listing needs, or every file when omitted.
 * @returns {T[]} The transcripts to read, in read order.
 */
export function activeFiles<T extends WrittenFile>(
  files: readonly T[],
  sessionOf: (file: T) => string,
  activeSince: number | undefined,
): T[] {
  if (activeSince === undefined) return [...files];
  const sessions = files.map((file) => ({ file, session: sessionOf(file) }));
  const active = new Set(
    sessions.flatMap(({ file, session }) => (file.mtime >= activeSince ? [session] : [])),
  );
  return sessions.flatMap(({ file, session }) => (active.has(session) ? [file] : []));
}
