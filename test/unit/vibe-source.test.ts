import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, SourceReadOptions } from "../../src/core/types.ts";
import { create } from "../../src/index.ts";
import { VibeSource } from "../../src/sources/vibe.ts";

type Entry = Readonly<Record<string, unknown>>;

interface Store {
  /** Entries pooled into chunks, one chunk per inner list. */
  readonly chunks?: readonly (readonly Entry[])[];
  /** Entries left inline in `projection-state.json`, as stores from before the pool have them. */
  readonly inline?: readonly Entry[];
  readonly journal?: readonly Entry[];
  /** Raw text appended to the journal after its records. */
  readonly tail?: string;
  readonly session?: Entry;
  readonly latestTurn?: Entry;
  readonly cwd?: string;
}

const GENERATION = "0000000000000007";
const SEGMENT = "journal/0000000000000008.jsonl";
const AT = Date.parse("2026-11-18T19:00:00Z");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sessions-vibe-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/* Chunk names only have to look like digests. The reader checks the shape, not the hash. */
function digest(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function writeStore(id: string, store: Store = {}): string {
  const dir = join(root, id);
  const generation = join(dir, "generations", GENERATION);
  mkdirSync(generation, { recursive: true });
  mkdirSync(join(dir, "chunks"));
  mkdirSync(join(dir, "journal"));
  const chunks = (store.chunks ?? []).map((entries, index) => {
    writeFileSync(join(dir, "chunks", `${digest(index)}.json`), JSON.stringify(entries));
    return digest(index);
  });
  const snapshot = {
    history: { entries: store.inline ?? [] },
    session: { id, parentSessionId: null, ...store.session },
    latestTurn: store.latestTurn ?? null,
  };
  writeFileSync(join(generation, "projection-state.json"), JSON.stringify({ snapshot }));
  writeFileSync(
    join(generation, "manifest.json"),
    JSON.stringify({
      projection_state: { path: "projection-state.json", chunks },
      recovery_journal_segment: { path: SEGMENT },
    }),
  );
  const lines = (store.journal ?? []).map((line) => `${JSON.stringify(line)}\n`).join("");
  writeFileSync(join(dir, SEGMENT), lines + (store.tail ?? ""));
  writeFileSync(join(dir, "CURRENT"), JSON.stringify({ generation: GENERATION, session_id: id }));
  if (store.cwd) {
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ environment: { working_directory: store.cwd } }),
    );
  }
  return dir;
}

function said(role: "user" | "assistant", text: string, createdAt = AT): Entry {
  return {
    type: "message",
    id: `${role}-${text}`,
    role,
    createdAt,
    content: [{ type: "text", text }],
  };
}

function effect(id: string, state: Entry, detail: Entry = {}): Entry {
  return {
    type: "effect",
    id: `effect-${id}`,
    toolCallId: id,
    createdAt: AT + 1,
    updatedAt: AT + 2,
    title: "file_system.bash",
    detail: { kind: "tool", toolName: "file_system.bash", input: { command: "ls" }, ...detail },
    state,
  };
}

function delta(...ops: readonly Entry[]): Entry {
  return { type: "projection_delta", payload: { delta: ops } };
}

async function collect(options?: SourceReadOptions): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const message of new VibeSource(root).read(options)) messages.push(message);
  return messages;
}

async function texts(options?: SourceReadOptions): Promise<(string | undefined)[]> {
  return (await collect(options)).map((message) => message.blocks[0]?.text);
}

