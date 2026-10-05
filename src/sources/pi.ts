import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { home, osUser } from "../core/env.ts";
import type { Block, Message, Participant, Source, SourceReadOptions } from "../core/types.ts";
import { activeFiles } from "./activity.ts";
import { isRecord, parseJsonRecord, scalarText } from "./parsing.ts";

interface SessionFile {
  readonly path: string;
  readonly mtime: number;
}

function textBlock(type: "text" | "thinking", value: unknown): Block[] {
  const text = scalarText(value);
  return text ? [{ type, text }] : [];
}

function toolCallBlock(value: Readonly<Record<string, unknown>>): Block[] {
  return [
    {
      type: "tool_call",
      toolName: scalarText(value.name) ?? "",
      toolCallId: scalarText(value.id) ?? "",
      toolInput:
        typeof value.arguments === "string"
          ? value.arguments
          : (JSON.stringify(value.arguments ?? "") ?? ""),
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
    case "toolCall":
      return toolCallBlock(value);
    default:
      return [];
  }
}

function parseBlocks(content: unknown): Block[] {
  return Array.isArray(content) ? content.flatMap(parseBlock) : [];
}

function toolResultBlocks(message: Readonly<Record<string, unknown>>): Block[] {
  const isError = typeof message.isError === "boolean" ? message.isError : undefined;
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .flatMap((value) => {
      if (!isRecord(value) || value.type !== "text") return [];
      const content = scalarText(value.text);
      return content ? [content] : [];
    })
    .join("\n");
  if (!text && isError === undefined) return [];
  return [
    {
      type: "tool_result",
      toolCallId: scalarText(message.toolCallId) ?? "",
      text,
      ...(isError === undefined ? {} : { isError }),
    },
  ];
}

/** Turns that ended the way the model meant to, so they need no stop block. */
const PLANNED_STOPS = new Set(["stop", "toolUse"]);

function stopBlocks(message: Readonly<Record<string, unknown>>): Block[] {
  const stopReason = scalarText(message.stopReason);
  const text = scalarText(message.errorMessage);
  if (!text && (!stopReason || PLANNED_STOPS.has(stopReason))) return [];
  return [{ type: "stop", ...(stopReason ? { stopReason } : {}), ...(text ? { text } : {}) }];
}

function messageBlocks(role: Message["role"], message: Readonly<Record<string, unknown>>): Block[] {
  if (role === "tool") return toolResultBlocks(message);
  const blocks = parseBlocks(message.content);
  return role === "assistant" ? [...blocks, ...stopBlocks(message)] : blocks;
}

function nativeRole(value: unknown): Message["role"] | undefined {
  if (value === "assistant") return "assistant";
  if (value === "user") return "user";
  if (value === "toolResult") return "tool";
  return undefined;
}

function sessionIdFromPath(path: string): string {
  return path.split("/").pop()?.split("_").pop()?.replace(".jsonl", "") || "";
}

/** Chunk size for a filtered read, so a foreign file costs one small read before it is dropped. */
const PEEK_BYTES = 4096;

function foreignSession(sessionId: string, wanted: string | undefined): boolean {
  return wanted !== undefined && sessionId !== wanted;
}

function stemHolds(stem: string, wanted: string): boolean {
  return stem.length > 0 && (stem === wanted || wanted.startsWith(`${stem}-`));
}

/**
 * A project filename carries the id or the shortened prefix OMP writes. Nested runs stay open for the header.
 * The walk stores `join(root, name)`, so the root is compared as `join(root, ".")`.
 * @param root - Sessions directory.
 * @param path - Transcript path.
 * @param wanted - Exact session id, or every transcript when omitted.
 * @returns {boolean} Whether this read should open the file.
 */
function selectedTranscript(root: string, path: string, wanted: string | undefined): boolean {
  if (!wanted || stemHolds(sessionIdFromPath(path), wanted)) return true;
  return dirname(dirname(path)) !== join(root, ".");
}

function settledSessionId(
  entry: Readonly<Record<string, unknown>>,
  current: string,
): string | undefined {
  if (entry.type === "session") return scalarText(entry.id) || current;
  return entry.type === "message" ? current : undefined;
}

/**
 * Settles a transcript's session the way `readFile` does, reading only up to its first entry.
 * @param path - Transcript path.
 * @returns {string} The id its messages carry.
 */
function transcriptSession(path: string): string {
  const stem = sessionIdFromPath(path);
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(PEEK_BYTES);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    for (let read = readSync(fd, chunk); read > 0; read = readSync(fd, chunk)) {
      const lines = (pending + decoder.write(chunk.subarray(0, read))).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const entry = parseJsonRecord(line);
        const settled = entry && settledSessionId(entry, stem);
        if (settled !== undefined) return settled;
      }
    }
    const entry = parseJsonRecord(pending + decoder.end());
    return (entry && settledSessionId(entry, stem)) ?? stem;
  } finally {
    closeSync(fd);
  }
}

