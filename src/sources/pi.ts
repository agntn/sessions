import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { home, osUser } from "../core/env.ts";
import type { Block, Message, Participant, Source, SourceReadOptions } from "../core/types.ts";
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

function settledSessionId(
  entry: Readonly<Record<string, unknown>>,
  current: string,
): string | undefined {
  if (entry.type === "session") return scalarText(entry.id) || current;
  return entry.type === "message" ? current : undefined;
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
    const blocks =
      role === "tool" ? toolResultBlocks(entry.message) : parseBlocks(entry.message.content);
    if (blocks.length === 0) return undefined;

    const timestampText = scalarText(entry.timestamp);
    const nativeTimestamp = timestampText ? new Date(timestampText).getTime() : Number.NaN;
    const timestamp = Number.isFinite(nativeTimestamp) ? nativeTimestamp : mtime;
    return {
      source: this.name,
      sessionId,
      role,
      timestamp,
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

  async *read(options?: SourceReadOptions): AsyncGenerator<Message> {
    const wanted = options?.sessionId || undefined;
    const files: SessionFile[] = [];
    for (const path of walkJsonl(this.sessionsDir)) {
      files.push({ path, mtime: statSync(path).mtimeMs });
    }
    files.sort((left, right) => left.mtime - right.mtime);
    for (const file of files) yield* this.readFile(file, wanted);
  }
}
