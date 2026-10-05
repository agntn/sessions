import { createReadStream, existsSync, read, readdirSync, readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { home, osUser } from "../core/env.ts";
import type {
  Block,
  Channel,
  Message,
  Participant,
  Source,
  SourceReadOptions,
} from "../core/types.ts";
import { isRecord, parseJson, parseJsonRecord, scalarText } from "./parsing.ts";

interface Transcript {
  readonly directory: string;
  readonly path: string;
  readonly mtime: number;
}

interface SessionClock {
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly source: "session" | "file";
}

type Entry = Readonly<Record<string, unknown>>;
type Time = Readonly<Pick<Message, "timestamp" | "timestampSource">>;

interface RunPick {
  readonly index: number;
  readonly kind: ChunkKind;
  readonly text: string;
  readonly found: number;
  readonly ceiling: number;
}

interface EntryKey {
  readonly kind?: ChunkKind;
  readonly text: string;
  readonly anchor?: number;
}

type ChunkKind = "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";

interface ChunkRun {
  readonly text: string;
  readonly at: number;
}

interface ToolTimes {
  readonly first: number;
  last: number;
}

/** Kind, tool call id and write time all sit in the first few hundred bytes of an update. */
const HEAD_BYTES = 1024;
/** A longer update line keeps only its ends: a chunk that size dates nothing, a tool still does. */
const LINE_HEAD = 1 << 16;
/** `_meta` closes every update, a few hundred bytes from its end. */
const LINE_TAIL = 4096;
/** Only a prefix is kept per chunk run, so a pasted prompt isn't held in memory twice. */
const RUN_PREFIX = 200;
const QUERY_OPEN = "<user_query>\n";
const META_KEY = '"_meta":';
const UPDATE_KIND = /"sessionUpdate":"([a-z_]+)"/u;
const TOOL_CALL_ID = /"toolCallId":"([^"]+)"/u;
const AGENT_MS = /"agentTimestampMs":(\d+)/u;
const WRITE_SECONDS = /"timestamp":(\d+)/u;
const CHUNK_KINDS: readonly string[] = [
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
];

function defaultSessionsDir(): string {
  const override = process.env.GROK_HOME?.trim();
  return join(override || join(home(), ".grok"), "sessions");
}

/**
 * Session id is the directory name on the running platform.
 * @param directory - Native session directory.
 * @returns {string} The session id.
 */
export function sessionIdFromDirectory(directory: string): string {
  return basename(directory);
}

function isSessionSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("\0") &&
    !value.includes("/") &&
    !value.includes(sep)
  );
}

function epoch(value: unknown): number | undefined {
  const text = scalarText(value);
  if (!text) return undefined;
  const parsed = new Date(text).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readSummary(directory: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed = parseJson(readFileSync(join(directory, "summary.json"), "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readClock(directory: string, mtime: number): SessionClock {
  const fileClock: SessionClock = { createdAt: mtime, updatedAt: mtime, source: "file" };
  const summary = readSummary(directory);
  if (!summary) return fileClock;
  const updated = epoch(summary.last_active_at) ?? epoch(summary.updated_at);
  const createdAt = epoch(summary.created_at) ?? updated;
  if (createdAt === undefined) return fileClock;
  return { createdAt, updatedAt: Math.max(createdAt, updated ?? createdAt), source: "session" };
}

function timestampAt(
  clock: SessionClock,
  isLast: boolean,
): Pick<Message, "timestamp" | "timestampSource"> {
  const timestamp = clock.source === "file" || isLast ? clock.updatedAt : clock.createdAt;
  return { timestamp, timestampSource: clock.source };
}

function textBlocks(value: unknown): Block[] {
  return typeof value === "string" && value.length > 0 ? [{ type: "text", text: value }] : [];
}

function userBlocks(content: unknown): Block[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== "text") return [];
    const text = scalarText(block.text);
    return text ? [{ type: "text" as const, text }] : [];
  });
}

function assistantToolCalls(value: unknown): Block[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((call) => {
    if (!isRecord(call)) return [];
    const toolInput =
      typeof call.arguments === "string"
        ? call.arguments
        : (JSON.stringify(call.arguments ?? "") ?? "");
    return [
      {
        type: "tool_call" as const,
        toolName: scalarText(call.name) ?? "",
        toolCallId: scalarText(call.id) ?? "",
        toolInput,
      },
    ];
  });
}

function imageUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((image) => {
    if (!isRecord(image)) return [];
    const url = scalarText(image.url);
    return url ? [url] : [];
  });
}

function toolResultBlocks(entry: Readonly<Record<string, unknown>>): Block[] {
  const content = typeof entry.content === "string" ? entry.content : "";
  const images = imageUrls(entry.images);
  return [
    {
      type: "tool_result",
      toolCallId: scalarText(entry.tool_call_id) ?? "",
      text: (content.length > 0 ? [content, ...images] : images).join("\n"),
    },
  ];
}

function reasoningBlocks(entry: Readonly<Record<string, unknown>>): Block[] {
  if (!Array.isArray(entry.summary)) return [];
  return entry.summary.flatMap((item) => {
    if (!isRecord(item)) return [];
    const text = scalarText(item.text);
    return text ? [{ type: "thinking" as const, text }] : [];
  });
}

function backendInput(kind: Readonly<Record<string, unknown>>): string {
  if (typeof kind.input === "string") return kind.input;
  if (isRecord(kind.action)) return JSON.stringify(kind.action);
  if (kind.input === undefined) return "";
  return JSON.stringify(kind.input) ?? "";
}

function backendToolCall(value: unknown): Block[] {
  if (!isRecord(value)) return [];
  return [
    {
      type: "tool_call",
      toolName: scalarText(value.name) ?? scalarText(value.tool_type) ?? "",
      toolCallId: scalarText(value.id) ?? scalarText(value.call_id) ?? "",
      toolInput: backendInput(value),
    },
  ];
}

function blocksFor(entry: Readonly<Record<string, unknown>>): Block[] {
  switch (entry.type) {
    case "user":
      return userBlocks(entry.content);
    case "assistant":
      return [...textBlocks(entry.content), ...assistantToolCalls(entry.tool_calls)];
    case "reasoning":
      return reasoningBlocks(entry);
    case "tool_result":
      return toolResultBlocks(entry);
    case "backend_tool_call":
      return backendToolCall(entry.kind);
    default:
      return [];
  }
}

function roleFor(type: unknown): Message["role"] | undefined {
  if (type === "user") return "user";
  if (type === "tool_result") return "tool";
  if (type === "assistant" || type === "reasoning" || type === "backend_tool_call") {
    return "assistant";
  }
  return undefined;
}

/**
 * A copy, not a slice: V8 keeps a sliced string's whole parent alive.
 *
 * @param text - Chunk or entry text.
 * @returns {string} Its first `RUN_PREFIX` characters as a string of their own.
 */
function prefixOf(text: string): string {
  return Array.from(text.slice(0, RUN_PREFIX)).join("");
}

interface TrieNode {
  readonly next: Map<string, TrieNode>;
  readonly ends: number[];
}

function newNode(): TrieNode {
  return { next: new Map(), ends: [] };
}

function isChunkKind(kind: string): kind is ChunkKind {
  return CHUNK_KINDS.includes(kind);
}

function datable(ms: number): number | undefined {
  return Number.isFinite(new Date(ms).getTime()) ? ms : undefined;
}

function updateTime(head: string, meta: string): number | undefined {
  const agentMs = AGENT_MS.exec(meta)?.[1];
  const agentTime = agentMs === undefined ? undefined : datable(Number(agentMs));
  if (agentTime !== undefined) return agentTime;
  const seconds = WRITE_SECONDS.exec(head)?.[1];
  return seconds === undefined ? undefined : datable(Number(seconds) * 1000);
}

function chunkText(line: string): string {
  const params = parseJsonRecord(line)?.params;
  const update = isRecord(params) ? params.update : undefined;
  const content = isRecord(update) ? update.content : undefined;
  return isRecord(content) ? (scalarText(content.text) ?? "") : "";
}

function queryText(content: unknown): string {
  const text = userBlocks(content)
    .map((block) => block.text ?? "")
    .join("");
  return text.startsWith(QUERY_OPEN) ? text.slice(QUERY_OPEN.length) : text;
}

