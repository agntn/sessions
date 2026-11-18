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

/** The public history of one session, rebuilt the way Vibe restores it. */
class History {
  private kept: Native[];
  private state: Native;

  constructor(snapshot: Native, pooled: readonly Native[]) {
    this.state = snapshot;
    this.kept = [...records(record(snapshot.history).entries), ...pooled];
  }

  get entries(): readonly Native[] {
    return this.kept;
  }

  get envelope(): Native {
    return this.state;
  }

  private swap(op: Native): void {
    const index = this.kept.findIndex((entry) => entry.id === op.id);
    if (index !== -1 && isRecord(op.entry)) this.kept[index] = op.entry;
  }

  private apply(op: Native): void {
    switch (op.op) {
      case "append_entry":
        if (isRecord(op.entry)) this.kept.push(op.entry);
        break;
      case "replace_entry":
        this.swap(op);
        break;
      case "remove_entry":
        this.kept = this.kept.filter((entry) => entry.id !== op.id);
        break;
      case "set_history_entries":
        this.kept = records(op.entries);
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
  replay(entry: Native): void {
    const payload = record(entry.payload);
    if (entry.type === "projection_advanced") {
      this.state = record(payload.snapshot);
      this.kept = records(record(this.state.history).entries);
    } else if (entry.type === "projection_delta" || entry.type === "session_relocated") {
      for (const op of records(payload.delta)) this.apply(op);
    }
  }
}

function pooledEntries(dir: string, chunks: unknown): Native[] {
  if (!Array.isArray(chunks)) return [];
  return chunks.flatMap((digest: unknown) => {
    const path = join(dir, "chunks", `${named(digest, "chunk")}.json`);
    return records(parseJson(readFileSync(path, "utf8")));
  });
}

/**
 * Follows `CURRENT` to its generation, then replays the journal written since.
 * @param dir - Session directory.
 * @returns {Promise<History>} The history as of the last complete journal record.
 */
async function load(dir: string): Promise<History> {
  const current = readRecord(join(dir, "CURRENT"));
  const generation = join(dir, "generations", named(current.generation, "generation"));
  const manifest = readRecord(join(generation, "manifest.json"));
  const stored = record(manifest.projection_state);
  const state = readRecord(join(generation, named(stored.path, "document")));
  const history = new History(record(state.snapshot), pooledEntries(dir, stored.chunks));
  const segment = named(record(manifest.recovery_journal_segment).path, "segment");
  for await (const line of jsonlLines(join(dir, segment))) {
    const entry = parseJsonRecord(line);
    if (entry) history.replay(entry);
  }
  return history;
}

/**
 * One store that can't be followed is skipped, so it doesn't hide the sessions next to it.
 * @param dir - Session directory.
 * @returns {Promise<History | undefined>} Nothing for a store that can't be read.
 */
async function readableHistory(dir: string): Promise<History | undefined> {
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

  private async *readSession(dir: SessionDir): AsyncGenerator<Message> {
    const history = await readableHistory(dir.path);
    if (!history) return;
    const parent = text(record(history.envelope.session).parentSessionId);
    const shared = sharedContext(workingDirectory(dir.path), parent);
    const author = parent ? BOT : this.user;
    const drafts = [...history.entries.flatMap(entryDrafts), ...stopDrafts(history.envelope)];
    for (const draft of drafts) {
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

  async *read(options?: SourceReadOptions): AsyncGenerator<Message> {
    const dirs = activeFiles(
      this.sessionDirs(options?.sessionId || undefined),
      (dir) => dir.id,
      options?.activeSince,
    );
    for (const dir of dirs) yield* this.readSession(dir);
  }
}
