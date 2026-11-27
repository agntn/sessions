import { existsSync, readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { directoryPrefix, inDirectory } from "../core/cwd.ts";
import { home, osUser } from "../core/env.ts";
import type {
  Block,
  Channel,
  Message,
  Participant,
  Source,
  SourceReadOptions,
} from "../core/types.ts";
import { activeFiles } from "./activity.ts";
import {
  isRecord,
  jsonlLines,
  modelOf,
  parseJson,
  parseJsonRecord,
  scalarText,
} from "./parsing.ts";

interface SessionFile {
  readonly path: string;
  readonly mtime: number;
}

/** What a message takes from its transcript. `cwd` sits on each entry. */
interface Transcript {
  readonly sessionId: string;
  readonly mtime: number;
  readonly cwd?: string;
}

function textBlock(type: "text" | "thinking", value: unknown): Block[] {
  const text = scalarText(value);
  return text ? [{ type, text }] : [];
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      if (!isRecord(item) || item.type !== "text") return [];
      const text = scalarText(item.text);
      return text ? [text] : [];
    })
    .join("\n");
}

function toolCallBlock(value: Readonly<Record<string, unknown>>): Block[] {
  return [
    {
      type: "tool_call",
      toolName: scalarText(value.name) ?? "",
      toolCallId: scalarText(value.id) ?? "",
      toolInput:
        typeof value.input === "string" ? value.input : (JSON.stringify(value.input) ?? ""),
    },
  ];
}

function toolResultBlock(value: Readonly<Record<string, unknown>>): Block[] {
  const isError = typeof value.is_error === "boolean" ? value.is_error : undefined;
  return [
    {
      type: "tool_result",
      toolCallId: scalarText(value.tool_use_id) ?? "",
      text: toolResultText(value.content),
      ...(isError === undefined ? {} : { isError }),
    },
  ];
}

function parseBlock(value: unknown): Block[] {
  if (!isRecord(value)) return [];
  switch (value.type) {
    case "text":
      return textBlock("text", value.text);
    case "thinking":
      return textBlock("thinking", value.thinking);
    case "tool_use":
      return toolCallBlock(value);
    case "tool_result":
      return toolResultBlock(value);
    default:
      return [];
  }
}

function parseBlocks(content: unknown): Block[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  return Array.isArray(content) ? content.flatMap(parseBlock) : [];
}

function sessionIdFromPath(path: string): string {
  return path.split("/").pop()?.replace(".jsonl", "") || "";
}

/** Read size for the `cwd` scan. */
const SCAN_BYTES = 1 << 20;
const CWD_KEY = Buffer.from('"cwd":"');
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
/** No real path is this long. */
const LITERAL_BYTES = 1 << 16;

/** Every `"cwd":"…"` in a transcript. Message text escapes its quotes, so it can't match. */
class DirectoryScan {
  /** The read chunk `drain()` works through next. */
  chunk: Buffer = Buffer.alloc(0);
  readonly found = new Set<string>();
  /** A literal outgrew {@link LITERAL_BYTES}, so nothing is ruled out. */
  lost = false;
  private bytes: Buffer = Buffer.alloc(0);

  /** Scans `chunk`, carrying a cut literal into the next one. */
  drain(): void {
    this.bytes = Buffer.concat([this.bytes, this.chunk]);
    let from = 0;
    for (
      let key = this.bytes.indexOf(CWD_KEY);
      key !== -1;
      key = this.bytes.indexOf(CWD_KEY, from)
    ) {
      const open = key + CWD_KEY.length - 1;
      const close = this.closingQuote(open);
      if (close === -1) {
        this.lost ||= this.bytes.length - key > LITERAL_BYTES;
        this.bytes = this.lost ? Buffer.alloc(0) : this.bytes.subarray(key);
        return;
      }
      this.add(this.bytes.toString("utf8", open, close + 1));
      from = close + 1;
    }
    this.bytes = this.bytes.subarray(Math.max(from, this.bytes.length - CWD_KEY.length + 1));
  }

  /**
   * Where the string literal opened at `open` closes.
   * @param open - Offset of its opening quote.
   * @returns {number} Its closing quote, or -1 past the chunk.
   */
  private closingQuote(open: number): number {
    let index = open + 1;
    while (index < this.bytes.length && this.bytes[index] !== QUOTE) {
      index += this.bytes[index] === BACKSLASH ? 2 : 1;
    }
    return index < this.bytes.length ? index : -1;
  }

  private add(literal: string): void {
    const cwd = parseJsonRecord(`{"cwd":${literal}}`)?.cwd;
    if (typeof cwd === "string" && cwd) this.found.add(cwd);
  }
}

/**
 * Every directory a transcript names, without parsing it.
 * @param path - Transcript path.
 * @param prefix - Result of {@link directoryPrefix}; a match stops early.
 * @returns {Promise<Set<string> | undefined>} The directories, or nothing when it can't tell.
 */
