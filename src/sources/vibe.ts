import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { home, osUser } from "../core/env.ts";
import type { Block, Message, Participant, Source, SourceReadOptions } from "../core/types.ts";
import { activeFiles } from "./activity.ts";
import { isRecord, jsonlLines, parseJson, parseJsonRecord, scalarText } from "./parsing.ts";

type Native = Readonly<Record<string, unknown>>;

interface SessionDir {
  readonly id: string;
  readonly path: string;
  readonly mtime: number;
}

/** One message to be, still without its session. */
interface Draft {
  readonly role: Message["role"];
  /** Native epoch milliseconds, when the entry carries them. */
  readonly at: unknown;
  readonly blocks: Block[];
  readonly context?: Readonly<Record<string, string>>;
}

/** Shapes of the names a store document may point at, so a damaged one can't leave the session. */
const NAMES = {
  generation: /^\d{16}$/u,
  chunk: /^[0-9a-f]{64}$/u,
  document: /^(?!\.+$)[\w.-]+$/u,
  segment: /^journal\/\d{16}\.jsonl$/u,
} as const;

/** Effect states that carry a result, with the error flag each one means. */
const SETTLED: Readonly<Record<string, boolean>> = {
  completed: false,
  failed: true,
  cancelled: true,
  skipped: true,
};

const BOT: Participant = { platform: "cli", name: "vibe", isBot: true };

function text(value: unknown): string | undefined {
  return scalarText(value) || undefined;
}

function record(value: unknown): Native {
  return isRecord(value) ? value : {};
}