function chunkRunFor(
  entry: Readonly<Record<string, unknown>>,
): Readonly<{ kind: ChunkKind; text: string }> | undefined {
  switch (entry.type) {
    case "user":
      return entry.synthetic_reason === undefined
        ? { kind: "user_message_chunk", text: queryText(entry.content) }
        : undefined;
    case "assistant":
      return typeof entry.content === "string"
        ? { kind: "agent_message_chunk", text: entry.content }
        : undefined;
    case "reasoning":
      return {
        kind: "agent_thought_chunk",
        text: reasoningBlocks(entry)
          .map((block) => block.text ?? "")
          .join(""),
      };
    default:
      return undefined;
  }
}

/** What a line keeps: its start, its end, and whether the start is all of it. */
interface LineView {
  readonly head: Buffer;
  readonly tail: Buffer;
  readonly whole: boolean;
}

/** Keeps at most `LINE_HEAD` bytes from the start of a line and `LINE_TAIL` from its end. */
class LineSplitter {
  /** The read chunk `drain()` works through next. */
  chunk: Buffer = Buffer.alloc(0);
  private head: Buffer[] = [];
  private headSize = 0;
  private tail: Buffer = Buffer.alloc(0);
  private size = 0;

  /**
   * Splits the current chunk and hands back the lines it finished.
   *
   * @returns {LineView[]} Lines that ended inside this chunk.
   */
  drain(): LineView[] {
    const done: LineView[] = [];
    let start = 0;
    for (let end = this.chunk.indexOf(10); end !== -1; end = this.chunk.indexOf(10, start)) {
      if (this.size === 0) done.push(this.view(start, end));
      else {
        this.take(start, end);
        done.push(this.finish());
      }
      start = end + 1;
    }
    if (start < this.chunk.length) this.take(start, this.chunk.length);
    return done;
  }

  /**
   * Finishes the last line when the file doesn't end with a newline.
   *
   * @returns {LineView[]} The last line, if any bytes are left.
   */
  end(): LineView[] {
    return this.size > 0 ? [this.finish()] : [];
  }

  /**
   * A line inside one chunk needs no copy: the caller decodes it before the next read.
   *
   * @param start - First byte of the line in the chunk.
   * @param end - Byte offset of its newline.
   * @returns {LineView} Views into the chunk.
   */
  private view(start: number, end: number): LineView {
    return {
      head: this.chunk.subarray(start, Math.min(end, start + LINE_HEAD)),
      tail: this.chunk.subarray(Math.max(start, end - LINE_TAIL), end),
      whole: end - start <= LINE_HEAD,
    };
  }

  private take(start: number, end: number): void {
    if (this.headSize < LINE_HEAD) {
      const stop = Math.min(end, start + LINE_HEAD - this.headSize);
      this.head.push(Buffer.from(this.chunk.subarray(start, stop)));
      this.headSize += stop - start;
    }
    const from = Math.max(start, end - LINE_TAIL);
    const joined = Buffer.concat([this.tail, this.chunk.subarray(from, end)]);
    this.tail = Buffer.from(joined.subarray(Math.max(0, joined.length - LINE_TAIL)));
    this.size += end - start;
  }

  private finish(): LineView {
    const line = { head: Buffer.concat(this.head), tail: this.tail, whole: this.size <= LINE_HEAD };
    this.head = [];
    this.headSize = 0;
    this.tail = Buffer.alloc(0);
    this.size = 0;
    return line;
  }
}

/**
 * Splits on bytes and keeps only the ends of a long line, so a megabyte of tool output is never
 * held or decoded just to find its id.
 *
 * @param path - JSONL file to read.
 * @yields {LineView} One line, cut down to its ends when it's long.
 */
async function* lineViews(path: string): AsyncGenerator<LineView> {
  const input = createReadStream(path, { highWaterMark: 1 << 20 });
  const chunks: AsyncIterable<Buffer> = input;
  const splitter = new LineSplitter();
  try {
    for await (const chunk of chunks) {
      splitter.chunk = chunk;
      yield* splitter.drain();
    }
    yield* splitter.end();
  } finally {
    input.destroy();
  }
}

/** Dates chat entries from `updates.jsonl`: tool calls by id, text by the chunk opening its run. */
class MessageTimes {
  private readonly tools = new Map<string, ToolTimes>();
  private readonly runs: Record<ChunkKind, ChunkRun[]> = {
    user_message_chunk: [],
    agent_message_chunk: [],
    agent_thought_chunk: [],
  };
  private previousKind: string | undefined;
  private runCount = 0;
  private readonly unclaimed: Record<ChunkKind, TrieNode> = {
    user_message_chunk: newNode(),
    agent_message_chunk: newNode(),
    agent_thought_chunk: newNode(),
  };
  private known: number | undefined;