function* walkJsonl(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJsonl(full);
    else if (entry.name.endsWith(".jsonl")) yield full;
  }
}

type PiFamilySourceName = "pi" | "omp";

/** Reads native Pi session JSONL, including the compatible format used by OMP. */
export class PiSource implements Source {
  readonly name: PiFamilySourceName = "pi";
  private readonly sessionsDir: string;
  private readonly user: Participant;

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir ?? join(home(), ".pi/agent/sessions");
    this.user = { platform: "cli", name: osUser() };
  }

  available(): boolean {
    return existsSync(this.sessionsDir);
  }

  private messageFromEntry(
    entry: Readonly<Record<string, unknown>>,
    sessionId: string,
    mtime: number,
  ): Message | undefined {
    if (!isRecord(entry.message)) return undefined;
    const role = nativeRole(entry.message.role);
    if (!role) return undefined;
    const blocks = messageBlocks(role, entry.message);
    if (blocks.length === 0) return undefined;

    const timestampText = scalarText(entry.timestamp);
    const nativeTimestamp = timestampText ? new Date(timestampText).getTime() : Number.NaN;
    const timestamp = Number.isFinite(nativeTimestamp) ? nativeTimestamp : mtime;
    return {
      source: this.name,
      sessionId,
      role,
      timestamp,
      timestampSource: Number.isFinite(nativeTimestamp) ? "message" : "file",
      date: new Date(timestamp).toISOString().split("T")[0],
      blocks,
      channel: { platform: "cli", name: this.name },
      author: role === "user" ? this.user : { platform: "cli", name: this.name, isBot: true },
    };
  }

  private async *readFile(file: SessionFile, wanted?: string): AsyncGenerator<Message> {
    /**
     * The id lives in the `session` entry. It matches the file name of a
     * top-level session, while a subagent run sits under its parent's directory
     * with a name of its own, so an exact filter is settled from the header and
     * a foreign file is dropped there. A leading `title` entry can precede the
     * header, so the file stem remains the fallback for headerless or truncated
     * transcripts.
     */
    let sessionId = sessionIdFromPath(file.path);
    const input = createReadStream(
      file.path,
      wanted === undefined ? {} : { highWaterMark: PEEK_BYTES },
    );
    try {
      for await (const line of createInterface({ input, crlfDelay: Infinity })) {
        const entry = parseJsonRecord(line);
        if (!entry) continue;
        const settled = settledSessionId(entry, sessionId);
        if (settled === undefined) continue;
        sessionId = settled;
        if (foreignSession(sessionId, wanted)) return;
        if (entry.type === "session") continue;
        const message = this.messageFromEntry(entry, sessionId, file.mtime);
        if (message) yield message;
      }
    } finally {
      input.destroy();
    }
  }

  private sessionFiles(wanted?: string): SessionFile[] {
    const files: SessionFile[] = [];
    for (const path of walkJsonl(this.sessionsDir)) {
      if (!selectedTranscript(this.sessionsDir, path, wanted)) continue;
      files.push({ path, mtime: statSync(path).mtimeMs });
    }
    files.sort((left, right) => left.mtime - right.mtime);
    return files;
  }

  async *read(options?: SourceReadOptions): AsyncGenerator<Message> {
    const wanted = options?.sessionId || undefined;
    const files = activeFiles(
      this.sessionFiles(wanted),
      (file) => transcriptSession(file.path),
      options?.activeSince,
    );
    for (const file of files) yield* this.readFile(file, wanted);
  }
}