function records(value: unknown): Native[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function named(value: unknown, kind: keyof typeof NAMES): string {
  const name = scalarText(value) ?? "";
  if (!NAMES[kind].test(name)) throw new TypeError(`Unexpected ${kind} name in a Vibe store`);
  return name;
}

function readRecord(path: string): Native {
  const parsed = parseJsonRecord(readFileSync(path, "utf8"));
  if (!parsed) throw new TypeError(`${path} is not a JSON object`);
  return parsed;
}

function defaultStoreDir(): string {
  const override = process.env.VIBE_HOME?.trim();
  return join(override || join(home(), ".vibe"), "logs", "session", "unified");
}

/** One session's store with its journal folded in. The chunks are still on disk. */
interface Store {
  readonly envelope: Native;
  /** The history in order, one chunk in memory at a time. A chunk that fails to read throws. */
  readonly entries: () => Generator<Native>;
}

/** Folds the recovery journal into what it changes, keeping no entry a later record replaced. */
class Replay {
  private state: Native;
  private tail: Native[] = [];
  private baseGone = false;
  private readonly replaced = new Map<unknown, Native>();
  private readonly removed = new Set<unknown>();

  constructor(snapshot: Native) {
    this.state = snapshot;
  }

  get envelope(): Native {
    return this.state;
  }

  private swapInTail(id: unknown, entry: Native): void {
    const index = this.tail.findIndex((kept) => kept.id === id);
    if (index !== -1) this.tail[index] = entry;
  }

  /**
   * A replace hits the first entry with that id, and published entries come first.
   * @param id - Native entry id.
   * @param entry - The entry that takes its place.
   */
  private replace(id: unknown, entry: Native): void {
    if (this.baseGone) this.swapInTail(id, entry);
    else this.replaced.set(id, entry);
  }

  private remove(id: unknown): void {
    this.removed.add(id);
    this.replaced.delete(id);
    this.tail = this.tail.filter((kept) => kept.id !== id);
  }

  private rewrite(entries: readonly Native[]): void {
    this.baseGone = true;
    this.replaced.clear();
    this.tail = [...entries];
  }

  private apply(op: Native): void {
    switch (op.op) {
      case "append_entry":
        if (isRecord(op.entry)) this.tail.push(op.entry);
        break;
      case "replace_entry":
        if (isRecord(op.entry)) this.replace(op.id, op.entry);
        break;
      case "remove_entry":
        this.remove(op.id);
        break;
      case "set_history_entries":
        this.rewrite(records(op.entries));
        break;
      case "set_envelope":
        this.state = record(op.state);
        break;
      default:
        break;
    }
  }

  /**
   * Folds one recovery journal record in. Only projection records touch the history.
   * @param entry - Parsed journal line.
   */
  fold(entry: Native): void {
    const payload = record(entry.payload);
    if (entry.type === "projection_advanced") {
      this.state = record(payload.snapshot);
      this.rewrite(records(record(this.state.history).entries));
    } else if (entry.type === "projection_delta" || entry.type === "session_relocated") {
      for (const op of records(payload.delta)) this.apply(op);
    }
  }

  private *published(inline: readonly Native[], chunks: readonly string[]): Generator<Native> {
    const swapped = new Set<unknown>();
    for (const entry of storedEntries(inline, chunks)) {
      if (this.removed.has(entry.id)) continue;
      const replacement = swapped.has(entry.id) ? undefined : this.replaced.get(entry.id);
      if (replacement) swapped.add(entry.id);
      yield replacement ?? entry;
    }
    for (const [id, entry] of this.replaced) if (!swapped.has(id)) this.swapInTail(id, entry);
  }

  /**
   * Streams the history the journal leaves over the published generation.
   * @param inline - Entries the generation keeps in its own document.
   * @param chunks - Paths of its pooled chunks, in order.
   * @yields {Native} Each surviving entry, then the ones the journal appended.
   */
  *entries(inline: readonly Native[], chunks: readonly string[]): Generator<Native> {
    if (!this.baseGone) yield* this.published(inline, chunks);
    yield* this.tail;
  }
}

function* storedEntries(inline: readonly Native[], chunks: readonly string[]): Generator<Native> {
  yield* inline;
  for (const path of chunks) yield* records(parseJson(readFileSync(path, "utf8")));
}

/**
 * A store missing a chunk is refused whole, before half of it reads as a session.
 * @param dir - Session directory.
 * @param chunks - Native chunk digests of the generation.
 * @returns {string[]} The chunk files, in order.
 */
function chunkPaths(dir: string, chunks: unknown): string[] {
  const digests: unknown[] = Array.isArray(chunks) ? chunks : [];
  const paths = digests.map((digest) => join(dir, "chunks", `${named(digest, "chunk")}.json`));
  const missing = paths.find((path) => !existsSync(path));
  if (missing) throw new TypeError(`${missing} is missing from a Vibe store`);
  return paths;
}

/**
 * Follows `CURRENT` to its generation and folds the journal written since.
 * @param dir - Session directory.
 * @returns {Promise<Store>} The store as of the last complete journal record.
 */
async function load(dir: string): Promise<Store> {
  const current = readRecord(join(dir, "CURRENT"));
  const generation = join(dir, "generations", named(current.generation, "generation"));
  const manifest = readRecord(join(generation, "manifest.json"));
  const stored = record(manifest.projection_state);
  const snapshot = record(readRecord(join(generation, named(stored.path, "document"))).snapshot);
  const chunks = chunkPaths(dir, stored.chunks);
  const replay = new Replay(snapshot);
  const segment = named(record(manifest.recovery_journal_segment).path, "segment");
  for await (const line of jsonlLines(join(dir, segment))) {
    const entry = parseJsonRecord(line);
    if (entry) replay.fold(entry);
  }
  const inline = records(record(snapshot.history).entries);
  return { envelope: replay.envelope, entries: () => replay.entries(inline, chunks) };
}

/**
 * One store that can't be followed is skipped, so it doesn't hide the sessions next to it.
 * @param dir - Session directory.
 * @returns {Promise<Store | undefined>} Nothing for a store that can't be opened.
 */
async function openStore(dir: string): Promise<Store | undefined> {
  try {
    return await load(dir);
  } catch {
    return undefined;
  }
}

function resourceText(value: unknown): string | undefined {
  const resource = record(value);
  return [text(resource.uri), text(resource.text)].filter(Boolean).join("\n") || undefined;
}

/**
 * Image bytes stay in the store. The block only says one was sent.
 * @param part - One native content part.
 * @returns {string | undefined} Its readable text, if it has any.
 */
function partText(part: Native): string | undefined {
  if (part.type === "text") return text(part.text);
  if (part.type === "resource") return resourceText(part.resource);
  if (part.type !== "image") return undefined;
  const mime = text(record(part.attachment).mimeType);
  return mime ? `[image ${mime}]` : "[image]";
}

function contentBlocks(content: unknown): Block[] {
  return records(content).flatMap((part): Block[] => {
    const body = partText(part);
    return body ? [{ type: "text", text: body }] : [];
  });
}

function nativeRole(value: unknown): Message["role"] | undefined {
  if (value === "user" || value === "assistant") return value;
  return undefined;
}

/**
 * Partial text of an abandoned completion stays readable, flagged with why Vibe dropped it.
 * @param entry - Native history entry.
 * @returns {Record<string, string> | undefined} The cause, for discarded entries only.
 */
function discarded(entry: Native): Record<string, string> | undefined {
  const outcome = record(entry.outcome);
  if (outcome.type !== "discarded") return undefined;
  return { discarded: text(outcome.cause) ?? "unknown" };
}

function messageDrafts(entry: Native): Draft[] {
  const role = nativeRole(entry.role);
  if (!role) return [];
  return [
    { role, at: entry.createdAt, blocks: contentBlocks(entry.content), context: discarded(entry) },
  ];
}

function thinkingDrafts(entry: Native): Draft[] {
  const summary = Array.isArray(entry.summary)
    ? entry.summary.flatMap((item) => text(item) ?? [])
    : [];
  const body = text(entry.text) ?? summary.join("\n");
  const blocks: Block[] = body ? [{ type: "thinking", text: body }] : [];
  return [{ role: "assistant", at: entry.createdAt, blocks, context: discarded(entry) }];
}

function serialized(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

/**
 * Built-in tools answer in `structured_content` and leave `outputText` empty.
 * @param state - Native effect state.
 * @returns {string} The error, the reason, the printed text or the structured answer.
 */
function resultText(state: Native): string {
  const said = [record(state.error).message, state.reason, state.outputText].flatMap(
    (value) => text(value) ?? [],
  );
  if (said.length > 0) return [...new Set(said)].join("\n");
  if (!isRecord(state.output)) return "";
  const output = Object.fromEntries(
    Object.entries(state.output).filter(([key]) => key !== "_meta"),
  );
  return serialized("structured_content" in output ? output.structured_content : output);
}

function resultBlocks(state: Native, toolCallId: string): Block[] {
  const status = text(state.status) ?? "";
  if (!Object.hasOwn(SETTLED, status)) return [];
  return [{ type: "tool_result", toolCallId, text: resultText(state), isError: SETTLED[status] }];
}

function effectDrafts(entry: Native): Draft[] {
  const detail = record(entry.detail);
  const toolCallId = text(entry.toolCallId) ?? text(entry.id) ?? "";
  const toolName = text(detail.toolName) ?? text(entry.title) ?? "";
  const child = text(detail.childSessionId);
  const call: Draft = {
    role: "assistant",
    at: entry.createdAt,
    blocks: [{ type: "tool_call", toolName, toolCallId, toolInput: serialized(detail.input) }],
    context: child ? { childSessionId: child } : undefined,
  };
  const result = resultBlocks(record(entry.state), toolCallId);
  return result.length > 0 ? [call, { role: "tool", at: entry.updatedAt, blocks: result }] : [call];
}

/**
 * Notices and checkpoints are app events, so only three entry types become messages.
 * @param entry - Native history entry.
 * @returns {Draft[]} Its messages, or none.
 */
function entryDrafts(entry: Native): Draft[] {
  if (entry.type === "message") return messageDrafts(entry);
  if (entry.type === "reasoning") return thinkingDrafts(entry);
  return entry.type === "effect" ? effectDrafts(entry) : [];
}

/**
 * Vibe keeps the outcome of the latest turn only, so earlier early stops leave no block.
 * @param envelope - Public session state without its history.
 * @returns {Draft[]} One stop message when that turn didn't end on its own.
 */
function stopDrafts(envelope: Native): Draft[] {
  const turn = record(envelope.latestTurn);
  const status = text(turn.status);
  const stopReason = status === "completed" ? text(turn.stopReason) : status;
  if (!stopReason || stopReason === "in_progress") return [];
  const body = text(record(turn.error).message) ?? text(turn.reason);
  const block: Block = { type: "stop", stopReason, ...(body ? { text: body } : {}) };
  return [{ role: "assistant", at: turn.completedAt, blocks: [block] }];
}

function* sessionDrafts(store: Store): Generator<Draft> {
  for (const entry of store.entries()) yield* entryDrafts(entry);
  yield* stopDrafts(store.envelope);
}

function workingDirectory(dir: string): string | undefined {
  try {
    return text(record(readRecord(join(dir, "meta.json")).environment).working_directory);
  } catch {
    return undefined;
  }
}

/**
 * Both the pointer swap and a journal append move the session forward.
 * @param dir - Session directory.
 * @returns {number} Epoch milliseconds of the newest of them.
 */
function lastWrite(dir: string): number {
  const journal = join(dir, "journal");
  const segments = existsSync(journal)
    ? readdirSync(journal).map((name) => join(journal, name))
    : [];
  const times = [join(dir, "CURRENT"), ...segments].map(
    (file) => statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0,
  );
  return Math.max(...times);
}

function sharedContext(
  cwd: string | undefined,
  parent: string | undefined,
): Record<string, string> {
  return { ...(cwd ? { cwd } : {}), ...(parent ? { parentSessionId: parent } : {}) };
}

function contextOf(
  shared: Readonly<Record<string, string>>,
  own: Readonly<Record<string, string>> | undefined,
): Pick<Message, "context"> {
  const context = { ...shared, ...own };
  return Object.keys(context).length > 0 ? { context } : {};
}

/**
 * A number `Date` can't hold would throw in `toISOString`, so it counts as no time at all.
 * @param value - Native `createdAt` or `updatedAt`.
 * @returns {number | undefined} Epoch milliseconds, when they make a date.
 */
function nativeTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(new Date(value).getTime())
    ? value
    : undefined;
}

/** Reads Mistral Vibe's unified session store, one directory per session or subagent run. */
export class VibeSource implements Source {
  readonly name = "vibe";
  private readonly storeDir: string;
  private readonly user: Participant;

  constructor(storeDir?: string) {
    this.storeDir = storeDir ?? defaultStoreDir();
    this.user = { platform: "cli", name: osUser() };
  }

  available(): boolean {
    return existsSync(this.storeDir);
  }

  /**
   * The id is matched against directory names, never joined into a path.
   * @param wanted - Exact session id, or every session when omitted.
   * @returns {SessionDir[]} Stores with a `CURRENT` pointer, oldest write first.
   */
  private sessionDirs(wanted?: string): SessionDir[] {
    if (!existsSync(this.storeDir)) return [];
    return readdirSync(this.storeDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (!wanted || entry.name === wanted))
      .map((entry) => ({ id: entry.name, path: join(this.storeDir, entry.name) }))
      .filter((dir) => existsSync(join(dir.path, "CURRENT")))
      .map((dir) => ({ ...dir, mtime: lastWrite(dir.path) }))
      .sort((left, right) => left.mtime - right.mtime);
  }

  private *messages(dir: SessionDir, store: Store): Generator<Message> {
    const parent = text(record(store.envelope.session).parentSessionId);
    const shared = sharedContext(workingDirectory(dir.path), parent);
    const author = parent ? BOT : this.user;
    for (const draft of sessionDrafts(store)) {
      if (draft.blocks.length === 0) continue;
      const native = nativeTime(draft.at);
      const timestamp = native ?? dir.mtime;
      yield {
        source: this.name,
        sessionId: dir.id,
        role: draft.role,
        timestamp,
        timestampSource: native === undefined ? "file" : "message",
        date: new Date(timestamp).toISOString().split("T")[0],
        blocks: draft.blocks,
        ...contextOf(shared, draft.context),
        channel: { platform: "cli", name: this.name },
        author: draft.role === "user" ? author : BOT,
      };
    }
  }

  private async *readSession(dir: SessionDir): AsyncGenerator<Message> {
    const store = await openStore(dir.path);
    if (store) yield* this.messages(dir, store);
  }

  /**
   * A chunk that stops parsing mid-session ends that session, never the whole read.
   * @param options - Exact session and activity filters.
   * @yields {Message} Messages of each session, oldest store write first.
   */
  async *read(options?: SourceReadOptions): AsyncGenerator<Message> {
    const dirs = activeFiles(
      this.sessionDirs(options?.sessionId || undefined),
      (dir) => dir.id,
      options?.activeSince,
    );
    for (const dir of dirs) {
      try {
        yield* this.readSession(dir);
      } catch {
        continue;
      }
    }
  }
}
