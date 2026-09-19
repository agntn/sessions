import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
import { isRecord, parseJson, scalarText } from "./parsing.ts";

interface SessionFile {
  readonly path: string;
  readonly mtime: number;
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
  return [
    {
      type: "tool_result",
      toolCallId: scalarText(value.tool_use_id) ?? "",
      text: toolResultText(value.content),
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
    sessionId: string,
    mtime: number,
  ): Message | undefined {
    const role = nativeRole(entry.type);
    if (!role || !isRecord(entry.message)) return undefined;
    const blocks = parseBlocks(entry.message.content);
    if (blocks.length === 0) return undefined;

    const parsed = scalarText(entry.timestamp);
    const nativeTimestamp = parsed ? new Date(parsed).getTime() : Number.NaN;
    const timestamp = Number.isFinite(nativeTimestamp) ? nativeTimestamp : mtime;
    return {
      source: this.name,
      sessionId,
      role,
      timestamp,
      date: new Date(timestamp).toISOString().split("T")[0],
      blocks,
      channel: this.channel,
      author: role === "user" ? this.user : { platform: "cli", name: "claude-code", isBot: true },
    };
  }

  private async *readFile(file: SessionFile): AsyncGenerator<Message> {
    const sessionId = sessionIdFromPath(file.path);
    const lines = createInterface({ input: createReadStream(file.path), crlfDelay: Infinity });
    for await (const line of lines) {
      try {
        const entry = parseJson(line);
        if (!isRecord(entry)) continue;
        const message = this.messageFromEntry(entry, sessionId, file.mtime);
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
    for (const file of files) yield* this.readFile(file);
  }
}
