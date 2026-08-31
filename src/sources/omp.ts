import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { home, osUser } from "../core/env.ts";
import type { Block, Channel, Message, Participant, Source } from "../core/types.ts";
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
  if (!Array.isArray(message.content)) return [];
  const text = message.content
    .flatMap((value) => {
      if (!isRecord(value) || value.type !== "text") return [];
      const content = scalarText(value.text);
      return content ? [content] : [];
    })
    .join("\n");
  if (!text) return [];
  return [
    {
      type: "tool_result",
      toolCallId: scalarText(message.toolCallId) ?? "",
      text,
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

function* walkJsonl(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJsonl(full);
    else if (entry.name.endsWith(".jsonl")) yield full;
  }
}

export class OmpSource implements Source {
  name = "omp";
  private sessionsDir: string;
  private channel: Channel = { platform: "cli", name: "omp" };
  private user: Participant;

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir ?? join(home(), ".omp/agent/sessions");
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
      channel: this.channel,
      author: role === "user" ? this.user : { platform: "cli", name: "omp", isBot: true },
    };
  }

  private async *readFile(file: SessionFile): AsyncGenerator<Message> {
    // The id lives in the `session` entry and matches the file name; a leading
    // `title` entry can precede it, so the file stem stays the fallback for
    // headerless or truncated transcripts.
    let sessionId = sessionIdFromPath(file.path);
    const lines = createInterface({ input: createReadStream(file.path), crlfDelay: Infinity });
    for await (const line of lines) {
      const entry = parseJsonRecord(line);
      if (!entry) continue;
      if (entry.type === "session") {
        sessionId = scalarText(entry.id) || sessionId;
        continue;
      }
      if (entry.type !== "message") continue;
      const message = this.messageFromEntry(entry, sessionId, file.mtime);
      if (message) yield message;
    }
  }

  async *read(): AsyncGenerator<Message> {
    const files: SessionFile[] = [];
    for (const path of walkJsonl(this.sessionsDir)) {
      files.push({ path, mtime: statSync(path).mtimeMs });
    }
    files.sort((left, right) => left.mtime - right.mtime);
    for (const file of files) yield* this.readFile(file);
  }
}
