import { describe, expect, it } from "vite-plus/test";
import { createSessionReader } from "../../src/core/session.ts";
import type { Message, Source } from "../../src/core/types.ts";

const messages: Message[] = [
  {
    source: "fixture",
    sessionId: "second",
    role: "assistant",
    timestamp: 30,
    date: "2026-01-01",
    blocks: [{ type: "text", text: "later" }],
  },
  {
    source: "fixture",
    sessionId: "first",
    role: "assistant",
    timestamp: 20,
    date: "2026-01-01",
    blocks: [{ type: "text", text: "reply" }],
  },
  {
    source: "fixture",
    sessionId: "first",
    role: "user",
    timestamp: 10,
    date: "2026-01-01",
    blocks: [{ type: "text", text: "question" }],
  },
];

class FixtureSource implements Source {
  readonly name = "fixture";
  available(): boolean {
    return true;
  }
  async *read(): AsyncGenerator<Message> {
    yield* messages;
  }
}

describe("createSessionReader", () => {
  it("groups messages into newest-first sessions and orders messages chronologically", async () => {
    const sessions = await createSessionReader(new FixtureSource()).list();

    expect(sessions.map((session) => session.id)).toEqual(["second", "first"]);
    expect(sessions[1]).toMatchObject({ createdAt: 10, updatedAt: 20 });
    expect(sessions[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("orders equal-timestamp sessions by locale-independent code units", async () => {
    const tiedMessages: Message[] = ["ä", "z"].map((sessionId) => ({
      source: "fixture",
      sessionId,
      role: "user",
      timestamp: 10,
      date: "2026-01-01",
      blocks: [{ type: "text", text: sessionId }],
    }));
    const source = new FixtureSource();
    source.read = async function* () {
      yield* tiedMessages;
    };

    const sessions = await createSessionReader(source).list();

    expect(sessions.map((session) => session.id)).toEqual(["z", "ä"]);
  });
});