async function transcriptDirectories(
  path: string,
  prefix: string,
): Promise<Set<string> | undefined> {
  const scan = new DirectoryScan();
  try {
    const handle = await open(path);
    try {
      const chunk = Buffer.alloc(SCAN_BYTES);
      for (
        let read = await handle.read(chunk);
        read.bytesRead > 0;
        read = await handle.read(chunk)
      ) {
        scan.chunk = chunk.subarray(0, read.bytesRead);
        scan.drain();
        if (scan.lost || [...scan.found].some((cwd) => inDirectory(cwd, prefix))) break;
      }
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
  return scan.lost ? undefined : scan.found;
}

/**
 * Keeps whole sessions that may have run under `cwd`. No directory rules nothing out.
 * @param files - Transcripts in read order.
 * @param cwd - Absolute directory filter.
 * @returns {Promise<SessionFile[]>} The transcripts to read, in read order.
 */
async function filesInDirectory(
  files: readonly SessionFile[],
  cwd: string,
): Promise<SessionFile[]> {
  const prefix = directoryPrefix(cwd);
  const kept = new Set<string>();
  for (const file of files) {
    const found = await transcriptDirectories(file.path, prefix);
    const near = !found?.size || [...found].some((directory) => inDirectory(directory, prefix));
    if (near) kept.add(sessionIdFromPath(file.path));
  }
  return files.filter((file) => kept.has(sessionIdFromPath(file.path)));
}

function* walkJsonl(dir: string, sessionId?: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsonl(full, sessionId);
    } else if (entry.name.endsWith(".jsonl")) {
      if (!sessionId || sessionIdFromPath(entry.name) === sessionId) yield full;
    }
  }
}

/**
 * A reply's model, minus the `<synthetic>` Claude Code stamps on records no model wrote.
 *
 * @param role - Normalized role of the message.
 * @param model - Native `message.model`.
 * @returns {Pick<Message, "model">} `model`, or nothing.
 */
function replyModel(role: Message["role"], model: unknown): Pick<Message, "model"> {
  return model === "<synthetic>" ? {} : modelOf(role, { id: model });
}

function nativeRole(type: unknown): Message["role"] | undefined {
  if (type === "assistant") return "assistant";
  if (type === "user" || type === "human") return "user";
  return undefined;
}

export class ClaudeSource implements Source {
  name = "claude";
  private projectsDir: string;
  private channel: Channel = { platform: "cli", name: "claude-code" };
  private user: Participant;

  constructor(projectsDir?: string) {
    this.projectsDir = projectsDir ?? join(home(), ".claude/projects");
    this.user = { platform: "cli", name: osUser() };
  }

  available(): boolean {
    return existsSync(this.projectsDir);
  }

  private messageFromEntry(
    entry: Readonly<Record<string, unknown>>,
    transcript: Readonly<Transcript>,
  ): Message | undefined {
    const role = nativeRole(entry.type);
    if (!role || !isRecord(entry.message)) return undefined;
    const blocks = parseBlocks(entry.message.content);
    if (blocks.length === 0) return undefined;

    const parsed = scalarText(entry.timestamp);
    const nativeTimestamp = parsed ? new Date(parsed).getTime() : Number.NaN;
    const timestamp = Number.isFinite(nativeTimestamp) ? nativeTimestamp : transcript.mtime;
    return {
      source: this.name,
      sessionId: transcript.sessionId,
      role,
      timestamp,
      timestampSource: Number.isFinite(nativeTimestamp) ? "message" : "file",
      date: new Date(timestamp).toISOString().split("T")[0],
      blocks,
      channel: this.channel,
      author: role === "user" ? this.user : { platform: "cli", name: "claude-code", isBot: true },
      ...replyModel(role, entry.message.model),
      ...(transcript.cwd ? { context: { cwd: transcript.cwd } } : {}),
    };
  }

  private async *readFile(file: SessionFile): AsyncGenerator<Message> {
    const sessionId = sessionIdFromPath(file.path);
    const lines = jsonlLines(file.path);
    let cwd: string | undefined;
    for await (const line of lines) {
      try {
        const entry = parseJson(line);
        if (!isRecord(entry)) continue;
        cwd = scalarText(entry.cwd) || cwd;
        const message = this.messageFromEntry(entry, { sessionId, mtime: file.mtime, cwd });
        if (message) yield message;
      } catch {
        continue;
      }
    }
  }

  async *read(options?: SourceReadOptions): AsyncGenerator<Message> {
    const files: SessionFile[] = [];
    for (const path of walkJsonl(this.projectsDir, options?.sessionId || undefined)) {
      files.push({ path, mtime: statSync(path).mtimeMs });
    }
    files.sort((left, right) => left.mtime - right.mtime);
    const active = activeFiles(files, (file) => sessionIdFromPath(file.path), options?.activeSince);
    const chosen = options?.cwd ? await filesInDirectory(active, options.cwd) : active;
    for (const file of chosen) yield* this.readFile(file);
  }
}