  /**
   * A missing or unreadable file leaves every message on the session clock, as before.
   *
   * @param directory - Native session directory.
   * @returns {Promise<MessageTimes>} Times found in the file, or none.
   */
  static async read(directory: string): Promise<MessageTimes> {
    const path = join(directory, "updates.jsonl");
    if (!existsSync(path)) return new MessageTimes();
    try {
      return await MessageTimes.scan(path);
    } catch {
      return new MessageTimes();
    }
  }

  private static async scan(path: string): Promise<MessageTimes> {
    const times = new MessageTimes();
    for await (const line of lineViews(path)) {
      const head = line.head.toString("utf8", 0, HEAD_BYTES);
      const kind = UPDATE_KIND.exec(head)?.[1];
      if (kind === undefined) continue;
      const metaAt = line.tail.lastIndexOf(META_KEY);
      const at = updateTime(head, metaAt === -1 ? "" : line.tail.toString("utf8", metaAt));
      const opensRun = isChunkKind(kind) && kind !== times.previousKind;
      times.add(kind, head, at, opensRun && line.whole ? line.head.toString("utf8") : undefined);
    }
    return times;
  }

  /**
   * Matches the whole transcript backwards from tool anchors. Each entry leaves a short key, never
   * its payload.
   *
   * @param file - The session's `chat_history.jsonl`, opened once for both passes.
   * @returns {Promise<(number | undefined)[]>} One time per visible entry, empty without runs.
   */
  async dateTranscript(file: Snapshot): Promise<(number | undefined)[]> {
    const keys: EntryKey[] = [];
    if (this.runCount === 0 && this.tools.size === 0) return [];
    for await (const entry of records(file)) keys.push(this.keyOf(entry));
    return this.matchKeys(keys);
  }

