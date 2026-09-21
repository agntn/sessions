import type { Message, Source } from "./types.ts";

/** A normalized conversation session from an AI coding harness. */
export interface Session {
  readonly id: string;
  readonly source: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messages: readonly Message[];
}

/** Lists normalized sessions from one harness source. */
export interface SessionReader {
  readonly name: string;
  available(): boolean;
  list(): Promise<Session[]>;
}

/**
 * Adapts an existing harness parser to the session-oriented public API.
 *
 * @param source - Native harness parser to group by session identifier.
 * @returns {SessionReader} A reader exposing normalized sessions.
 */
export function createSessionReader(source: Readonly<Source>): SessionReader {
  return {
    name: source.name,
    available: () => source.available(),
    async list(): Promise<Session[]> {
      const sessions = new Map<string, Message[]>();
      for await (const message of source.read()) {
        const messages = sessions.get(message.sessionId);
        if (messages) messages.push(message);
        else sessions.set(message.sessionId, [message]);
      }

      return [...sessions.entries()]
        .map(([id, messages]) => {
          messages.sort((left, right) => left.timestamp - right.timestamp);
          const opened = messages[0];
          return {
            id,
            source: source.name,
            createdAt: messages.reduce(
              (earliest, message) =>
                Math.min(earliest, message.sessionCreatedAt ?? message.timestamp),
              opened?.sessionCreatedAt ?? opened?.timestamp ?? 0,
            ),
            updatedAt: messages.reduce(
              (latest, message) => Math.max(latest, message.sessionUpdatedAt ?? message.timestamp),
              opened?.sessionUpdatedAt ?? opened?.timestamp ?? 0,
            ),
            messages,
          };
        })
        .sort(
          (left, right) =>
            right.updatedAt - left.updatedAt ||
            (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        );
    },
  };
}
