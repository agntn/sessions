import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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

interface ChatFile {
  readonly path: string;
  readonly mtime: number;
}

function thoughtBlock(value: unknown): Block[] {
  if (!isRecord(value)) return [];
  const text = [scalarText(value.subject), scalarText(value.description)]
    .filter(Boolean)
    .join(": ");
  return text ? [{ type: "thinking", text }] : [];
}

// Gemini CLI records a failed or cancelled call as `response.error` beside that status.
function nativeToolError(status: unknown): boolean | undefined {
  if (status === "success") return false;
  if (status === "error" || status === "cancelled") return true;
  return undefined;
}

function toolResultBlocks(toolCallId: string, results: unknown, status: unknown): Block[] {
  if (!Array.isArray(results)) return [];
  const isError = nativeToolError(status);
  return results.flatMap((result) => {
    if (!isRecord(result) || !isRecord(result.functionResponse)) return [];
    const response = result.functionResponse.response;
    if (!isRecord(response)) return [];
    const text = scalarText(response.output) || scalarText(response.error) || "";
    if (!text && isError === undefined) return [];
    return [
      {
        type: "tool_result" as const,
        toolCallId,
        text,
        ...(isError === undefined ? {} : { isError }),
      },
    ];
  });
}

function toolCallBlocks(value: unknown): Block[] {
  if (!isRecord(value)) return [];
  const toolCallId = scalarText(value.id) ?? "";
  return [
    {
      type: "tool_call",
      toolName: scalarText(value.name) ?? scalarText(value.displayName) ?? "",
      toolCallId,
      toolInput: typeof value.args === "string" ? value.args : (JSON.stringify(value.args) ?? ""),
    },
    ...toolResultBlocks(toolCallId, value.result, value.status),
  ];
}

function parseGeminiBlocks(entry: Readonly<Record<string, unknown>>): Block[] {
  const thoughts = Array.isArray(entry.thoughts) ? entry.thoughts.flatMap(thoughtBlock) : [];
  const content =
    typeof entry.content === "string" && entry.content.length > 0
      ? [{ type: "text" as const, text: entry.content }]
      : [];
  const tools = Array.isArray(entry.toolCalls) ? entry.toolCalls.flatMap(toolCallBlocks) : [];
  return [...thoughts, ...content, ...tools];
}

function sessionIdFromPath(path: string): string {
  return path.split("/").pop()?.replace(".json", "") || "";
}

function* walkChatFiles(dir: string, sessionId?: string): Generator<ChatFile> {
  if (!existsSync(dir)) return;
  for (const project of readdirSync(dir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const chatsDir = join(dir, project.name, "chats");
    if (!existsSync(chatsDir)) continue;
    for (const file of readdirSync(chatsDir, { withFileTypes: true })) {
      if (!file.name.endsWith(".json")) continue;
      if (sessionId && sessionIdFromPath(file.name) !== sessionId) continue;
      const path = join(chatsDir, file.name);
      yield { path, mtime: statSync(path).mtimeMs };
    }
  }
}

function userBlocks(content: unknown): Block[] {
  return typeof content === "string" && content.length > 0 ? [{ type: "text", text: content }] : [];
}

function nativeRole(type: unknown): Message["role"] | undefined {
  if (type === "user") return "user";
  if (type === "gemini") return "assistant";
  return undefined;
}

export class GeminiSource implements Source {
  name = "gemini";
  private geminiDir: string;
  private channel: Channel = { platform: "cli", name: "gemini" };
  private user: Participant;

  constructor(geminiDir?: string) {
    this.geminiDir = geminiDir ?? join(home(), ".gemini", "tmp");
    this.user = { platform: "cli", name: osUser() };
  }

  available(): boolean {
    return existsSync(this.geminiDir);
  }

  private messageFromEntry(
    entry: Readonly<Record<string, unknown>>,
    sessionId: string,
    mtime: number,
  ): Message | undefined {
    const role = nativeRole(entry.type);
    if (!role) return undefined;
    const blocks = role === "user" ? userBlocks(entry.content) : parseGeminiBlocks(entry);
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
      channel: this.channel,
      author: role === "user" ? this.user : { platform: "cli", name: "gemini", isBot: true },
    };
  }

  private *readFile(file: ChatFile): Generator<Message> {
    let data: unknown;
    try {
      data = parseJson(readFileSync(file.path, "utf-8"));
    } catch {
      return;
    }
    if (!isRecord(data) || !Array.isArray(data.messages)) return;

    const sessionId = sessionIdFromPath(file.path);
    for (const entry of data.messages) {
      if (!isRecord(entry)) continue;
      const message = this.messageFromEntry(entry, sessionId, file.mtime);
      if (message) yield message;
    }
  }

  async *read(options?: SourceReadOptions): AsyncGenerator<Message> {
    const files = [...walkChatFiles(this.geminiDir, options?.sessionId || undefined)].sort(
      (left, right) => left.mtime - right.mtime,
    );
    for (const file of files) yield* this.readFile(file);
  }
}