  private matchKeys(keys: readonly EntryKey[]): (number | undefined)[] {
    const picks: RunPick[] = [];
    const ceilings: Record<ChunkKind, number> = {
      user_message_chunk: this.runs.user_message_chunk.length - 1,
      agent_message_chunk: this.runs.agent_message_chunk.length - 1,
      agent_thought_chunk: this.runs.agent_thought_chunk.length - 1,
    };
    let upper = Number.POSITIVE_INFINITY;
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      upper = key?.anchor ?? upper;
      if (key?.kind === undefined) continue;
      const ceiling = this.ceiling(key.kind, upper, ceilings);
      const found = this.lastMatch(key.kind, key.text, ceiling);
      if (found === -1) continue;
      picks.push({ index, kind: key.kind, text: key.text, found, ceiling });
      ceilings[key.kind] = found - 1;
    }
    return this.settlePicks(keys, picks);
  }

  /**
   * A pick stays only when no run left unclaimed in its reach says the same thing, rechecked until
   * nothing changes. Grok logs no rewind, so such runs can't be told apart.
   *
   * @param keys - One key per visible entry.
   * @param picks - Matches found walking backwards.
   * @returns {(number | undefined)[]} One time per entry.
   */
  private settlePicks(
    keys: readonly EntryKey[],
    picks: readonly RunPick[],
  ): (number | undefined)[] {
    let kept = picks;
    for (let size = -1; size !== kept.length;) {
      size = kept.length;
      this.indexUnclaimed(kept);
      kept = kept.filter((pick) => !this.hasTwin(pick));
    }
    const said = keys.map((key) => key.anchor);
    for (const pick of kept) said[pick.index] = this.runs[pick.kind][pick.found]?.at;
    return said;
  }

  /**
   * Builds a prefix tree of the runs no pick claims, so a pick finds its twins in one walk.
   *
   * @param picks - Picks still standing.
   */
  private indexUnclaimed(picks: readonly RunPick[]): void {
    const claimed = Object.fromEntries(picks.map((pick) => [`${pick.kind}:${pick.found}`, true]));
    for (const kind of CHUNK_KINDS) {
      if (!isChunkKind(kind)) continue;
      this.unclaimed[kind] = newNode();
      for (const [index, run] of this.runs[kind].entries()) {
        if (!Object.hasOwn(claimed, `${kind}:${index}`)) this.insertRun(kind, run.text, index);
      }
    }
  }

  /**
   * Adds a run to its kind's tree, one code point per level, the same way `hasTwin` walks it.
   *
   * @param kind - Chunk kind.
   * @param text - Run prefix.
   * @param index - Run index, called in rising order.
   */
  private insertRun(kind: ChunkKind, text: string, index: number): void {
    let node = this.unclaimed[kind];
    for (const unit of text) {
      let child = node.next.get(unit);
      if (child === undefined) {
        child = newNode();
        node.next.set(unit, child);
      }
      node = child;
    }
    node.ends.push(index);
  }

  /**
   * Indexes go in rising order, so the first run ending at a node is the earliest one there.
   *
   * @param pick - A match found walking backwards.
   * @returns {boolean} Whether an unclaimed run in its reach says the same thing.
   */
  private hasTwin(pick: RunPick): boolean {
    let node: TrieNode | undefined = this.unclaimed[pick.kind];
    for (const unit of pick.text) {
      node = node?.next.get(unit);
      if (node === undefined) return false;
      const first = node.ends[0];
      if (first !== undefined && first <= pick.ceiling) return true;
    }
    return false;
  }

  private add(kind: string, head: string, at: number | undefined, run: string | undefined): void {
    this.previousKind = kind;
    if (at === undefined) return;
    if (kind === "tool_call" || kind === "tool_call_update") this.addTool(head, at);
    else if (run !== undefined && isChunkKind(kind)) this.addRun(kind, chunkText(run), at);
  }

  private addTool(head: string, at: number): void {
    const id = TOOL_CALL_ID.exec(head)?.[1];
    if (id === undefined) return;
    const times = this.tools.get(id);
    if (times) times.last = Math.max(times.last, at);
    else this.tools.set(id, { first: at, last: at });
  }

  private addRun(kind: ChunkKind, text: string, at: number): void {
    if (text.length === 0) return;
    this.runs[kind].push({ text: prefixOf(text), at });
    this.runCount += 1;
  }

  private toolTime(id: string | undefined, edge: "first" | "last"): number | undefined {
    return id === undefined ? undefined : this.tools.get(id)?.[edge];
  }

  /**
   * An unmatched entry stays inferred but borrows the last known time, so sorting keeps it put.
   *
   * @param at - Time the updates gave this entry, if any.
   * @param clock - Session clock for entries the updates don't date.
   * @param isLast - Whether this is the last entry of the transcript.
   * @returns {Time} The time and where it came from.
   */
  settle(at: number | undefined, clock: SessionClock, isLast: boolean): Time {
    if (at !== undefined) {
      this.known = at;
      return { timestamp: at, timestampSource: "message" };
    }
    const inferred = timestampAt(clock, isLast);
    return isLast || this.known === undefined ? inferred : { ...inferred, timestamp: this.known };
  }

  private keyOf(entry: Entry): EntryKey {
    const run = chunkRunFor(entry);
    const anchor = this.anchorOf(entry);
    return run === undefined
      ? { text: "", anchor }
      : { kind: run.kind, text: prefixOf(run.text), anchor };
  }

  private anchorOf(entry: Entry): number | undefined {
    if (entry.type === "tool_result") return this.toolTime(scalarText(entry.tool_call_id), "last");
    const call = blocksFor(entry).find((block) => block.type === "tool_call");
    return this.toolTime(call?.toolCallId, "first");
  }

  private ceiling(
    kind: ChunkKind,
    upper: number,
    ceilings: Readonly<Record<ChunkKind, number>>,
  ): number {
    const runs = this.runs[kind];
    let index = ceilings[kind];
    while (index >= 0 && (runs[index]?.at ?? upper) > upper) index -= 1;
    return index;
  }

  private lastMatch(kind: ChunkKind, text: string, from: number): number {
    const runs = this.runs[kind];
    for (let index = from; index >= 0; index -= 1) {
      const run = runs[index];
      if (run !== undefined && text.startsWith(run.text)) return index;
    }
    return -1;
  }
}

function userContext(entry: Readonly<Record<string, unknown>>): Record<string, string> | undefined {
  const reason = scalarText(entry.synthetic_reason);
  return reason ? { syntheticReason: reason } : undefined;
}

function* transcriptAt(directory: string): Generator<Transcript> {
  const path = join(directory, "chat_history.jsonl");
  if (!existsSync(path)) return;
  yield { directory, path, mtime: statSync(path).mtimeMs };
}

