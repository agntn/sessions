import { describe, expect, it } from "vite-plus/test";
import type {
  Message,
  Source,
  SourceReadOptions,
  SourceSummaryWindow,
} from "../../src/core/types.ts";
import { listSourceSessions, readSourceSession } from "../../src/tool-reader.ts";

function message(
  sessionId: string,
  role: Message["role"],
  timestamp: number,
  text: string,
): Message {
  return {
    source: "fixture",
    sessionId,
    role,
    timestamp,
    date: "2026-01-01",
    blocks: [{ type: "text", text }],
  };
}

class FixtureSource implements Source {
  readonly name = "fixture";
  readonly messages: Message[] = [];
  readOptions: SourceReadOptions | undefined;

  available(): boolean {
    return true;
  }

  async *read(options?: SourceReadOptions): AsyncGenerator<Message> {
    this.readOptions = options;
    yield* this.messages;
  }
}

describe("tool session reader", () => {
  it("groups streamed messages into a bounded summary page", async () => {
    const source = new FixtureSource();
    source.messages.push(
      message("older", "assistant", 30, "fallback"),
      message("newer", "user", 40, "# AGENTS.md instructions for /tmp"),
      message("older", "user", 10, "actual question"),
      message("newer", "assistant", 50, "useful reply"),
    );

    const result = await listSourceSessions(source, 0, 1);

    expect(result).toEqual({
      total: 2,
      sessions: [
        {
          id: "newer",
          source: "fixture",
          createdAt: 40,
          updatedAt: 50,
          messageCount: 2,
          snippet: "useful reply",
        },
      ],
    });
  });

  it("uses a bounded native summary projection when available", async () => {
    const source = new FixtureSource() as FixtureSource & {
      summaryWindow(offset: number, limit: number): Promise<SourceSummaryWindow>;
    };
    source.summaryWindow = async (offset, limit) => {
      expect({ offset, limit }).toEqual({ offset: 20, limit: 10 });
      return {
        total: 30,
        sessions: [
          {
            id: "native",
            source: "fixture",
            createdAt: 1,
            updatedAt: 2,
            messageCount: 3,
            snippetText: `  compact\nthis ${"x".repeat(100)}`,
          },
        ],
      };
    };

    const result = await listSourceSessions(source, 20, 10);

    expect(result.total).toBe(30);
    expect(result.sessions[0]?.snippet).toHaveLength(80);
    expect(result.sessions[0]?.snippet?.startsWith("compact this")).toBe(true);
    expect(source.readOptions).toBeUndefined();
  });

  it("hands the listing directory and activity bound to the source", async () => {
    const source = new FixtureSource();
    source.messages.push({ ...message("here", "user", 5, "hi"), context: { cwd: "/work/app" } });

    const result = await listSourceSessions(source, 0, 10, { since: 1, cwd: "/work/app" });

    expect(source.readOptions).toEqual({ activeSince: 1, cwd: "/work/app" });
    expect(result.sessions.map((session) => session.id)).toEqual(["here"]);
  });

  it("excludes invalid timestamps only for filtered reads", async () => {
    const source = new FixtureSource();
    source.messages.push(
      message("wanted", "user", NaN, "invalid"),
      message("wanted", "user", Infinity, "infinite"),
      message("wanted", "user", 9e15, "outside Date"),
      message("wanted", "user", 2, "valid"),
    );
    expect((await readSourceSession(source, "wanted", 0, 10)).messages).toHaveLength(4);
    const filtered = await readSourceSession(source, "wanted", 0, 10, { since: 0 });
    expect(filtered.indices).toEqual([3]);
    expect(filtered.total).toBe(4);
  });

  it("keeps only the requested message window while counting the exact session", async () => {
    const source = new FixtureSource();
    source.messages.push(
      message("other", "user", 1, "ignore"),
      message("wanted", "user", 2, "first"),
      message("wanted", "assistant", 3, "second"),
      message("wanted", "assistant", 4, "third"),
    );

    const result = await readSourceSession(source, "wanted", 1, 1);

    expect(source.readOptions).toEqual({ sessionId: "wanted" });
    expect(result.total).toBe(3);
    expect(result.messages.map((item) => item.blocks[0]?.text)).toEqual(["second"]);
  });
});