describe("VibeSource", () => {
  it("reads pooled chunks in order without truncating text", async () => {
    const long = "x".repeat(9000);
    writeStore("pooled", {
      chunks: [[said("user", "first")], [said("assistant", long, AT + 5)]],
      cwd: "/work/project",
    });

    const messages = await collect();

    expect(messages.map((message) => message.blocks[0]?.text)).toEqual(["first", long]);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[0]).toMatchObject({
      source: "vibe",
      sessionId: "pooled",
      timestamp: AT,
      timestampSource: "message",
      date: "2026-11-18",
      context: { cwd: "/work/project" },
      channel: { platform: "cli", name: "vibe" },
    });
    expect(messages[0]?.author?.isBot).toBeUndefined();
    expect(messages[1]?.author).toEqual({ platform: "cli", name: "vibe", isBot: true });
  });

  it("reads a history the store kept inline", async () => {
    writeStore("inline", { inline: [said("user", "old"), said("assistant", "new")] });

    expect(await texts()).toEqual(["old", "new"]);
  });

  it("splits a tool effect into its call and its result", async () => {
    writeStore("tools", {
      chunks: [
        [
          { type: "reasoning", id: "r", createdAt: AT, text: "planning" },
          effect("call-1", { status: "completed", outputText: "printed" }),
        ],
      ],
    });

    const messages = await collect();

    expect(messages.map((message) => message.role)).toEqual(["assistant", "assistant", "tool"]);
    expect(messages.map((message) => message.timestamp)).toEqual([AT, AT + 1, AT + 2]);
    expect(messages.flatMap((message) => message.blocks)).toEqual([
      { type: "thinking", text: "planning" },
      {
        type: "tool_call",
        toolName: "file_system.bash",
        toolCallId: "call-1",
        toolInput: '{"command":"ls"}',
      },
      { type: "tool_result", toolCallId: "call-1", text: "printed", isError: false },
    ]);
  });

  it.each([
    [
      "a built-in tool's structured answer",
      {
        status: "completed",
        outputText: "",
        output: {
          _meta: { approval: { decision: "execute" } },
          content: [],
          structured_content: { stdout: "a.txt\n", returncode: 0 },
          type: "success",
        },
      },
      { text: '{"stdout":"a.txt\\n","returncode":0}', isError: false },
    ],
    [
      "an output without structured content",
      { status: "completed", outputText: "", output: { _meta: {}, mode: "details", toolCount: 1 } },
      { text: '{"mode":"details","toolCount":1}', isError: false },
    ],
    [
      "a failure",
      {
        status: "failed",
        error: { code: "tool_failed", message: "File not found" },
        outputText: "",
        output: { type: "failure" },
      },
      { text: "File not found", isError: true },
    ],
    [
      "a cancelled call",
      { status: "cancelled", reason: "client interrupt", outputText: "" },
      { text: "client interrupt", isError: true },
    ],
    [
      "a skipped call",
      { status: "skipped", reason: "hook said no" },
      { text: "hook said no", isError: true },
    ],
  ])("reads %s as the tool result", async (_, state, expected) => {
    writeStore("results", { chunks: [[effect("call-1", state)]] });

    const result = (await collect()).at(-1);

    expect(result?.role).toBe("tool");
    expect(result?.blocks).toEqual([{ type: "tool_result", toolCallId: "call-1", ...expected }]);
  });

  it("leaves a running effect as a call without a result", async () => {
    writeStore("running", {
      chunks: [[effect("call-1", { status: "running", outputText: "" })]],
    });

    const messages = await collect();

    expect(messages.map((message) => message.blocks[0]?.type)).toEqual(["tool_call"]);
  });

  it("replays the journal over the published generation", async () => {
    const open = effect("call-1", { status: "running", outputText: "" });
    const closed = effect("call-1", { status: "completed", outputText: "done" });
    writeStore("journal", {
      chunks: [[said("user", "published"), said("assistant", "dropped")]],
      journal: [
        { type: "core_input", payload: { input: { command: { content: "ignored" } } } },
        delta({ op: "remove_entry", id: "assistant-dropped" }, { op: "append_entry", entry: open }),
        delta({ op: "replace_entry", id: "effect-call-1", entry: closed }),
        delta({ op: "replace_entry", id: "absent", entry: said("assistant", "never") }),
        {
          type: "session_relocated",
          payload: { delta: [{ op: "append_entry", entry: said("assistant", "moved") }] },
        },
      ],
      tail: '{"type":"projection_delta","payload":{"delta":[{"op":"append_entry","entry":{"type":"mess',
    });

    const messages = await collect();

    expect(messages.map((message) => message.blocks[0]?.type)).toEqual([
      "text",
      "tool_call",
      "tool_result",
      "text",
    ]);
    expect(messages[2]?.blocks[0]?.text).toBe("done");
    expect(messages[3]?.blocks[0]?.text).toBe("moved");
  });

  it("replaces the first entry with an id and keeps a later twin", async () => {
    const twin = said("user", "twin");
    writeStore("twins", {
      inline: [said("user", "inline")],
      chunks: [[twin], [twin, said("assistant", "gone"), said("assistant", "temp")]],
      journal: [
        delta({ op: "append_entry", entry: twin }),
        delta({ op: "replace_entry", id: "user-twin", entry: said("user", "first") }),
        delta({ op: "replace_entry", id: "user-inline", entry: said("user", "swapped") }),
        delta({ op: "remove_entry", id: "assistant-gone" }),
        delta({ op: "append_entry", entry: said("assistant", "gone") }),
        delta({ op: "replace_entry", id: "assistant-gone", entry: said("assistant", "back") }),
        delta({ op: "replace_entry", id: "assistant-temp", entry: said("assistant", "edited") }),
        delta({ op: "remove_entry", id: "assistant-temp" }),
        delta({ op: "append_entry", entry: said("assistant", "temp") }),
      ],
    });

    expect(await texts()).toEqual(["swapped", "first", "twin", "twin", "back", "temp"]);
  });

  it("reads a chunk only when the read gets to it", async () => {
    const dir = writeStore("lazy", {
      chunks: [[said("user", "first")], [said("assistant", "written early")]],
    });
    const seen: (string | undefined)[] = [];

    for await (const message of new VibeSource(root).read()) {
      seen.push(message.blocks[0]?.text);
      const late = JSON.stringify([said("user", "late")]);
      writeFileSync(join(dir, "chunks", `${digest(1)}.json`), late);
    }

    expect(seen).toEqual(["first", "late"]);
  });

  it("refuses a store with a missing chunk and stops at one that won't parse", async () => {
    const holed = writeStore("holed", { chunks: [[said("user", "a")], [said("user", "b")]] });
    rmSync(join(holed, "chunks", `${digest(1)}.json`));
    const cut = writeStore("cut", { chunks: [[said("user", "kept")], [said("user", "lost")]] });
    writeFileSync(join(cut, "chunks", `${digest(1)}.json`), "[{");
    writeStore("whole", { chunks: [[said("user", "whole")]] });

    const read = await texts();

    expect(read).toHaveLength(2);
    expect(read).toEqual(expect.arrayContaining(["kept", "whole"]));
  });

  it("takes whole histories from set_history_entries and projection_advanced", async () => {
    writeStore("rewritten", {
      chunks: [[said("user", "before")]],
      journal: [
        delta({ op: "set_history_entries", entries: [said("user", "rewritten")] }),
        {
          type: "projection_advanced",
          payload: { snapshot: { history: { entries: [said("user", "advanced")] } } },
        },
        delta({ op: "append_entry", entry: said("assistant", "after") }),
      ],
    });

    expect(await texts()).toEqual(["advanced", "after"]);
  });

  it.each([
    [{ status: "interrupted", reason: "client interrupt" }, "interrupted", "client interrupt"],
    [{ status: "failed", error: { message: "Connection error." } }, "failed", "Connection error."],
    [{ status: "completed", stopReason: "limit" }, "limit", undefined],
  ])("ends a session on a stop block for %j", async (turn, stopReason, text) => {
    writeStore("stopped", {
      chunks: [[said("user", "go")]],
      journal: [
        delta({
          op: "set_envelope",
          state: { session: { id: "stopped" }, latestTurn: { ...turn, completedAt: AT + 9 } },
        }),
      ],
    });

    const last = (await collect()).at(-1);

    expect(last?.role).toBe("assistant");
    expect(last?.timestamp).toBe(AT + 9);
    expect(last?.blocks).toEqual([
      { type: "stop", stopReason, ...(text === undefined ? {} : { text }) },
    ]);
  });

  it.each([[{ status: "completed", stopReason: null }], [{ status: "in_progress" }]])(
    "adds no stop block for %j",
    async (latestTurn) => {
      writeStore("fine", { chunks: [[said("user", "go")]], latestTurn });

      expect((await collect()).map((message) => message.blocks[0]?.type)).toEqual(["text"]);
    },
  );

  it("flags text Vibe discarded with its cause", async () => {
    writeStore("discarded", {
      chunks: [
        [
          {
            type: "reasoning",
            id: "r",
            createdAt: AT,
            text: "The user wants",
            outcome: { type: "discarded", cause: "interrupt" },
          },
          { ...said("assistant", "kept"), outcome: { type: "committed" } },
        ],
      ],
    });

    const messages = await collect();

    expect(messages[0]?.context).toEqual({ discarded: "interrupt" });
    expect(messages[1]?.context).toBeUndefined();
  });

  it("links a subagent run to its parent in both directions", async () => {
    writeStore("parent", {
      chunks: [
        [
          effect(
            "spawn-1",
            { status: "completed", outputText: "" },
            { kind: "subagent", toolName: "agents.spawn", childSessionId: "child-1" },
          ),
        ],
      ],
    });
    writeStore("child-1", {
      chunks: [[said("user", "task")]],
      session: { parentSessionId: "parent" },
    });

    const parent = await collect({ sessionId: "parent" });
    const child = await collect({ sessionId: "child-1" });

    expect(parent[0]?.context).toEqual({ childSessionId: "child-1" });
    expect(child[0]?.context).toEqual({ parentSessionId: "parent" });
    expect(child[0]?.author?.isBot).toBe(true);
  });

  it("reads attached resources and names images without their bytes", async () => {
    writeStore("parts", {
      chunks: [
        [
          {
            type: "message",
            id: "m",
            role: "user",
            createdAt: AT,
            content: [
              { type: "text", text: "see" },
              { type: "resource", resource: { kind: "text", uri: "file:///n.txt", text: "alpha" } },
              {
                type: "image",
                attachment: { source: { kind: "inline", data: "AAAA" }, mimeType: "image/png" },
              },
            ],
          },
        ],
      ],
    });

    const [message] = await collect();

    expect(message?.blocks.map((block) => block.text)).toEqual([
      "see",
      "file:///n.txt\nalpha",
      "[image image/png]",
    ]);
  });

  it.each([[undefined], [8.64e15 + 1], ["2026-11-18"]])(
    "falls back to the store's last write for a createdAt of %j",
    async (createdAt) => {
      const content = [{ type: "text", text: "x" }];
      const dir = writeStore("untimed", {
        chunks: [[{ type: "message", id: "m", role: "user", createdAt, content }]],
      });
      const written = new Date("2026-11-01T00:00:00Z");
      utimesSync(join(dir, "CURRENT"), written, written);
      utimesSync(join(dir, SEGMENT), written, written);

      const [message] = await collect();

      expect(message?.timestamp).toBe(written.getTime());
      expect(message?.timestampSource).toBe("file");
      expect(message?.date).toBe("2026-11-01");
    },
  );

  it("opens only the session it was asked for and never leaves the store", async () => {
    writeStore("wanted", { chunks: [[said("user", "wanted")]] });
    writeStore("other", { chunks: [[said("user", "other")]] });

    expect(await texts({ sessionId: "wanted" })).toEqual(["wanted"]);
    expect(await collect({ sessionId: "../wanted" })).toEqual([]);
    expect(await collect({ sessionId: "missing" })).toEqual([]);
  });

  it("skips a store it can't follow and keeps reading the rest", async () => {
    writeStore("good", { chunks: [[said("user", "good")]] });
    const torn = writeStore("torn", { chunks: [[said("user", "torn")]] });
    writeFileSync(join(torn, "CURRENT"), "{");
    mkdirSync(join(root, "no-pointer"));
    writeFileSync(join(root, ".session-index.json"), "{}");

    expect(await texts()).toEqual(["good"]);
  });

  it.each([
    [{ path: "../../../outside.json", chunks: [] }],
    [{ path: "projection-state.json", chunks: ["../../outside"] }],
  ])("refuses a manifest that points outside its session: %j", async (projection) => {
    const leaked = [said("user", "leaked")];
    writeFileSync(
      join(root, "outside.json"),
      JSON.stringify(
        projection.chunks.length > 0 ? leaked : { snapshot: { history: { entries: leaked } } },
      ),
    );
    const dir = writeStore("escaped", { chunks: [[said("user", "inside")]] });
    writeFileSync(
      join(dir, "generations", GENERATION, "manifest.json"),
      JSON.stringify({
        projection_state: projection,
        recovery_journal_segment: { path: SEGMENT },
      }),
    );

    expect(await collect()).toEqual([]);
  });

  it("drops a session whose pointer and journal were both written before activeSince", async () => {
    const since = Date.parse("2026-11-10T00:00:00Z");
    const old = new Date(since - 1000);
    const idle = writeStore("idle", { chunks: [[said("user", "idle")]] });
    const live = writeStore("live", { chunks: [[said("user", "live")]] });
    for (const dir of [idle, live]) utimesSync(join(dir, "CURRENT"), old, old);
    utimesSync(join(idle, SEGMENT), old, old);

    expect(await texts({ activeSince: since })).toEqual(["live"]);
  });

  it("reads $VIBE_HOME/logs/session/unified when no path is passed", async () => {
    vi.stubEnv("VIBE_HOME", root);
    expect(create("vibe").available()).toBe(false);
    const home = root;
    root = join(home, "logs", "session", "unified");
    writeStore("home-id", { chunks: [[said("user", "from home")]] });
    root = home;

    const sessions = await create("vibe").list();

    expect(sessions.map((session) => session.id)).toEqual(["home-id"]);
    expect(sessions[0]?.messages[0]?.blocks[0]?.text).toBe("from home");
  });
});