function* transcripts(root: string, sessionId?: string): Generator<Transcript> {
  if (!existsSync(root)) return;
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectDir = join(root, project.name);
    if (sessionId) {
      yield* transcriptAt(join(projectDir, sessionId));
      continue;
    }
    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      yield* transcriptAt(join(projectDir, entry.name));
    }
  }
}

function isVisible(entry: Readonly<Record<string, unknown>>): boolean {
  return roleFor(entry.type) !== undefined && blocksFor(entry).length > 0;
}

/** One open transcript and the size it had then, so both passes read the same bytes. */
interface Snapshot {
  readonly fd: number;
  readonly size: number;
}

const readAt = promisify(read);

/**
 * Reads lines by position from an open file, so a second pass sees the same bytes as the first.
 *
 * @param file - Open transcript and its size when opened.
 * @yields {string} One line without its newline.
 */
async function* textLines(file: Snapshot): AsyncGenerator<string> {
  const chunk = Buffer.alloc(1 << 20);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for (let position = 0; position < file.size;) {
    const length = Math.min(chunk.length, file.size - position);
    const { bytesRead } = await readAt(file.fd, chunk, 0, length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    const lines = (pending + decoder.write(chunk.subarray(0, bytesRead))).split("\n");
    pending = lines.pop() ?? "";
    yield* lines;
  }
  pending += decoder.end();
  if (pending.length > 0) yield pending;
}

async function* records(file: Snapshot): AsyncGenerator<Readonly<Record<string, unknown>>> {
  for await (const line of textLines(file)) {
    const entry = parseJsonRecord(line);
    if (entry && isVisible(entry)) yield entry;
  }
}

/** Chat lines carry no clock, so `updates.jsonl` dates them and `summary.json` fills the gaps. */
export class GrokSource implements Source {
  readonly name = "grok";
  private readonly sessionsDir: string;
  private readonly channel: Channel = { platform: "cli", name: "grok" };
  private readonly user: Participant;

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir ?? defaultSessionsDir();
    this.user = { platform: "cli", name: osUser() };
  }

  available(): boolean {
    return existsSync(this.sessionsDir);
  }

  private messageFrom(
    entry: Readonly<Record<string, unknown>>,
    sessionId: string,
    clock: SessionClock,
    time: Time,
  ): Message | undefined {
    const role = roleFor(entry.type);
    const blocks = blocksFor(entry);
    if (!role || blocks.length === 0) return undefined;
    const context = role === "user" ? userContext(entry) : undefined;
    return {
      source: this.name,
      sessionId,
      role,
      timestamp: time.timestamp,
      timestampSource: time.timestampSource,
      ...(clock.source === "session"
        ? { sessionCreatedAt: clock.createdAt, sessionUpdatedAt: clock.updatedAt }
        : {}),
      date: new Date(time.timestamp).toISOString().split("T")[0],
      blocks,
      channel: this.channel,
      author: role === "user" ? this.user : { platform: "cli", name: "grok", isBot: true },
      ...(context ? { context } : {}),
    };
  }

  private async *readFile(file: Transcript): AsyncGenerator<Message> {
    const sessionId = sessionIdFromDirectory(file.directory);
    const clock = readClock(file.directory, file.mtime);
    const times = await MessageTimes.read(file.directory);
    const handle = await open(file.path);
    try {
      const snapshot = { fd: handle.fd, size: (await handle.stat()).size };
      const dates = await times.dateTranscript(snapshot);
      let index = 0;
      let pending: Entry | undefined;
      for await (const entry of records(snapshot)) {
        if (pending) {
          const time = times.settle(dates[index], clock, false);
          const message = this.messageFrom(pending, sessionId, clock, time);
          if (message) yield message;
          index += 1;
        }
        pending = entry;
      }
      if (!pending) return;
      const time = times.settle(dates[index], clock, true);
      const message = this.messageFrom(pending, sessionId, clock, time);
      if (message) yield message;
    } finally {
      await handle.close();
    }
  }

  async *read(options?: SourceReadOptions): AsyncGenerator<Message> {
    const requested = options?.sessionId || undefined;
    if (requested !== undefined && !isSessionSegment(requested)) return;
    const files = [...transcripts(this.sessionsDir, requested)].sort(
      (left, right) => left.mtime - right.mtime,
    );
    for (const file of files) yield* this.readFile(file);
  }
}
