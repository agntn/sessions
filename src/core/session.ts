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

function toSession(source: string, id: string, messages: Message[]): Session {
  messages.sort((left, right) => left.timestamp - right.timestamp);
  return {
    id,
    source,
    createdAt: messages[0]?.timestamp ?? 0,
    updatedAt: messages.at(-1)?.timestamp ?? 0,
    messages,
  };
}

/** Adapts an existing harness parser to the session-oriented public API. */
export function createSessionReader(source: Source): SessionReader {
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
        .map(([id, messages]) => toSession(source.name, id, messages))
        .sort(
          (left, right) =>
            right.updatedAt - left.updatedAt ||
            (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        );
    },
  };
}
