import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { createInterface } from "node:readline";
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

/**
 * Splits on bytes, so a megabyte of tool output is never decoded just to find its id.
 *
 * @param path - JSONL file to read.
 * @yields {Buffer} One line without its newline.
 */
async function* lineBuffers(path: string): AsyncGenerator<Buffer> {
  const input = createReadStream(path, { highWaterMark: 1 << 20 });
  const chunks: AsyncIterable<Buffer> = input;
  let pending: Buffer[] = [];
  try {
    for await (const chunk of chunks) {
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        const piece = chunk.subarray(start, end);
        yield pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
        pending = [];
        start = end + 1;
      }
      if (start < chunk.length) pending.push(chunk.subarray(start));
    }
    if (pending.length > 0) yield Buffer.concat(pending);
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
  private readonly cursors: Record<ChunkKind, number> = {
    user_message_chunk: 0,
    agent_message_chunk: 0,
    agent_thought_chunk: 0,
  };
  private previousKind: string | undefined;
  private runCount = 0;
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
    for await (const line of lineBuffers(path)) {
      const head = line.toString("utf8", 0, HEAD_BYTES);
      const kind = UPDATE_KIND.exec(head)?.[1];
      if (kind === undefined) continue;
      const metaAt = line.lastIndexOf(META_KEY);
      const at = updateTime(head, metaAt === -1 ? "" : line.toString("utf8", metaAt));
      const opensRun = isChunkKind(kind) && kind !== times.previousKind;
      times.add(kind, head, at, opensRun ? line.toString("utf8") : undefined);
    }
    return times;
  }

  /**
   * Text waits for the next tool anchor and matches backwards from it, so a run a rewind dropped
   * loses to the run the history kept.
   *
   * @param batch - Chat entries in file order, ending at a tool anchor or the transcript end.
   * @param clock - Session clock for entries the updates don't date.
   * @param endsTranscript - Whether the batch holds the last entry of the transcript.
   * @returns {Time[]} One time per entry.
   */
  date(batch: readonly Entry[], clock: SessionClock, endsTranscript: boolean): Time[] {
    const anchors = batch.map((entry) => this.anchorOf(entry));
    const upper = anchors.at(-1);
    const said = this.matchBackward(batch, upper ?? Number.POSITIVE_INFINITY);
    const lastIndex = endsTranscript ? batch.length - 1 : -1;
    return batch.map((_entry, index) =>
      this.settle(said[index] ?? anchors[index], clock, index === lastIndex),
    );
  }

  /**
   * A batch closes at a tool anchor, or after every entry when there are no runs to match.
   *
   * @param batch - Entries waiting to be dated.
   * @returns {boolean} Whether the batch is ready to date.
   */
  closes(batch: readonly Entry[]): boolean {
    const last = batch.at(-1);
    return last !== undefined && (this.runCount === 0 || this.anchorOf(last) !== undefined);
  }

  /**
   * Exact time from a tool call id, which a rewind can't repeat.
   *
   * @param entry - Chat history entry.
   * @returns {number | undefined} Completion time for a result, start time for a call.
   */
  anchorOf(entry: Entry): number | undefined {
    if (entry.type === "tool_result") return this.toolTime(scalarText(entry.tool_call_id), "last");
    const call = blocksFor(entry).find((block) => block.type === "tool_call");
    return this.toolTime(call?.toolCallId, "first");
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
    this.runs[kind].push({ text: text.slice(0, RUN_PREFIX), at });
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
  private settle(at: number | undefined, clock: SessionClock, isLast: boolean): Time {
    if (at !== undefined) {
      this.known = at;
      return { timestamp: at, timestampSource: "message" };
    }
    const inferred = timestampAt(clock, isLast);
    return isLast || this.known === undefined ? inferred : { ...inferred, timestamp: this.known };
  }

  private matchBackward(batch: readonly Entry[], upper: number): (number | undefined)[] {
    const ceilings: Record<ChunkKind, number> = {
      user_message_chunk: this.ceiling("user_message_chunk", upper),
      agent_message_chunk: this.ceiling("agent_message_chunk", upper),
      agent_thought_chunk: this.ceiling("agent_thought_chunk", upper),
    };
    const next = { ...this.cursors };
    const said = batch.map(() => undefined as number | undefined);
    for (let index = batch.length - 1; index >= 0; index -= 1) {
      const key = chunkRunFor(batch[index] ?? {});
      const found = key === undefined ? -1 : this.lastMatch(key.kind, key.text, ceilings[key.kind]);
      if (key === undefined || found === -1) continue;
      said[index] = this.runs[key.kind][found]?.at;
      ceilings[key.kind] = found - 1;
      next[key.kind] = Math.max(next[key.kind], found + 1);
    }
    Object.assign(this.cursors, next);
    return said;
  }

  private ceiling(kind: ChunkKind, upper: number): number {
    const runs = this.runs[kind];
    let index = runs.length - 1;
    while (index >= this.cursors[kind] && (runs[index]?.at ?? upper) > upper) index -= 1;
    return index;
  }

  private lastMatch(kind: ChunkKind, text: string, from: number): number {
    const runs = this.runs[kind];
    for (let index = from; index >= this.cursors[kind]; index -= 1) {
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

async function* records(path: string): AsyncGenerator<Readonly<Record<string, unknown>>> {
  const input = createReadStream(path);
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      const entry = parseJsonRecord(line);
      if (entry && isVisible(entry)) yield entry;
    }
  } finally {
    input.destroy();
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
    let batch: Entry[] = [];
    for await (const entry of records(file.path)) {
      if (times.closes(batch)) {
        yield* this.messagesFrom(batch, sessionId, clock, times.date(batch, clock, false));
        batch = [];
      }
      batch.push(entry);
    }
    yield* this.messagesFrom(batch, sessionId, clock, times.date(batch, clock, true));
  }

  private *messagesFrom(
    batch: readonly Entry[],
    sessionId: string,
    clock: SessionClock,
    times: readonly Time[],
  ): Generator<Message> {
    for (const [index, entry] of batch.entries()) {
      const time = times[index];
      const message = time && this.messageFrom(entry, sessionId, clock, time);
      if (message) yield message;
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
